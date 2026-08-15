/**
 * Shared idle guard for 智能收起 (Smart Collapse Fallbacks).
 *
 * Both consumers arm the same guard:
 *   - renderer: the notes editor holds focus while the cursor has left the
 *     blade — keystrokes/IME/pointer activity touch() it;
 *   - main: the pinned switcher session — any selection activity
 *     (arrows / hover / typing) touches() it.
 *
 * Semantics: once started, the guard fires `onIdle` exactly once when no
 * activity arrives within `idleMs`. `stop()` pauses without firing (e.g. the
 * cursor re-entered the blade); `dispose()` tears the guard down permanently.
 * Pure TS — no Electron/DOM — so it runs in both processes and is unit-testable.
 */
export const SMART_COLLAPSE_IDLE_MS = 5000

export interface IdleGuard {
  /** Begin (or restart) the idle window — first call arms the timer. */
  touch(): void
  /** Pause without firing (activity moved back into the panel). */
  stop(): void
  /** Permanent teardown; further calls are no-ops. */
  dispose(): void
}

export function createIdleGuard(opts: { idleMs?: number; onIdle: () => void }): IdleGuard {
  const idleMs = opts.idleMs ?? SMART_COLLAPSE_IDLE_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const arm = (): void => {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      // Fire exactly once: further touch()/stop() become no-ops.
      disposed = true
      opts.onIdle()
    }, idleMs)
  }

  return {
    touch() {
      arm()
    },
    stop() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
