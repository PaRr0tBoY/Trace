/**
 * Window activation for the task detail's "open app" action (ADR-0005).
 *
 * Trace is a background process, so SetForegroundWindow is subject to the
 * Windows foreground lock. The workaround chain: ShowWindow(SW_RESTORE) →
 * attach our input thread to the foreground and target threads →
 * SetForegroundWindow → SwitchToThisWindow fallback → detach. No Alt-Tab
 * simulation in V1.
 *
 * Top-level windows are enumerated with the GetWindow GW_HWNDFIRST /
 * GW_HWNDNEXT z-order walk instead of EnumWindows — avoids koffi callback
 * marshaling entirely and yields the topmost window first.
 */
import koffi from 'koffi'
import { shell } from 'electron'
import type { AppRef } from '../../shared/types'

// ---- koffi Win32 glue (loaded once; activation degrades on failure) ----

type GetWindowFn = (hwnd: unknown, uCmd: number) => unknown
type IsWindowVisibleFn = (hwnd: unknown) => number
type GetWindowThreadProcessIdFn = (hwnd: unknown, pid: number[]) => number
type GetWindowTextWFn = (hwnd: unknown, buf: string[], maxCount: number) => number
type ShowWindowFn = (hwnd: unknown, nCmdShow: number) => number
type SetForegroundWindowFn = (hwnd: unknown) => number
type SwitchToThisWindowFn = (hwnd: unknown, fAltTab: number) => void
type AttachThreadInputFn = (idAttach: number, idAttachTo: number, fAttach: number) => number
type GetForegroundWindowFn = () => unknown
type GetCurrentThreadIdFn = () => number
type OpenProcessFn = (access: number, inherit: number, pid: number) => unknown
type QueryFullProcessImageNameWFn = (handle: unknown, flags: number, buf: string[], size: number[]) => number
type CloseHandleFn = (handle: unknown) => number

let getWindow: GetWindowFn | null = null
let isWindowVisible: IsWindowVisibleFn | null = null
let getWindowThreadProcessId: GetWindowThreadProcessIdFn | null = null
let getWindowTextW: GetWindowTextWFn | null = null
let showWindow: ShowWindowFn | null = null
let setForegroundWindow: SetForegroundWindowFn | null = null
let switchToThisWindow: SwitchToThisWindowFn | null = null
let attachThreadInput: AttachThreadInputFn | null = null
let getForegroundWindow: GetForegroundWindowFn | null = null
let getCurrentThreadId: GetCurrentThreadIdFn | null = null
let openProcess: OpenProcessFn | null = null
let queryFullProcessImageNameW: QueryFullProcessImageNameWFn | null = null
let closeHandle: CloseHandleFn | null = null

if (process.platform === 'win32') {
  try {
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    getWindow = user32.func('void * __stdcall GetWindow(void *hWnd, uint32_t uCmd)')
    isWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hWnd)')
    getWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)')
    getWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ char16_t *lpString, int nMaxCount)')
    showWindow = user32.func('int __stdcall ShowWindow(void *hWnd, int nCmdShow)')
    setForegroundWindow = user32.func('int __stdcall SetForegroundWindow(void *hWnd)')
    switchToThisWindow = user32.func('void __stdcall SwitchToThisWindow(void *hWnd, int fAltTab)')
    attachThreadInput = user32.func('int __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, int fAttach)')
    getForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
    getCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()')
    openProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)')
    queryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ char16_t *lpExeName, _Inout_ uint32_t *lpdwSize)')
    closeHandle = kernel32.func('int __stdcall CloseHandle(void *hObject)')
  } catch (err) {
    console.error('[WindowSwitch] koffi Win32 load failed — window activation disabled:', err)
  }
}

/** GetWindow commands for the z-order traversal. */
const GW_HWNDFIRST = 0
const GW_HWNDNEXT = 2
/** ShowWindow restore command (SW_RESTORE). */
const SW_RESTORE = 9
const TITLE_BUF_CHARS = 512
const PATH_BUF_CHARS = 1024
/** PROCESS_QUERY_LIMITED_INFORMATION — enough to read the image path, needs no extra privileges. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** One visible top-level window from the z-order walk. */
interface TopLevelWindow {
  hwnd: unknown
  pid: number
  exePath: string
}

function trimNul(value: string | undefined): string {
  return (value ?? '').replace(/\0+$/g, '')
}

/** Same identity key space as the clusterer: lowercase + slash-normalized. */
function normalizeAppKey(s: string): string {
  return s.trim().toLowerCase().replace(/\\/g, '/')
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

/**
 * Walk visible top-level windows in z-order (topmost first). Windows whose
 * exe path can't be read are skipped — they can't be matched to an app.
 */
function walkTopLevelWindows(): TopLevelWindow[] {
  const windows: TopLevelWindow[] = []
  if (!getWindow || !isWindowVisible || !getWindowThreadProcessId) return windows
  try {
    let hwnd: unknown = getWindow(null, GW_HWNDFIRST)
    while (hwnd) {
      if (isWindowVisible(hwnd)) {
        const pidOut = [0]
        getWindowThreadProcessId(hwnd, pidOut)
        const pid = pidOut[0]
        // Skip Trace's own windows (and pid 0 = no process).
        if (pid > 0 && pid !== process.pid) {
          const exePath = queryExePath(pid)
          if (exePath) windows.push({ hwnd, pid, exePath })
        }
      }
      hwnd = getWindow(hwnd, GW_HWNDNEXT)
    }
  } catch (err) {
    // Best-effort traversal: keep whatever was collected before the failure.
    console.error('[WindowSwitch] window walk failed:', err)
  }
  return windows
}

/**
 * Bring a top-level window to the foreground. Trace is a background process,
 * so the Windows foreground lock may reject SetForegroundWindow; the
 * AttachThreadInput dance is the standard workaround and SwitchToThisWindow
 * is the best-effort fallback when the lock still wins. Returns whether
 * SetForegroundWindow succeeded (the fallback's outcome is not observable).
 */
function activateHwnd(hwnd: unknown): boolean {
  if (
    !hwnd || !showWindow || !getWindowThreadProcessId || !getForegroundWindow ||
    !getCurrentThreadId || !setForegroundWindow || !attachThreadInput ||
    !switchToThisWindow || !getWindowTextW
  ) {
    return false
  }
  try {
    showWindow(hwnd, SW_RESTORE)
    const fgTid = getWindowThreadProcessId(getForegroundWindow(), [0])
    const targetTid = getWindowThreadProcessId(hwnd, [0])
    const ourTid = getCurrentThreadId()
    const attached: number[] = []
    for (const tid of [fgTid, targetTid]) {
      if (tid !== 0 && tid !== ourTid && !attached.includes(tid)) {
        if (attachThreadInput(ourTid, tid, 1)) attached.push(tid)
      }
    }
    const ok = setForegroundWindow(hwnd) !== 0
    if (!ok) {
      switchToThisWindow(hwnd, 1)
      const titleBuf = ['\0'.repeat(TITLE_BUF_CHARS)]
      getWindowTextW(hwnd, titleBuf, TITLE_BUF_CHARS)
      console.log(`[WindowSwitch] foreground lock held — SwitchToThisWindow fallback for "${trimNul(titleBuf[0])}"`)
    }
    for (let i = attached.length - 1; i >= 0; i--) attachThreadInput(ourTid, attached[i], 0)
    return ok
  } catch {
    return false
  }
}

/**
 * Activate the app for a task detail "open app" click: the linked window
 * (ADR-0005) first, then any visible window of the same exe, then launch the
 * exe. Never throws; koffi load failure reports a failed window attempt.
 */
export async function activateAppWindow(app: AppRef): Promise<{ ok: boolean; method: 'window' | 'launch' }> {
  if (!getWindow || !isWindowVisible || !getWindowThreadProcessId) {
    return { ok: false, method: 'window' }
  }
  const windows = walkTopLevelWindows()

  // a. The foreground window recorded when the app first joined the task.
  const linkedPid = app.linkedWindow?.pid
  const linkedHit = linkedPid ? windows.find((w) => w.pid === linkedPid) : undefined
  if (linkedHit) {
    activateHwnd(linkedHit.hwnd)
    return { ok: true, method: 'window' }
  }

  // b. Any visible window of the same exe (topmost first). Runs regardless of
  //    the pid check: covers a dead linked pid (app restarted with a new pid)
  //    and tasks recorded before linkedWindow existed.
  const key = normalizeAppKey(app.exePath ?? '')
  if (key.length > 0) {
    const exeHit = windows.find((w) => normalizeAppKey(w.exePath) === key)
    if (exeHit) {
      activateHwnd(exeHit.hwnd)
      return { ok: true, method: 'window' }
    }
  }

  // c. Nothing to switch to — start the app itself (openPath resolves '' on success).
  if (app.exePath) {
    try {
      const err = await shell.openPath(app.exePath)
      return { ok: err === '', method: 'launch' }
    } catch {
      return { ok: false, method: 'launch' }
    }
  }

  // d. No exePath recorded at all.
  return { ok: false, method: 'window' }
}
