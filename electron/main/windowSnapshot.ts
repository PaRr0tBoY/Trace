/**
 * Window snapshot for the Alt+Tab switcher (ADR-0005).
 *
 * Top-level windows are enumerated with the GetWindow GW_HWNDFIRST /
 * GW_HWNDNEXT z-order walk (same pattern as windowSwitch.ts — avoids koffi
 * callback marshaling entirely) and the z-order IS the MRU order the native
 * switcher shows: topmost visible window first, then each window that was
 * activated most recently. The walk starts at the foreground window, so the
 * first entry is the current window.
 *
 * Filtering: visible top-level windows with a non-empty title, excluding
 * Trace itself (pid match — the panel window, onboarding, etc.). Explorer's
 * desktop ("Program Manager") and ordinary titled windows pass through.
 *
 * exePath is resolved via QueryFullProcessImageNameW (PROCESS_QUERY_LIMITED_
 * INFORMATION, no extra privileges) so the existing appIcons pipeline can
 * serve icons for the list.
 */
import koffi from 'koffi'

export interface SwitcherWindow {
  hwnd: unknown
  pid: number
  exePath: string
  title: string
  isCurrent: boolean
}

type GetWindowFn = (hwnd: unknown, uCmd: number) => unknown
/** GetTopWindow(NULL) — z-order topmost window (the foreground window). */
type GetTopWindowFn = (hwnd: unknown) => unknown
type GetWindowLongPtrWFn = (hwnd: unknown, index: number) => bigint
type IsWindowVisibleFn = (hwnd: unknown) => number
type GetWindowThreadProcessIdFn = (hwnd: unknown, pid: number[]) => number
type GetWindowTextWFn = (hwnd: unknown, buf: string[], maxCount: number) => number
type GetForegroundWindowFn = () => unknown
type OpenProcessFn = (access: number, inherit: number, pid: number) => unknown
type QueryFullProcessImageNameWFn = (handle: unknown, flags: number, buf: string[], size: number[]) => number
type CloseHandleFn = (handle: unknown) => number

let getWindow: GetWindowFn | null = null
let getTopWindow: GetTopWindowFn | null = null
let getWindowLongPtrW: GetWindowLongPtrWFn | null = null
let isWindowVisible: IsWindowVisibleFn | null = null
let getWindowThreadProcessId: GetWindowThreadProcessIdFn | null = null
let getWindowTextW: GetWindowTextWFn | null = null
let getForegroundWindow: GetForegroundWindowFn | null = null
let openProcess: OpenProcessFn | null = null
let queryFullProcessImageNameW: QueryFullProcessImageNameWFn | null = null
let closeHandle: CloseHandleFn | null = null

if (process.platform === 'win32') {
  try {
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    getWindow = user32.func('void * __stdcall GetWindow(void *hWnd, uint32_t uCmd)')
    getTopWindow = user32.func('void * __stdcall GetTopWindow(void *hWnd)')
    getWindowLongPtrW = user32.func('int64_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)')
    isWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hWnd)')
    getWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)')
    getWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ char16_t *lpString, int nMaxCount)')
    getForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
    openProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)')
    queryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ char16_t *lpExeName, _Inout_ uint32_t *lpdwSize)')
    closeHandle = kernel32.func('int __stdcall CloseHandle(void *hObject)')
  } catch (err) {
    console.error('[Snapshot] koffi Win32 load failed — switcher window list disabled:', err)
  }
}

const GW_HWNDNEXT = 2
/** GetWindow relationship: owner window. */
const GW_OWNER = 4
const GWL_EXSTYLE = -20
/** WS_EX_TOOLWINDOW — tool windows never appear in the native Alt+Tab ring. */
const WS_EX_TOOLWINDOW = 0x00000080
/** WS_EX_APPWINDOW — explicitly a top-level app window (forces inclusion). */
const WS_EX_APPWINDOW = 0x00040000
const TITLE_BUF_CHARS = 512
const PATH_BUF_CHARS = 1024
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/**
 * The native Alt+Tab ring membership rule (explorer's): show a window when it
 * is marked WS_EX_APPWINDOW, or when it is neither a tool window nor owned by
 * another window. This keeps invisible service hosts (TextInputHost,
 * ShellExperienceHost, quark's clouddrive widget…) out of the list while
 * keeping UWP app hosts (ApplicationFrameHost carries the app's own title).
 */
function isSwitcherEligible(hwnd: unknown): boolean {
  let ex = 0
  let owner = null
  try {
    if (getWindowLongPtrW) ex = Number(getWindowLongPtrW(hwnd, GWL_EXSTYLE))
    if (getWindow) owner = getWindow(hwnd, GW_OWNER)
  } catch {
    return false
  }
  if ((ex & WS_EX_APPWINDOW) !== 0) return true
  if ((ex & WS_EX_TOOLWINDOW) !== 0) return false
  if (owner) return false
  return true
}

function trimNul(value: string | undefined): string {
  return (value ?? '').replace(/\0+$/g, '')
}

/**
 * Invisible UWP/system hosts that pass the style rules but never belong in a
 * window switcher (their visible UI, if any, is rendered elsewhere):
 * TextInputHost = the IME/input experience host, ShellExperienceHost =
 * shell toast/charm host, SearchHost = search pane host.
 */
const EXCLUDED_HOST_EXE = new Set([
  'textinputhost.exe',
  'shellexperiencehost.exe',
  'searchhost.exe',
  'startmenuexperiencehost.exe'
])

function isExcludedHost(exePath: string): boolean {
  if (!exePath) return false
  const base = exePath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return EXCLUDED_HOST_EXE.has(base)
}

/** Enumerate visible top-level windows in z-order (topmost first). */
export function snapshotWindows(): SwitcherWindow[] {
  if (!getWindow || !getTopWindow || !isWindowVisible || !getWindowThreadProcessId || !getWindowTextW) return []
  const windows: SwitcherWindow[] = []
  const currentHwnd = getForegroundWindow ? getForegroundWindow() : null
  // GetWindow(NULL, GW_HWNDFIRST) returns NULL on this system — the walk
  // must start at GetTopWindow(NULL) (verified on-device). Note windowSwitch.ts
  // starts with the NULL form; its walk may silently yield nothing (t30 note).
  let hwnd = getTopWindow(null)
  let guard = 0
  while (hwnd && guard++ < 512) {
    if (isWindowVisible(hwnd) && isSwitcherEligible(hwnd)) {
      const title = readTitle(hwnd)
      if (title.length > 0) {
        const pidOut = [0]
        getWindowThreadProcessId(hwnd, pidOut)
        const pid = pidOut[0]
        if (pid !== process.pid) {
          const exePath = readExePath(pid)
          if (isExcludedHost(exePath)) {
            hwnd = getWindow(hwnd, GW_HWNDNEXT)
            continue
          }
          windows.push({
            hwnd,
            pid,
            exePath,
            title,
            isCurrent: currentHwnd === hwnd
          })
        }
      }
    }
    hwnd = getWindow(hwnd, GW_HWNDNEXT)
  }
  // The z-order walk starts at topmost window, which is not necessarily the
  // foreground window (always-on-top windows sit above it). The native
  // switcher's ring starts at the current window, so hoist it to index 0 and
  // keep the rest in z-order (== MRU for non-tool windows).
  const currentIndex = windows.findIndex((w) => w.isCurrent)
  if (currentIndex > 0) {
    const [current] = windows.splice(currentIndex, 1)
    windows.unshift(current)
  }
  return windows
}

function readTitle(hwnd: unknown): string {
  if (!getWindowTextW) return ''
  try {
    // koffi _Out_ char16_t* writes into a pre-filled string element.
    const buf = ['\0'.repeat(TITLE_BUF_CHARS)]
    const n = getWindowTextW(hwnd, buf, TITLE_BUF_CHARS)
    return trimNul(buf[0] ?? '').slice(0, Math.max(0, n))
  } catch {
    return ''
  }
}

function readExePath(pid: number): string {
  if (!openProcess || !queryFullProcessImageNameW || !closeHandle) return ''
  try {
    const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (!handle) return ''
    const buf = ['\0'.repeat(PATH_BUF_CHARS)]
    const size = [PATH_BUF_CHARS]
    const ok = queryFullProcessImageNameW(handle, 0, buf, size)
    closeHandle(handle)
    return ok ? trimNul(buf[0] ?? '') : ''
  } catch {
    return ''
  }
}
