import { spawn, ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export function getSystemPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** One queued command; `marker` is the stdout sentinel that closes it. */
interface QueueItem {
  command: string
  marker: string
  resolve: (output?: string) => void
  reject: (err: Error) => void
}

class PersistentPowerShell {
  private proc: ChildProcess | null = null
  private queue: QueueItem[] = []
  private running = false
  private outputBuffer = ''
  private powershellPath: string

  constructor() {
    this.powershellPath = getSystemPowerShellPath()
    if (process.platform === 'win32') {
      this.init()
    }
  }

  private init() {
    try {
      this.proc = spawn(this.powershellPath, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      })

      this.proc.stdout?.on('data', (data) => {
        this.outputBuffer += data.toString()
        // Commands run strictly serialized, so the buffer only ever holds the
        // active command's output; its own marker ends it.
        const active = this.queue[0]
        if (active && this.outputBuffer.includes(active.marker)) {
          const idx = this.outputBuffer.indexOf(active.marker)
          const output = this.outputBuffer.slice(0, idx)
          this.outputBuffer = ''
          this.onCommandFinished(null, output)
        }
      })

      this.proc.on('close', () => {
        this.proc = null
        this.running = false
        // Re-init after a short delay if closed unexpectedly
        setTimeout(() => {
          if (process.platform === 'win32') {
            this.init()
          }
        }, 1000)
      })

      this.proc.on('error', (err) => {
        console.error('[PersistentPowerShell] error:', err)
        this.running = false
      })
      // Resume whatever queued while the old process was down (a timeout kill
      // leaves the queue behind; without this every queued command would hang
      // until its own timeout — the PS channel would stay dead for good).
      this.processQueue()
    } catch (err) {
      console.error('[PersistentPowerShell] spawn failed:', err)
    }
  }

  private onCommandFinished(err: Error | null, output?: string) {
    const active = this.queue.shift()
    if (active) {
      if (err) active.reject(err)
      else active.resolve(output)
    }
    this.running = false
    this.processQueue()
  }

  public run(script: string, timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ command: script, marker: '__CLIPBOARD_DONE__', resolve: () => resolve(), reject })
      this.processQueue()

      // Fallback timeout to prevent hanging the app if powershell hangs
      setTimeout(() => {
        const idx = this.queue.findIndex(q => q.command === script)
        if (idx !== -1) {
          const removed = this.queue.splice(idx, 1)[0]
          removed.reject(new Error('TIMEOUT'))
          this.running = false
          // Restart powershell process if it timed out to ensure it's not in a bad state
          if (this.proc) {
            this.proc.kill()
            this.proc = null
          }
          this.processQueue()
        }
      }, timeoutMs)
    })
  }

  /**
   * Run a script and capture its stdout text (trimmed trailing newline).
   * Same queue/timeout discipline as run(); the completion marker is unique
   * per call so output can never collide with a queued sibling.
   */
  public runOutput(script: string, timeoutMs = 10000): Promise<string> {
    const marker = `__TRACE_OUT_${randomBytes(4).toString('hex')}__`
    return new Promise((resolve, reject) => {
      this.queue.push({ command: script, marker, resolve: (out) => resolve((out ?? '').trim()), reject })
      this.processQueue()

      setTimeout(() => {
        const idx = this.queue.findIndex(q => q.marker === marker)
        if (idx !== -1) {
          const removed = this.queue.splice(idx, 1)[0]
          removed.reject(new Error('TIMEOUT'))
          this.running = false
          if (this.proc) {
            this.proc.kill()
            this.proc = null
          }
          this.processQueue()
        }
      }, timeoutMs)
    })
  }

  private processQueue() {
    if (this.running || !this.proc || this.queue.length === 0) return
    this.running = true
    const active = this.queue[0]

    try {
      const fullCmd = `${active.command}; Write-Host "${active.marker}"\n`
      this.proc.stdin?.write(fullCmd, 'utf8')
    } catch (err) {
      this.onCommandFinished(err as Error)
    }
  }

  public dispose() {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}

export const psHost = new PersistentPowerShell()
