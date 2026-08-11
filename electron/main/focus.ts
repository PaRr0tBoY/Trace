/**
 * Panel keyboard-focus bridge (ticket 21).
 *
 * The panel BrowserWindow is created with `focusable: false` (upstream
 * legacy), so clicking an input never hands the renderer the OS keyboard
 * focus — keystrokes keep flowing to the previously active app. When the
 * renderer focuses an editable element it fires `ui:input-focus`
 * (fire-and-forget), which lands here: SetFocus the panel's HWND via user32.
 *
 * Deliberately not `win.focus()`: for a focusable:false window Electron's
 * focus path also messes with show/minimize/z-order, while a bare SetFocus
 * only moves keyboard focus. Focus is never released here — the OS moves it
 * away naturally when the user clicks another window.
 */
import koffi from 'koffi'
import { getMainWindow } from './window'

type SetFocusFn = (hwnd: unknown) => unknown

let setFocus: SetFocusFn | null = null
if (process.platform === 'win32') {
  try {
    const user32 = koffi.load('user32.dll')
    setFocus = user32.func('void * __stdcall SetFocus(void *hWnd)') as SetFocusFn
  } catch (err) {
    console.error('[Focus] koffi user32 load failed — input focus requests disabled:', err)
  }
}

/**
 * Give the panel window keyboard focus. Cheap (one user32 call) and
 * idempotent; fails silently when koffi or the window is unavailable.
 */
export function requestPanelFocus(): void {
  if (!setFocus) return
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return
  try {
    // getNativeWindowHandle() returns the HWND *value* in a Buffer — decode it
    // into a pointer before handing it to user32.
    const hwnd = koffi.decode(win.getNativeWindowHandle(), koffi.pointer('void'))
    setFocus(hwnd)
  } catch {
    // fail silent
  }
}
