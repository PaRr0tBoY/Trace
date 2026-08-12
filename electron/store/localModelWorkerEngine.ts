/**
 * Worker-thread engine glue (t53) — implements the `LocalModelEngine`
 * interface by spawning localModelWorker.ts on a node:worker_threads worker.
 *
 * The actual llama.cpp inference runs off the main process; the runtime only
 * sees the promise-based LocalModelEngine surface. Tests never import this
 * file — they inject a fake engine into the runtime instead.
 *
 * Recovery contract:
 * - Load/infer are serialized on one worker (single model context).
 * - When the runtime's timeout fires, the abort signal is forwarded; if the
 *   worker does not answer within a short grace period (native inference can
 *   ignore AbortSignal), the worker is terminated and respawned lazily on
 *   the next call — a wedged worker never wedges the queue for good.
 * - A worker crash (error event or exit) rejects all in-flight requests and
 *   marks the worker dead; the next call respawns it lazily.
 */
/// <reference types="electron-vite/node" />
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { LocalModelError } from './localModelManager'
import type { LocalModelEngine, LocalModelEngineInferRequest } from './localModelRuntime'
// electron-vite marker: the build emits the worker as a separate chunk and
// this default export is its runtime path (`?modulePath` is build-only, and
// electron-vite dev also builds the main process, so this works in dev too).
import workerModulePath from './localModelWorker.ts?modulePath'

/**
 * Promise.withResolvers is available at runtime since Node 20.17 / Electron 34
 * (Node 20.19) but is not declared by lib.es2022 or @types/node 20 — augment
 * it locally instead of touching the shared tsconfig lib.
 */
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void }
  }
}

export interface WorkerModelEngineOptions {
  /** Worker script path override (for tests/diagnostics); defaults to the bundled chunk. */
  workerPath?: string | URL
  /** How long a load may take before the worker is recycled (default 60s). */
  loadTimeoutMs?: number
  /** Grace period after abort before the worker is terminated (default 2s). */
  abortGraceMs?: number
}

interface PendingEntry {
  resolve(v: unknown): void
  reject(e: unknown): void
  /** Called exactly once when the request settles (clears the abort grace timer). */
  onSettle?: () => void
}

interface WorkerMessage {
  type: 'load-result' | 'infer-result'
  ok?: boolean
  error?: string
  id?: number
  text?: string
}

export function createWorkerModelEngine(options: WorkerModelEngineOptions = {}): LocalModelEngine {
  const loadTimeoutMs = options.loadTimeoutMs ?? 60_000
  const abortGraceMs = options.abortGraceMs ?? 2_000
  const workerPath = options.workerPath ?? workerModulePath

  let worker: Worker | null = null
  let loaded = false
  let nextId = 1
  const pending = new Map<number, PendingEntry>()
  /** Path/context of the loaded model, kept for lazy respawn after a crash. */
  let loadState: { modelPath: string; contextSize: number } | null = null

  function failAllPending(error: unknown): void {
    for (const [, entry] of pending) {
      entry.onSettle?.()
      entry.reject(error)
    }
    pending.clear()
  }

  function recycle(): void {
    if (worker) {
      // Everything still in flight belongs to the dying worker: reject it all
      // rather than leave promises hanging (the runtime's own queue is
      // untouched — queued requests simply run on the respawned worker).
      failAllPending(new LocalModelError('engine_infer_failed', 'worker recycled'))
      void worker.terminate()
    }
    worker = null
    loaded = false
  }

  /**
   * Spawn a worker and wire it up. The load promise settles on the load-result
   * ack (or a crash/timeout); after that the same handlers keep the engine
   * safe: a crash rejects every in-flight request and unregisters the worker.
   */
  function spawnWorker(): Worker {
    // `type: 'module'` is required (the bundled worker is ESM under the repo's
    // "type": "module") but @types/node 20 omits it from WorkerOptions.
    const w = new Worker(workerPath, { type: 'module' } as WorkerOptions)
    const fail = (e: LocalModelError): void => {
      if (worker === w) worker = null
      loaded = false
      failAllPending(e)
      if (!loadSettled) {
        loadSettled = true
        clearTimeout(loadTimer)
        loadReject(e)
      }
    }
    w.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'load-result') {
        if (!msg.ok) {
          fail(new LocalModelError('engine_load_failed', msg.error ?? 'worker load failed'))
          return
        }
        loaded = true
        if (!loadSettled) {
          loadSettled = true
          clearTimeout(loadTimer)
          loadResolve()
        }
        return
      }
      if (msg.type === 'infer-result') {
        const entry = pending.get(msg.id!)
        if (!entry) return
        pending.delete(msg.id!)
        entry.onSettle?.()
        if (msg.ok) entry.resolve(msg.text!)
        else entry.reject(new LocalModelError('engine_infer_failed', msg.error ?? 'worker inference failed'))
      }
    })
    // Stale guards: a replaced worker's error/exit must not touch the live
    // worker's load state or in-flight requests.
    w.on('error', (err) => {
      if (worker !== w) return
      fail(new LocalModelError('engine_infer_failed', `worker crashed: ${err.message}`))
      void w.terminate()
    })
    w.on('exit', (code) => {
      if (worker !== w) return
      worker = null
      loaded = false
      failAllPending(new LocalModelError('engine_infer_failed', `worker exited with code ${code}`))
      if (!loadSettled) {
        loadSettled = true
        clearTimeout(loadTimer)
        loadReject(new LocalModelError('engine_load_failed', `worker exited with code ${code}`))
      }
    })
    worker = w
    return w
  }

  // Load-phase settlement state (per spawn): resolved by the load-result ack,
  // rejected by crash/exit/ack-failure/timeout; settled exactly once.
  let loadSettled = false
  let loadResolve: () => void = () => {}
  let loadReject: (e: unknown) => void = () => {}
  let loadTimer: NodeJS.Timeout | undefined

  /** Spawn (or respawn) a worker and wait for its load-result ack. */
  async function spawnLoaded(modelPath: string, contextSize: number): Promise<void> {
    recycle()
    loadSettled = false
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    loadResolve = resolve
    loadReject = reject
    loadTimer = setTimeout(() => {
      failAllPending(new LocalModelError('engine_infer_failed', 'worker load timed out'))
      loadSettled = true
      reject(new LocalModelError('engine_load_failed', `worker load timed out after ${loadTimeoutMs}ms`))
      recycle()
    }, loadTimeoutMs)
    const w = spawnWorker()
    w.postMessage({ type: 'load', modelPath, contextSize })
    return promise
  }

  /** Ensure a live, loaded worker; respawns lazily after crash/termination. */
  async function ensureLoaded(): Promise<void> {
    if (worker && loaded && loadState) return
    if (!loadState) throw new LocalModelError('model_not_loaded', 'worker engine: load() must be called first')
    await spawnLoaded(loadState.modelPath, loadState.contextSize)
  }

  async function load(modelPath: string, contextSize: number): Promise<void> {
    loadState = { modelPath, contextSize }
    await spawnLoaded(modelPath, contextSize)
  }

  function infer(request: LocalModelEngineInferRequest, signal?: AbortSignal): Promise<string> {
    const id = nextId++
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    let abortTimer: ReturnType<typeof setTimeout> | null = null
    const onSettle = (): void => {
      if (abortTimer) {
        clearTimeout(abortTimer)
        abortTimer = null
      }
    }
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onSettle })
    void (async () => {
      try {
        await ensureLoaded()
        worker?.postMessage({
          type: 'infer',
          id,
          history: request.messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          schema: request.schema
        })
      } catch (e) {
        const entry = pending.get(id)
        if (entry) {
          pending.delete(id)
          entry.onSettle?.()
          entry.reject(e)
        }
      }
    })()
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          abortTimer = setTimeout(() => {
            const entry = pending.get(id)
            if (!entry) return // request already settled; nothing to reclaim
            pending.delete(id)
            entry.onSettle?.()
            entry.reject(new LocalModelError('engine_infer_failed', 'worker terminated after abort'))
            recycle()
          }, abortGraceMs)
          abortTimer.unref?.()
        },
        { once: true }
      )
    }
    return promise
  }

  async function dispose(): Promise<void> {
    const w = worker
    worker = null
    loaded = false
    if (w) {
      try {
        w.postMessage({ type: 'dispose' })
      } catch {
        /* worker may already be gone */
      }
      await w.terminate()
    }
    failAllPending(new LocalModelError('disposed', 'local model runtime disposed'))
  }

  return { load, infer, dispose }
}
