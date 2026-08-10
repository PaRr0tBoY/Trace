/**
 * L0 foreground/window capture (ticket 12).
 *
 * Polls GetForegroundWindow every 500ms and emits an app-switch event into the
 * event bus whenever the foreground window changes (pid or title). Same window
 * → no event. Privacy: only app name / window title / pid are recorded — no
 * content. Window titles may contain sensitive file names; the L0 settings
 * switch is the guard rail (off = nothing leaves the machine).
 *
 * No SetWinEventHook: millisecond-level latency is irrelevant against the
 * 15-minute task-state threshold, and a 500ms poll is one cheap Win32 call.
 * Capture pauses while incognito or when the task-capture / L0 settings are
 * off; while paused nothing is polled and the last window is forgotten, so
 * resuming never fabricates a retroactive switch event.
 *
 * Pure module apart from the koffi glue: no Electron imports. The pure
 * decision function (`decideAppSwitch`) and the watcher (injectable poll /
 * gate / sink) are unit-testable in vitest.
 */
import koffi from 'koffi'
import type { AppSwitchEvent } from '../../shared/types'
import { emit } from './eventBus'

/** Snapshot of the foreground window at one poll. */
export interface ForegroundSnapshot {
  pid: number
  appName: string
  exePath: string
  windowTitle: string
}

// ---- koffi Win32 glue (loaded once; capture degrades to a no-op on failure) --

type GetForegroundWindowFn = () => unknown
type GetWindowThreadProcessIdFn = (hwnd: unknown, pid: number[]) => number
type GetWindowTextWFn = (hwnd: unknown, buf: string[], maxCount: number) => number
type OpenProcessFn = (access: number, inherit: number, pid: number) => unknown
type QueryFullProcessImageNameWFn = (handle: unknown, flags: number, buf: string[], size: number[]) => number
type CloseHandleFn = (handle: unknown) => number

let getForegroundWindow: GetForegroundWindowFn | null = null
let getWindowThreadProcessId: GetWindowThreadProcessIdFn | null = null
let getWindowTextW: GetWindowTextWFn | null = null
let openProcess: OpenProcessFn | null = null
let queryFullProcessImageNameW: QueryFullProcessImageNameWFn | null = null
let closeHandle: CloseHandleFn | null = null

if (process.platform === 'win32') {
  try {
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    getForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
    getWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)')
    getWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ char16_t *lpString, int nMaxCount)')
    openProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)')
    queryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ char16_t *lpExeName, _Inout_ uint32_t *lpdwSize)')
    closeHandle = kernel32.func('int __stdcall CloseHandle(void *hObject)')
  } catch (err) {
    console.error('[Events] koffi Win32 load failed — foreground capture disabled:', err)
  }
}

const TITLE_BUF_CHARS = 512
const PATH_BUF_CHARS = 1024
/** PROCESS_QUERY_LIMITED_INFORMATION — enough to read the image path, needs no extra privileges. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** Poll the OS for the current foreground window. Null when none is visible (locked/secure desktop). */
export function queryForegroundSnapshot(): ForegroundSnapshot | null {
  if (!getForegroundWindow || !getWindowThreadProcessId || !getWindowTextW) return null
  let hwnd: unknown
  try {
    hwnd = getForegroundWindow()
  } catch {
    return null
  }
  if (!hwnd) return null

  const pidOut = [0]
  getWindowThreadProcessId(hwnd, pidOut)
  const pid = pidOut[0]

  const titleBuf = ['\0'.repeat(TITLE_BUF_CHARS)]
  getWindowTextW(hwnd, titleBuf, TITLE_BUF_CHARS)
  const windowTitle = trimNul(titleBuf[0])

  const exePath = queryExePath(pid)
  return { pid, appName: appNameFromExePath(exePath), exePath, windowTitle }
}

function queryExePath(pid: number): string {
  if (!openProcess || !queryFullProcessImageNameW || !closeHandle || pid <= 0) return ''
  const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!handle) return ''
  try {
    const pathBuf = ['\0'.repeat(PATH_BUF_CHARS)]
    const sizeOut = [PATH_BUF_CHARS]
    if (queryFullProcessImageNameW(handle, 0, pathBuf, sizeOut)) return trimNul(pathBuf[0])
    return ''
  } finally {
    closeHandle(handle)
  }
}

function appNameFromExePath(exePath: string): string {
  const base = exePath.split(/[\\/]/).pop() ?? ''
  const name = base.replace(/\.exe$/i, '')
  return name || 'unknown'
}

function trimNul(value: string | undefined): string {
  return (value ?? '').replace(/\0+$/g, '')
}

/**
 * Pure switch decision: emit an app-switch event only when the foreground
 * actually changed (pid or window title). No previous window → no event
 * (the watcher seeds its first poll silently instead).
 */
export function decideAppSwitch(prev: ForegroundSnapshot | null, next: ForegroundSnapshot | null): AppSwitchEvent | null {
  if (prev === null || next === null) return null
  if (prev.pid === next.pid && prev.windowTitle === next.windowTitle) return null
  return {
    type: 'app-switch',
    appName: next.appName,
    exePath: next.exePath,
    pid: next.pid,
    windowTitle: next.windowTitle,
    ts: Date.now()
  }
}

export interface ForegroundWatcherOptions {
  /** Foreground poller; defaults to the koffi Win32 query. */
  poll?: () => ForegroundSnapshot | null
  /** Poll interval in ms (spec: 500). */
  intervalMs?: number
  /** Capture gate evaluated every tick (task-capture / L0 settings). Default: always on. */
  isEnabled?: () => boolean
  /** Event sink; defaults to the event bus. */
  onEvent?: (event: AppSwitchEvent) => void
}

export const FOREGROUND_POLL_INTERVAL_MS = 500

/** Polls the foreground window on an interval and emits app-switch events on change. */
export class ForegroundWatcher {
  private readonly pollSnapshot: () => ForegroundSnapshot | null
  private readonly intervalMs: number
  private readonly isCaptureEnabled: () => boolean
  private readonly handleEvent: (event: AppSwitchEvent) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private paused = false
  private lastSnapshot: ForegroundSnapshot | null = null

  constructor(options: ForegroundWatcherOptions = {}) {
    this.pollSnapshot = options.poll ?? queryForegroundSnapshot
    this.intervalMs = options.intervalMs ?? FOREGROUND_POLL_INTERVAL_MS
    this.isCaptureEnabled = options.isEnabled ?? (() => true)
    this.handleEvent = options.onEvent ?? emit
  }

  start(): void {
    if (this.timer !== null) return
    this.tick() // seed immediately — no event for the window already in front
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    console.log(`[Events] foreground watcher started (${this.intervalMs}ms)`)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.lastSnapshot = null
  }

  /** Pause capture (incognito). While paused nothing is polled and context is forgotten. */
  setPaused(paused: boolean): void {
    this.paused = paused
    if (paused) this.lastSnapshot = null
  }

  /** Most recent foreground snapshot; clipboard attribution (t14) reads this. */
  getLatestForeground(): ForegroundSnapshot | null {
    return this.lastSnapshot
  }

  private tick(): void {
    if (this.paused || !this.isCaptureEnabled()) {
      this.lastSnapshot = null
      return
    }
    let snapshot: ForegroundSnapshot | null
    try {
      snapshot = this.pollSnapshot()
    } catch (err) {
      console.error('[Events] foreground poll failed:', err)
      return
    }
    if (snapshot === null) return // locked / secure desktop — keep last known window
    if (this.lastSnapshot === null) {
      this.lastSnapshot = snapshot // first observation seeds context silently
      return
    }
    const event = decideAppSwitch(this.lastSnapshot, snapshot)
    this.lastSnapshot = snapshot
    if (event !== null) this.handleEvent(event)
  }
}
