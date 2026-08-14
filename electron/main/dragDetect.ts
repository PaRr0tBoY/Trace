/**
 * Drag detection (T4b, ADR-0007 T4a addendum).
 *
 * Runs inside a utilityProcess (dragHost.ts) — same isolation rationale as
 * keyboardHook.ts/hookHost.ts: an OS hook callback dispatched from the
 * Electron main process's message pump deadlocks on koffi/Chromium re-entry
 * (verified on-device for WH_KEYBOARD_LL; the WinEvent hook gets the same
 * treatment to stay on the safe side).
 *
 * Primary source: SetWinEventHook for EVENT_SYSTEM_DRAGDROPSTART (0x0F) /
 * EVENT_SYSTEM_DRAGDROPEND (0x10), driven by a 4 ms PeekMessageW pump (WinEvent
 * callbacks are delivered via the message queue; no pump = silent hook).
 * The 0x0F event carries the drag SOURCE window hwnd — the only signal that
 * can classify file-vs-non-file at drag start. Classes that mean "file drag":
 * Explorer / desktop (CabinetWClass, SysListView32, Progman, WorkerW,
 * Shelldll_DefView, Shell_TrayWnd); everything else (browser selections,
 * Office, ...) is not a file drag and must never expand the panel.
 *
 * Fallback source: 60 ms DragWindow poll (FindWindowW('DragWindow')). If the
 * hook events never fire (injected-drag experiments suggest they may not,
 * real-drag data pending), the poll still sees the OLE drag ghost window
 * appear/disappear. It has no source window, so isFileDrag is reported false
 * and the manager applies the ADR fallback: cursor inside the panel ⇒ file
 * drag (the "grab a file onto Trace" gesture).
 *
 * Both sources feed the same fact shape { isFileDrag, cursorInPanel,
 * dragActive } (dragSession.ts consumes it), so switching is seamless.
 * Dedup: the first source to see a drag start owns the session; the hook's
 * 0x10 is authoritative for the end (the poll cannot see the ghost vanish
 * reliably across all targets).
 *
 * The callback itself only records the hwnd and defers the classification:
 * koffi calls from inside hook dispatch are what froze Electron (see
 * keyboardHook.ts). Deferred work runs ~1 ms later in a plain timer context.
 */
import koffi from 'koffi'

const EVENT_SYSTEM_DRAGDROPSTART = 0x0f
const EVENT_SYSTEM_DRAGDROPEND = 0x10
const WINEVENT_OUTOFCONTEXT = 0x0000
const WINEVENT_SKIPOWNPROCESS = 0x0002
const PM_REMOVE = 0x0001
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const DRAGWINDOW_POLL_MS = 60
const PUMP_MS = 4
const PUMP_MAX_MSGS_PER_TICK = 8

// Debug noise goes behind this switch (AGENTS.md logging rules).
const DEBUG = false

/** Source-window classes that classify a drag as a file drag. */
export const FILE_DRAG_CLASSES = new Set([
  'CabinetWClass', 'XamlExplorerHostIslandWindow', 'SysListView32', 'Progman', 'WorkerW',
  'Shelldll_DefView', 'Shell_TrayWnd'
])

const MSG = koffi.struct('MSG', {
  hwnd: 'void *',
  message: 'uint32_t',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32_t',
  pt_x: 'int32_t',
  pt_y: 'int32_t'
})

const POINT = koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' })
// POINT is referenced by name inside the koffi signature strings below (the
// struct must be registered with koffi before those load); TS only sees the
// string, so reference it explicitly to satisfy noUnusedLocals.
void POINT

const winEventProto = koffi.pointer(koffi.proto(
  'void (void *hook, uint32_t event, void *hwnd, int32_t idObject, int32_t idChild, uint32_t idThread, uint32_t msTime)'
))

type SetWinEventHookFn = (min: number, max: number, hmod: unknown, cb: unknown, idProcess: number, idThread: number, flags: number) => unknown
type UnhookWinEventFn = (hook: unknown) => number
type PeekMessageWFn = (msg: unknown, hWnd: unknown, min: number, max: number, remove: number) => number
type GetClassNameWFn = (hwnd: unknown, buf: string[], max: number) => number
type GetForegroundWindowFn = () => unknown
type GetCursorPosFn = (pt: { x: number; y: number }) => number
type FindWindowWFn = (cls: string | null, title: string | null) => unknown
type GetWindowThreadProcessIdFn = (hwnd: unknown, pid: number[]) => number
type WindowFromPointFn = (pt: { x: number; y: number }) => unknown
type OpenProcessFn = (access: number, inherit: number, pid: number) => unknown
type QueryFullProcessImageNameWFn = (proc: unknown, flags: number, buf: string[], size: number[]) => number
type CloseHandleFn = (h: unknown) => number

let setWinEventHook: SetWinEventHookFn | null = null
let unhookWinEvent: UnhookWinEventFn | null = null
let peekMessageW: PeekMessageWFn | null = null
let getClassNameW: GetClassNameWFn | null = null
let getForegroundWindow: GetForegroundWindowFn | null = null
let getCursorPos: GetCursorPosFn | null = null
let findWindowW: FindWindowWFn | null = null
let getWindowThreadProcessId: GetWindowThreadProcessIdFn | null = null
let windowFromPoint: WindowFromPointFn | null = null
let openProcess: OpenProcessFn | null = null
let queryFullProcessImageNameW: QueryFullProcessImageNameWFn | null = null
let closeHandle: CloseHandleFn | null = null

let bindingsOk = false
try {
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  setWinEventHook = user32.func('SetWinEventHook', 'void *', ['uint32_t', 'uint32_t', 'void *', winEventProto, 'uint32_t', 'uint32_t', 'uint32_t'])
  unhookWinEvent = user32.func('UnhookWinEvent', 'int', ['void *'])
  peekMessageW = user32.func('PeekMessageW', 'int', [koffi.pointer(MSG), 'void *', 'uint32_t', 'uint32_t', 'uint32_t'])
  getClassNameW = user32.func('int GetClassNameW(void *hwnd, _Out_ char16_t *buf, int max)')
  getForegroundWindow = user32.func('void *GetForegroundWindow()')
  getCursorPos = user32.func('int GetCursorPos(_Out_ POINT *pt)')
  findWindowW = user32.func('void *FindWindowW(const char16_t *cls, const char16_t *title)')
  getWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)')
  windowFromPoint = user32.func('void *WindowFromPoint(POINT pt)')
  openProcess = kernel32.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)')
  queryFullProcessImageNameW = kernel32.func('int QueryFullProcessImageNameW(void *hProcess, uint32_t flags, _Out_ char16_t *buf, _Inout_ uint32_t *size)')
  closeHandle = kernel32.func('int CloseHandle(void *h)')
  bindingsOk = true
} catch (err) {
  console.error('[DragDetect] koffi user32/kernel32 load failed — drag detection disabled:', err)
}

export interface DragDetectStartFacts {
  isFileDrag: boolean
  /** Raw source-window class; '' = read failed (manager applies the cursor fallback). */
  srcClass: string
  cursor: { x: number; y: number }
}

export interface DragDetectEndFacts {
  reason: 'hook' | 'dragwindow'
  cursor: { x: number; y: number }
  /** Drop-target heuristics for T3 (ADR-0007 addendum point 2). */
  fgExe: string
  fgClass: string
  curClass: string
  curExe: string
}

export interface DragDetectEvents {
  onStart: (facts: DragDetectStartFacts) => void
  onEnd: (facts: DragDetectEndFacts) => void
}

function readClassName(hwnd: unknown): string {
  if (!hwnd || !getClassNameW) return ''
  try {
    const buf = ['\0'.repeat(256)]
    const n = getClassNameW(hwnd, buf, 256)
    return n > 0 ? buf[0].slice(0, n) : ''
  } catch {
    return ''
  }
}

function readExePath(pid: number): string {
  if (!pid || !openProcess || !queryFullProcessImageNameW || !closeHandle) return ''
  try {
    const h = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (!h) return ''
    const buf = ['\0'.repeat(512)]
    const size = [512]
    const ok = queryFullProcessImageNameW(h, 0, buf, size)
    closeHandle(h)
    return ok ? buf[0].slice(0, size[0]) : ''
  } catch {
    return ''
  }
}

function readCursor(): { x: number; y: number } {
  if (!getCursorPos) return { x: 0, y: 0 }
  try {
    const pt = { x: 0, y: 0 }
    getCursorPos(pt)
    return { x: pt.x, y: pt.y }
  } catch {
    return { x: 0, y: 0 }
  }
}

/** Full end-time fact set: cursor + drop-target heuristics (T3 input). */
function readEndFacts(reason: 'hook' | 'dragwindow'): DragDetectEndFacts {
  const cursor = readCursor()
  const fg = getForegroundWindow ? getForegroundWindow() : null
  const fgPid = [0]
  if (fg && getWindowThreadProcessId) getWindowThreadProcessId(fg, fgPid)
  const fgExe = readExePath(fgPid[0]).replace(/^.*[\\/]/, '').toLowerCase()
  const curWnd = windowFromPoint ? windowFromPoint(cursor) : null
  let curClass = ''
  let curExe = ''
  if (curWnd) {
    curClass = readClassName(curWnd)
    const pid = [0]
    if (getWindowThreadProcessId) getWindowThreadProcessId(curWnd, pid)
    curExe = readExePath(pid[0]).replace(/^.*[\\/]/, '').toLowerCase()
  }
  return { reason, cursor, fgExe, fgClass: readClassName(fg), curClass, curExe }
}

// ---- session state (single drag session, dedup across both sources) ----
let active = false
/** Which source owns the current session ('hook' | 'poll'). */
let activeBy: 'hook' | 'poll' | null = null
let hookPtr: unknown = null
let pumpTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let activeEvents: DragDetectEvents | null = null

// The 0x0F source hwnd, captured inside the callback (koffi calls deferred —
// see file header) and consumed by the deferred classification.
let pendingStartHwnd: unknown = null

/**
 * Persistent trampoline — an auto-registered JS callback only lives for one
 * FFI call, but SetWinEventHook fires later; it must be koffi.register()ed
 * explicitly and kept alive. Body is PURE state capture: no koffi calls, no
 * event-broadcast (see file header for the freeze rationale).
 */
const winEventCb = koffi.register((_hook: unknown, event: number, hwnd: unknown, _idObject: number, _idChild: number, _idThread: number, _msTime: number): void => {
  if (event === EVENT_SYSTEM_DRAGDROPSTART) {
    pendingStartHwnd = hwnd
    defer(() => handleHookStart())
  } else if (event === EVENT_SYSTEM_DRAGDROPEND) {
    defer(() => handleHookEnd())
  }
}, winEventProto)

/** Run one tick later, outside the hook dispatch context. */
function defer(fn: () => void): void {
  setTimeout(fn, 0)
}

function handleHookStart(): void {
  if (active) return // another source already owns the session
  active = true
  activeBy = 'hook'
  const srcClass = readClassName(pendingStartHwnd)
  pendingStartHwnd = null
  const isFileDrag = FILE_DRAG_CLASSES.has(srcClass)
  if (DEBUG) console.log('[DragDetect] start srcClass=' + srcClass + ' isFile=' + isFileDrag)
  activeEvents?.onStart({ isFileDrag, srcClass, cursor: readCursor() })
}

function handleHookEnd(): void {
  if (!active) return
  active = false
  activeBy = null
  if (DEBUG) console.log('[DragDetect] end (hook)')
  activeEvents?.onEnd(readEndFacts('hook'))
}

function pollOnce(): void {
  if (!findWindowW) return
  try {
    const has = !!findWindowW('DragWindow', null)
    if (has && !dragWindowSeen) {
      dragWindowSeen = true
      if (!active) {
        active = true
        activeBy = 'poll'
        if (DEBUG) console.log('[DragDetect] start (DragWindow)')
        // No source window on this path — srcClass='' and isFileDrag=false;
        // the manager treats unknown-source drags as file drags (real data:
        // 0x0F never fires, so this poll path is the only start source).
        activeEvents?.onStart({ isFileDrag: false, srcClass: '', cursor: readCursor() })
      }
    } else if (!has && dragWindowSeen) {
      dragWindowSeen = false
      if (active && activeBy === 'poll') {
        active = false
        activeBy = null
        if (DEBUG) console.log('[DragDetect] end (DragWindow gone)')
        activeEvents?.onEnd(readEndFacts('dragwindow'))
      }
      // A hook-owned session ends on its own 0x10; the poll falling is
      // expected there and must not double-end.
    }
  } catch {
    // keep polling — a failed read must not kill the fallback
  }
}
let dragWindowSeen = false

const pumpMsg = { hwnd: null, message: 0, wParam: 0n, lParam: 0n, time: 0, pt_x: 0, pt_y: 0 }

/** Install the hook + pumps. Idempotent. */
export function startDragDetect(events: DragDetectEvents): void {
  if (!bindingsOk || pumpTimer !== null) return
  activeEvents = events
  if (setWinEventHook && winEventProto) {
    hookPtr = setWinEventHook(EVENT_SYSTEM_DRAGDROPSTART, EVENT_SYSTEM_DRAGDROPEND, null, winEventCb, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
    if (hookPtr) {
      console.log('[DragDetect] ✓ init complete (SetWinEventHook 0x0F/0x10 + pump + DragWindow poll)')
    } else {
      console.error('[DragDetect] SetWinEventHook failed — DragWindow poll only (degraded classification)')
    }
  }
  pumpTimer = setInterval(() => {
    if (!peekMessageW) return
    // Bounded drain: an unbounded while loop starves libuv timers under a
    // steady event stream (same reasoning as keyboardHook.ts).
    let n = 0
    while (peekMessageW(pumpMsg, null, 0, 0, PM_REMOVE) && n++ < PUMP_MAX_MSGS_PER_TICK) {
      // dispatch is done by the system; the hook callback runs inside peek
    }
  }, PUMP_MS)
  pollTimer = setInterval(pollOnce, DRAGWINDOW_POLL_MS)
  if (!hookPtr) console.log('[DragDetect] ✓ init complete (DragWindow poll only)')
}

/** Unhook, stop pumps, reset session. Idempotent. */
export function stopDragDetect(): void {
  if (pumpTimer !== null) {
    clearInterval(pumpTimer)
    pumpTimer = null
  }
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (hookPtr && unhookWinEvent) {
    unhookWinEvent(hookPtr)
    hookPtr = null
  }
  activeEvents = null
  active = false
  activeBy = null
  dragWindowSeen = false
  pendingStartHwnd = null
}
