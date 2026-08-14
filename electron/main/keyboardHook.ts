/**
 * Alt+Tab takeover hook (ADR-0005).
 *
 * Why WH_KEYBOARD_LL and not Electron globalShortcut: Alt+Tab is a system
 * reserved hotkey — RegisterHotKey (globalShortcut's backend) fails to
 * register it. Low-level keyboard hooks fire in reverse install order, so
 * Trace (started after explorer.exe) sees the keys first; swallowing the Tab
 * key prevents the system switcher from ever appearing. Same technique as
 * AutoHotkey and Alt-Tab Terminator. Feasibility verified on-device
 * (record / swallow / control probe) before this module was written.
 *
 * State machine (all decisions live here, the UI only renders):
 *
 *   idle --Alt down--> altDown --Tab down--> armed (onShow)
 *   armed --Tab down--> advance(+1/-1)  (repeat presses advance per press)
 *   armed --Alt up--> execute + synthetic clean Alt up, back to idle
 *   altDown --Alt up--> idle (plain Alt press: no intervention)
 *
 * The physical Alt up inside an armed session is swallowed and replaced by a
 * synthetic clean Alt up (SendInput). Without the synthetic up the OS would
 * think Alt is still held; with the raw up it would see "Alt pressed and
 * released with nothing in between" and activate the foreground window's
 * menu bar. The synthetic up has no matching down, so no menu bar activation.
 *
 * The hook fires on the thread that registered it, driven by GetMessage /
 * PeekMessage — Node has no built-in message loop, so a 4ms PeekMessageW
 * pump (same pattern as fullscreen.ts) drives the callbacks.
 *
 * Only Tab / Shift+Tab are swallowed. Alt+F4, Alt+Space and every other
 * Alt combination pass through untouched.
 */
import koffi from 'koffi'

const WH_KEYBOARD_LL = 13
// Debug noise goes behind this switch (AGENTS.md logging rules).
const DEBUG = false
const WM_KEYDOWN = 0x100
const WM_KEYUP = 0x101
const WM_SYSKEYDOWN = 0x104
const WM_SYSKEYUP = 0x105
const VK_TAB = 0x09
const VK_MENU = 0x12
const VK_LMENU = 0xA4
const VK_RMENU = 0xA5
const VK_SHIFT = 0x10
const VK_RETURN = 0x0D
const KEYEVENTF_KEYUP = 0x0002
const PM_REMOVE = 0x0001
const INPUT_KEYBOARD = 0x0001

/** KBDLLHOOKSTRUCT — passed by pointer in lParam. */
const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32_t',
  scanCode: 'uint32_t',
  flags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
})

/** MSG for PeekMessageW. */
const MSG = koffi.struct('MSG', {
  hwnd: 'void *',
  message: 'uint32_t',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32_t',
  pt_x: 'int32_t',
  pt_y: 'int32_t'
})

/**
 * INPUT for SendInput. Measured on x64: the union is dominated by
 * MOUSEINPUT (32 bytes), so INPUT is 40 bytes — hand-laid with a tail field
 * to pad the union. wVk/wScan must be WORD (2 bytes each): with DWORD fields
 * the dwFlags slot shifts from offset 12 to 16 and every injected key-up
 * silently becomes a key-down (ERROR_INVALID_PARAMETER with 32-byte layout).
 */
const INPUT = koffi.struct('INPUT', {
  type: 'uint32_t',
  pad: 'uint32_t',
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
  mouseTail: 'uintptr_t'
})

type SetWindowsHookExWFn = (idHook: number, lpfn: unknown, hMod: unknown, dwThreadId: number) => unknown
type UnhookWindowsHookExFn = (hhk: unknown) => number
type CallNextHookExFn = (hhk: unknown, nCode: number, wParam: number, lParam: bigint) => bigint
type PeekMessageWFn = (msg: unknown, hWnd: unknown, min: number, max: number, remove: number) => number
type GetAsyncKeyStateFn = (vKey: number) => number
type SendInputFn = (cInputs: number, inputs: unknown, cbSize: number) => number

let setWindowsHookExW: SetWindowsHookExWFn | null = null
let unhookWindowsHookEx: UnhookWindowsHookExFn | null = null
let callNextHookEx: CallNextHookExFn | null = null
let peekMessageW: PeekMessageWFn | null = null
let getAsyncKeyState: GetAsyncKeyStateFn | null = null
let sendInput: SendInputFn | null = null

if (process.platform === 'win32') {
  try {
    const user32 = koffi.load('user32.dll')
    const kbProc = koffi.pointer(koffi.proto('intptr_t (int nCode, uintptr_t wParam, intptr_t lParam)'))
    setWindowsHookExW = user32.func('SetWindowsHookExW', 'void *', ['int', kbProc, 'void *', 'uint32_t'])
    unhookWindowsHookEx = user32.func('UnhookWindowsHookEx', 'int', ['void *'])
    callNextHookEx = user32.func('CallNextHookEx', 'intptr_t', ['void *', 'int', 'uintptr_t', 'intptr_t'])
    peekMessageW = user32.func('PeekMessageW', 'int', [koffi.pointer(MSG), 'void *', 'uint32_t', 'uint32_t', 'uint32_t'])
    getAsyncKeyState = user32.func('GetAsyncKeyState', 'int16_t', ['int'])
    sendInput = user32.func('SendInput', 'uint32_t', ['uint32_t', 'INPUT *', 'int'])
  } catch (err) {
    console.error('[Hook] koffi user32 load failed — Alt+Tab takeover disabled:', err)
  }
}

export interface KeyboardHookEvents {
  /** First Tab press after Alt: the switcher should appear. shiftDown = initial selection hint (last item). */
  onShow: (opts: { shiftDown: boolean }) => void
  /** Tab repeat press: move the highlight. delta is +1 or -1. */
  onAdvance: (delta: 1 | -1) => void
  /** Alt released during an armed session: switch to the highlighted item. */
  onExecute: () => void
  /** Quick Alt+Tab tap (Tab released inside the threshold): switch directly, no UI. */
  onTapExecute: (opts: { shiftDown: boolean }) => void
  /** Enter while the switcher is armed: pin it open and enter search mode (TabTab-style). */
  onPin: (initialQuery?: string) => void
  /** Any keydown while pinned — keeps the session's safety timeout alive during typing. */
  onTouch: () => void
  /**
   * Real Alt-up while pinned: the OS Alt state is already released by the
   * synthetic up, and the foreground lock is gone — the panel can finally
   * be activated (pin itself happens while Alt is still held, when
   * SetForegroundWindow is refused).
   */
  onPinReleased: () => void
}

type HookState = 'idle' | 'altDown' | 'pending' | 'tap' | 'armed' | 'pinned'

// Tab held this long (before key-repeat kicks in at ~500ms) counts as "hold"
// → show the switcher. Released sooner = a quick tap → switch directly, like
// the native Alt+Tab, without flashing the switcher UI.
const TAP_THRESHOLD_MS = 50

let state: HookState = 'idle'
let hookPtr: unknown = null
let pumpTimer: ReturnType<typeof setInterval> | null = null
let activeEvents: KeyboardHookEvents | null = null
let tapTimer: ReturnType<typeof setTimeout> | null = null

// Persistent trampoline: an auto-registered JS callback only lives for the
// duration of one FFI call, but SetWindowsHookExW fires the callback later —
// it must be koffi.register()ed explicitly and kept alive.
//
// The callback is PURE state machine: it runs inside the OS hook dispatch
// (inside whatever GetMessage loop picks the hook message — our pump or
// Chromium's). No koffi FFI calls, no SendInput, no Electron APIs, no
// event-broadcast here: those caused a hard freeze in Electron (the hook
// dispatch context holds Chromium locks; koffi/Electron re-entry deadlocks).
// All side effects are deferred to a plain setTimeout(0) — ~1ms later, far
// inside the ~30ms physical Tab-repeat interval, so no events are lost.
const kbPtr = koffi.register((nCode: number, wParam: number, lParam: bigint): bigint => {
  if (nCode >= 0 && hookPtr && callNextHookEx) {
    const isKeyMsg = wParam === WM_KEYDOWN || wParam === WM_KEYUP || wParam === WM_SYSKEYDOWN || wParam === WM_SYSKEYUP
    if (isKeyMsg) {
      const k = koffi.decode(lParam, KBDLLHOOKSTRUCT)
      const vk = k.vkCode
      const isDown = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN
      const isAlt = vk === VK_MENU || vk === VK_LMENU || vk === VK_RMENU
      const isTab = vk === VK_TAB
      const isReturn = vk === VK_RETURN
      if (DEBUG) console.log('[Hook]', 'wParam=' + wParam, 'vk=' + vk.toString(16), 'state=' + state)

      if (state === 'idle') {
        if (isAlt && isDown) state = 'altDown'
      } else if (state === 'altDown') {
        if (isTab && isDown) {
          state = 'pending'
          tapTimer = setTimeout(() => {
            tapTimer = null
            if (state === 'pending') {
              // Held past the threshold: show the switcher (repeat would fire
              // at ~500ms, this is faster).
              state = 'armed'
              defer(() => activeEvents?.onShow({ shiftDown: isShiftDown() }))
            }
          }, TAP_THRESHOLD_MS)
          return 1n // swallow the first Tab
        }
        if (isAlt && !isDown) state = 'idle' // plain Alt press — hands off
      } else if (state === 'pending') {
        // A second Tab down inside the threshold means the user is holding it.
        if (isTab && isDown) {
          clearTapTimer()
          state = 'armed'
          defer(() => activeEvents?.onShow({ shiftDown: isShiftDown() }))
          return 1n
        }
        if (isTab && !isDown) {
          // Quick tap: released inside the threshold — switch directly, no UI.
          clearTapTimer()
          state = 'tap'
          return 1n
        }
        if (isAlt && !isDown) {
          // Alt released while Tab is still down: the gesture is a tap — the
          // native switcher switches on Alt-up regardless of Tab's own up
          // timing (fast presses release Alt before Tab). Execute the tap.
          clearTapTimer()
          state = 'idle'
          defer(() => {
            sendSyntheticAltUp()
            activeEvents?.onTapExecute({ shiftDown: isShiftDown() })
          })
          return 1n
        }
      } else if (state === 'tap') {
        if (isTab && isDown) {
          // Second Tab tap while still holding Alt: fall back to the switcher.
          state = 'armed'
          defer(() => activeEvents?.onShow({ shiftDown: isShiftDown() }))
          return 1n
        }
        if (isAlt && !isDown) {
          state = 'idle'
          defer(() => {
            sendSyntheticAltUp()
            activeEvents?.onTapExecute({ shiftDown: isShiftDown() })
          })
          return 1n
        }
      } else if (state === 'armed') {
        if (isTab && isDown) {
          defer(() => activeEvents?.onAdvance(isShiftDown() ? -1 : 1))
          return 1n
        }
        if (isTab && !isDown) return 1n // swallow Tab up — no ghost Tab for the OS
        if (isReturn && isDown) {
          // Enter pins the switcher open and enters search mode (TabTab
          // pattern): Alt-up must NOT execute, keyboard passes to the panel.
          state = 'pinned'
          defer(() => activeEvents?.onPin())
          return 1n
        }
        if (isDown && isPrintableVk(vk)) {
          // Type-to-search: any printable key while armed pins the session
          // and seeds the search field with that first character. The key
          // is swallowed — the panel isn't focused yet, so passing it
          // through would deliver it to the window in front; the character
          // rides along in the pin message instead.
          state = 'pinned'
          defer(() => activeEvents?.onPin(vkToChar(vk, isShiftDown()) ?? undefined))
          return 1n
        }
        if (isAlt && !isDown) {
          state = 'idle'
          defer(() => {
            sendSyntheticAltUp()
            activeEvents?.onExecute()
          })
          return 1n // swallow the raw Alt up; the synthetic one is clean
        }
      } else if (state === 'pinned') {
        // Pinned search mode: everything passes through to the focused panel
        // input (search field handles Enter/Esc/arrows itself). Only Alt-up
        // is special — it must not execute the switch (that's the point of
        // pinning). Touch the session on keydown so long typing sessions
        // don't hit the 30s self-heal timeout.
        //
        // Tab stays swallowed (up and down): the user pinned while still
        // holding Alt+Tab, and passing Tab repeats through would let the OS
        // see a live Alt+Tab combination and switch the foreground away —
        // the panel input then never receives a key.
        if (isTab) return 1n
        if (isAlt && !isDown) {
          state = 'idle'
          // The real Alt-up is swallowed so no switch executes — but without
          // a synthetic up the OS keeps Alt held, and every later letter is
          // treated as an Alt-combo that never reaches the panel input. The
          // foreground lock is gone once Alt is up — that's when the panel
          // can finally be activated (see onPinReleased).
          defer(() => {
            sendSyntheticAltUp()
            activeEvents?.onPinReleased()
          })
          return 1n
        }
        if (isDown) defer(() => activeEvents?.onTouch())
      }
    }
  }
  return callNextHookEx ? callNextHookEx(hookPtr, nCode, wParam, lParam) : 1n
}, koffi.pointer(koffi.proto('intptr_t (int nCode, uintptr_t wParam, intptr_t lParam)')))

function sendSyntheticAltUp(): void {
  if (!sendInput) return
  try {
    sendInput(1, [{ type: INPUT_KEYBOARD, wVk: VK_MENU, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0n }], koffi.sizeof(INPUT))
  } catch {
    // fail silent — worst case the OS briefly thinks Alt is held
  }
}

/** Run one tick later, outside the OS hook dispatch context. */
function defer(fn: () => void): void {
  setTimeout(fn, 0)
}

function clearTapTimer(): void {
  if (tapTimer) {
    clearTimeout(tapTimer)
    tapTimer = null
  }
}

/** Alt is still held when the deferred handler runs — Shift state is stable. */
function isShiftDown(): boolean {
  return getAsyncKeyState ? (getAsyncKeyState(VK_SHIFT) & 0x8000) !== 0 : false
}

// US-layout virtual-key → character mapping for the "type to search while
// Alt+Tab is still held" entry (TabTab pattern). Letters and digits cover
// every real-world case; symbol rows are a best-effort bonus.
const SHIFTED_DIGITS: Record<number, string> = { 0x30: '!', 0x31: '@', 0x32: '#', 0x33: '$', 0x34: '%', 0x35: '^', 0x36: '&', 0x37: '*', 0x38: '(', 0x39: ')' }
const SHIFTED_SYMBOLS: Record<number, string> = { 0xBA: ':', 0xBB: '+', 0xBC: '<', 0xBD: '_', 0xBE: '>', 0xBF: '?', 0xC0: '~', 0xDB: '{', 0xDC: '|', 0xDD: '}', 0xDE: '"' }
const PLAIN_SYMBOLS: Record<number, string> = { 0xBA: ';', 0xBB: '=', 0xBC: ',', 0xBD: '-', 0xBE: '.', 0xBF: '/', 0xC0: '`', 0xDB: '[', 0xDC: '\\', 0xDD: ']', 0xDE: "'" }

/** True for keys that should start search when pressed while armed. */
function isPrintableVk(vk: number): boolean {
  if (vk === 0x20) return true // space
  if (vk >= 0x30 && vk <= 0x39) return true // digits
  if (vk >= 0x41 && vk <= 0x5A) return true // letters
  return vk in PLAIN_SYMBOLS
}

/** vkCode → display character (US layout), or null. */
function vkToChar(vk: number, shift: boolean): string | null {
  if (vk === 0x20) return ' '
  if (vk >= 0x30 && vk <= 0x39) return shift ? SHIFTED_DIGITS[vk] : String.fromCharCode(vk)
  if (vk >= 0x41 && vk <= 0x5A) return shift ? String.fromCharCode(vk) : String.fromCharCode(vk + 32)
  return shift ? (SHIFTED_SYMBOLS[vk] ?? null) : (PLAIN_SYMBOLS[vk] ?? null)
}

const pumpMsg = { hwnd: null, message: 0, wParam: 0n, lParam: 0n, time: 0, pt_x: 0, pt_y: 0 }

/** Start the hook and its message pump. Idempotent. */
export function startKeyboardHook(events: KeyboardHookEvents): void {
  if (!setWindowsHookExW || pumpTimer !== null) return
  activeEvents = events
  hookPtr = setWindowsHookExW(WH_KEYBOARD_LL, kbPtr, null, 0)
  if (!hookPtr) {
    console.error('[Hook] SetWindowsHookExW failed — Alt+Tab takeover disabled')
    return
  }
  pumpTimer = setInterval(() => {
    if (peekMessageW) {
      // Bounded drain: an unbounded while loop starves libuv timers while
      // key-repeat messages keep arriving (the Tap/hold timer must fire on
      // schedule, not whenever the key stream stops). 8 msgs/tick at 4ms is
      // far above any real key rate, so nothing is dropped.
      let n = 0
      while (peekMessageW(pumpMsg, null, 0, 0, PM_REMOVE) && n++ < 8) {
        // dispatch is done by the system; the hook callback runs inside peek
      }
    }
  }, 4)
  console.log('[Hook] ✓ WH_KEYBOARD_LL installed (Alt+Tab takeover active)')
}

/**
 * Pin/unpin the hook state machine (TabTab-style search mode, driven from
 * main via the hook host). Pinned: Alt-up does not execute; every key
 * passes through to the focused panel. Unpinning returns to armed while Alt
 * is still held (user can keep cycling), else idle.
 */
export function setPinned(pinned: boolean): void {
  if (pinned) {
    clearTapTimer()
    state = 'pinned'
  } else if (state === 'pinned') {
    state = getAsyncKeyState && (getAsyncKeyState(VK_MENU) & 0x8000) !== 0 ? 'armed' : 'idle'
  }
}

/** Unhook and stop the pump. The OS Alt+Tab returns instantly. */
export function stopKeyboardHook(): void {
  if (pumpTimer !== null) {
    clearInterval(pumpTimer)
    pumpTimer = null
  }
  if (hookPtr && unhookWindowsHookEx) {
    unhookWindowsHookEx(hookPtr)
    hookPtr = null
  }
  activeEvents = null
  state = 'idle'
  clearTapTimer()
}
