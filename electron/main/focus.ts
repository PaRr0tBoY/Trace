/**
 * Panel keyboard-focus bridge (ticket 21).
 *
 * The panel BrowserWindow is created with `focusable: false` (upstream
 * legacy). That sets both the OS WS_EX_NOACTIVATE style AND Chromium's
 * internal "window cannot activate" state — the latter is cached at creation
 * and ignores raw style manipulation: stripping WS_EX_NOACTIVATE via
 * SetWindowLongPtr makes the OS window activatable (foreground/active/keyboard
 * focus all move correctly) but Chromium never routes keyboard input, so
 * keystrokes still get dropped. That path was tried and measured on a real
 * machine; this is the root-cause fix.
 *
 * The working approach uses Electron's own focus machinery, which updates
 * both layers at once:
 *
 *   - requestPanelFocus (renderer fired `ui:input-focus` when an editable
 *     element gained focus): setFocusable(true) + focus() — the window truly
 *     activates and Chromium routes keys to the renderer. Stealing the
 *     foreground is exactly what the user asked for by clicking an input.
 *   - releasePanelFocus (`ui:input-blur`): setFocusable(false) — back to
 *     non-activatable so ordinary clicks (cards, buttons, tabs) never
 *     activate the panel again.
 *
 * Every step fails silent: a hiccup degrades to "input focus request
 * ignored", never a crash.
 */
import koffi from 'koffi'
import { getMainWindow } from './window'

const WS_EX_NOACTIVATE = 0x08000000
const GWL_EXSTYLE = -20

type GetWindowLongPtrFn = (hwnd: unknown, index: number) => bigint
type SetWindowLongPtrFn = (hwnd: unknown, index: number, value: bigint) => bigint

let getWindowLongPtrW: GetWindowLongPtrFn | null = null
let setWindowLongPtrW: SetWindowLongPtrFn | null = null

if (process.platform === 'win32') {
  try {
    const user32 = koffi.load('user32.dll')
    getWindowLongPtrW = user32.func('int64_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)') as GetWindowLongPtrFn
    setWindowLongPtrW = user32.func('int64_t __stdcall SetWindowLongPtrW(void *hWnd, int nIndex, int64_t dwNewLong)') as SetWindowLongPtrFn
  } catch (err) {
    console.error('[Focus] koffi user32 load failed — NOACTIVATE restore disabled:', err)
  }
}

/**
 * Activate the panel window so Chromium forwards keyboard input to the
 * renderer. Idempotent — repeated calls while an input is focused are cheap
 * (Electron short-circuits an already-active window). Fails silent.
 */
export function requestPanelFocus(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return
  try {
    win.setFocusable(true)
    win.focus()
  } catch {
    // fail silent
  }
}

/**
 * Restore the panel to non-activatable after the input lost focus, so
 * non-input clicks never activate it again. Idempotent; fails silent.
 *
 * setFocusable(false) resets Chromium's internal activation state but does
 * NOT re-apply the WS_EX_NOACTIVATE style (measured on Windows) — re-add the
 * style explicitly so plain clicks cannot activate the window at the OS
 * level either.
 */
export function releasePanelFocus(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.setFocusable(false)
  } catch {
    // fail silent
  }
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
