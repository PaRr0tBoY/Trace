/**
 * Drag detection host — runs inside a utilityProcess (pure Node, no Chromium).
 *
 * Why a separate process: a WinEvent hook callback fires inside whatever
 * GetMessage loop retrieves the hook message. In the Electron main process
 * that is Chromium's message pump, and re-entering V8/koffi from that context
 * deadlocked for the keyboard hook (verified on-device). The same hook runs
 * flawlessly in a plain Node event loop with our own PeekMessageW pump,
 * which is exactly what utilityProcess provides. Process isolation also
 * guarantees the OS tears the hook down if this host dies.
 *
 * Events flow out via process.parentPort; main drives it with
 * utilityProcess.fork('dragHost.js') (dragManager.ts).
 */
import { startDragDetect, stopDragDetect } from './dragDetect'

startDragDetect({
  onStart: (facts) => process.parentPort?.postMessage({ type: 'start', ...facts }),
  onEnd: (facts) => process.parentPort?.postMessage({ type: 'end', ...facts })
})

process.parentPort?.on('message', (e: { data?: { type?: string } }) => {
  if (e.data?.type === 'stop') stopDragDetect()
})
