/**
 * Alt+Tab hook host — runs inside a utilityProcess (pure Node, no Chromium).
 *
 * Why a separate process: a WH_KEYBOARD_LL callback fires inside whatever
 * GetMessage loop retrieves the hook message. In the Electron main process
 * that is Chromium's message pump, and re-entering V8/koffi from that context
 * deadlocked — Trace froze and, worse, the stuck hook swallowed every key
 * until the process was killed (verified twice on-device). The same hook
 * runs flawlessly in a plain Node event loop (our own PeekMessageW pump),
 * which is exactly what utilityProcess provides.
 *
 * Process isolation also gives a hard safety property: if this host dies or
 * hangs, the OS tears the hook down with it (a dead process cannot swallow
 * keys) and the main process stays responsive (tray quit still works).
 *
 * Events flow out via process.parentPort; main drives it with
 * utilityProcess.fork('hookHost.js').
 */
import { startKeyboardHook, stopKeyboardHook, setPinned } from './keyboardHook'

startKeyboardHook({
  onShow: ({ shiftDown }) => process.parentPort?.postMessage({ type: 'show', shiftDown }),
  onAdvance: (delta) => process.parentPort?.postMessage({ type: 'advance', delta }),
  onExecute: () => process.parentPort?.postMessage({ type: 'execute' }),
  onTapExecute: ({ shiftDown }) => process.parentPort?.postMessage({ type: 'tap', shiftDown }),
  onPin: (initialQuery) => process.parentPort?.postMessage({ type: 'pin', initialQuery }),
  onTouch: () => process.parentPort?.postMessage({ type: 'touch' }),
  onPinReleased: () => process.parentPort?.postMessage({ type: 'pin-released' }),
  onControlKey: (key) => process.parentPort?.postMessage({ type: 'control-key', key }),
  onMouseDown: (pt) => process.parentPort?.postMessage({ type: 'mouse-down', x: pt.x, y: pt.y })
})

process.parentPort?.on('message', (e: { data?: { type?: string; pinned?: boolean } }) => {
  if (e.data?.type === 'stop') stopKeyboardHook()
  else if (e.data?.type === 'pin-state' && typeof e.data.pinned === 'boolean') setPinned(e.data.pinned)
})
