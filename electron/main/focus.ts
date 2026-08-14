/**
 * Panel keyboard-focus bridge (ticket 21, final form).
 *
 * Measured platform facts (Windows + Chromium):
 *   - An inactive window (WS_EX_NOACTIVATE / not foreground) silently drops
 *     element.focus() AND never receives global keyboard input — user32
 *     SetFocus from a non-foreground thread only sets the thread-local focus,
 *     keys still go to the foreground window. Verified end-to-end.
 *   - Chromium's internal activation (webContents.focus()) alone makes
 *     document.hasFocus() true but does NOT make the OS route real keystrokes.
 *   - So keyboard input REQUIRES the OS window to be truly activated.
 *   - Electron's setFocusable(false) HIDES the window on Windows — never use
 *     it; the window stays focusable:true at all times (window.ts), and the
 *     non-activatable behavior is controlled purely via the WS_EX_NOACTIVATE
 *     style.
 *
 * Design (activation on demand, session-held while typing):
 *   - requestPanelFocus (renderer `ui:input-focus` from pointerdown/focusin
 *     on an editable element, or from the notes view auto-focus on panel
 *     open): strip WS_EX_NOACTIVATE, then win.focus() — falling back to
 *     app.focus({ steal: true }) when the Windows foreground lock rejects
 *     the plain focus (hover-open is not a user input event). skipTaskbar
 *     is re-asserted so no taskbar button appears. Stealing the foreground
 *     is exactly what the user asked for by clicking an input — or by the
 *     notes editor auto-focusing.
 *   - While an input is focused the activated state is KEPT (input blur does
 *     not release it), so switching between inputs (input <-> textarea)
 *     never flickers the window or re-steals the foreground.
 *   - Non-input clicks (cards/buttons/chips) also KEEP the activation: early
 *     versions blurred the window after such clicks to hand the keyboard
 *     focus back, but every click then flipped the transparent panel
 *     active<->inactive and flickered it. Chromium activates the window on
 *     any click anyway, so holding the activation makes subsequent clicks
 *     no-ops; the user's keyboard flow resumes when they click back into
 *     their own app.
 *   - releasePanelFocusNow (main's window:set-interactive(false) path):
 *     restore WS_EX_NOACTIVATE when the panel closes.
 *
 * Every step fails silent: a hiccup degrades to "input focus request
 * ignored", never a crash.
 */
import { app } from 'electron'
import koffi from 'koffi'
import { getMainWindow } from './window'
import { activateHwnd } from './windowSwitch'

const WS_EX_NOACTIVATE = 0x08000000
const GWL_EXSTYLE = -20

type GetWindowLongPtrFn = (hwnd: unknown, index: number) => bigint
type SetWindowLongPtrFn = (hwnd: unknown, index: number, value: bigint) => bigint
type GetForegroundWindowFn = () => bigint

let getWindowLongPtrW: GetWindowLongPtrFn | null = null
let setWindowLongPtrW: SetWindowLongPtrFn | null = null
let getForegroundWindow: GetForegroundWindowFn | null = null

if (process.platform === 'win32') {
  try {
    const user32 = koffi.load('user32.dll')
    getWindowLongPtrW = user32.func('int64_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)') as GetWindowLongPtrFn
    getForegroundWindow = user32.func('int64_t __stdcall GetForegroundWindow()') as GetForegroundWindowFn
    setWindowLongPtrW = user32.func('int64_t __stdcall SetWindowLongPtrW(void *hWnd, int nIndex, int64_t dwNewLong)') as SetWindowLongPtrFn
  } catch (err) {
    console.error('[Focus] koffi user32 load failed — activation bridge disabled:', err)
  }
}

/**
 * Activate the panel window so the OS routes real keystrokes to it.
 * Idempotent — repeated calls while an input is focused are cheap (Electron
 * short-circuits an already-active window; the style strip is a no-op once
 * NOACTIVATE is gone). Fails silent.
 */
export function requestPanelFocus(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return
  try {
    win.setSkipTaskbar(true)
  } catch {
    // fail silent
  }
  let hwnd: bigint | null = null
  try {
    hwnd = BigInt(koffi.decode(win.getNativeWindowHandle(), koffi.pointer('void')))
    const ex = getWindowLongPtrW ? Number(getWindowLongPtrW(hwnd, GWL_EXSTYLE)) : 0
    if (ex !== 0 && (ex & WS_EX_NOACTIVATE) !== 0 && setWindowLongPtrW) {
      setWindowLongPtrW(hwnd, GWL_EXSTYLE, BigInt(ex & ~WS_EX_NOACTIVATE))
    }
  } catch {
    // fail silent
  }
  try {
    win.focus()
    // Windows foreground lock: a hover-opened panel is not a "user input"
    // event, so win.focus() can be silently ignored and keystrokes keep
    // going to the external app while the caret merely appears inside.
    // win.isFocused() is no reliable oracle here — webContents-internal
    // activation alone reports focused — so compare against the real OS
    // foreground window and steal when it is still someone else's.
    const fg = getForegroundWindow ? getForegroundWindow() : null
    if (fg === null || fg !== hwnd) {
      try {
        app.focus({ steal: true })
      } catch {
        // fail silent — escalation continues
      }
      win.focus()
      // The lock can reject even app.focus() (re-hovering the edge is not
      // a user-input event either). activateHwnd's AttachThreadInput +
      // SetForegroundWindow chain works without input rights.
      const fg2 = getForegroundWindow ? getForegroundWindow() : null
      if (fg2 === null || fg2 !== hwnd) {
        try {
          activateHwnd(koffi.decode(win.getNativeWindowHandle(), koffi.pointer('void')))
        } catch {
          // fail silent — best effort
        }
      }
    }
  } catch {
    // fail silent
  }
}
/**
 * Input blur (`ui:input-blur`): intentionally a no-op. Early versions blurred
 * the window on every non-input click to hand the keyboard focus back, but
 * that flipped the transparent panel active<->inactive on each click and
 * flickered it (layered-window re-synth), and raced Chromium's own
 * activation. Activation is held for the panel session; the only release
 * points are the panel closing (releasePanelFocusNow) and the user clicking
 * back into their own app (which re-activates that window naturally).
 */
export function releasePanelFocus(): void {
  // no-op — see module docs
}

/** Restore the non-activatable style — called when the panel closes. */
export function releasePanelFocusNow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    const hwnd = koffi.decode(win.getNativeWindowHandle(), koffi.pointer('void'))
    const ex = getWindowLongPtrW ? Number(getWindowLongPtrW(hwnd, GWL_EXSTYLE)) : 0
    if (ex !== 0 && (ex & WS_EX_NOACTIVATE) === 0 && setWindowLongPtrW) {
      setWindowLongPtrW(hwnd, GWL_EXSTYLE, BigInt(ex | WS_EX_NOACTIVATE))
    }
  } catch {
    // fail silent
  }
}
