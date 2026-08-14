/**
 * Alt+Tab switcher controller (ADR-0005), main side.
 *
 * Session lifecycle: keyboardHook (in the utility-process host) drives
 * show/advance/execute; this controller owns the panel state, the window
 * snapshot, and the renderer broadcasts. Enter while armed pins the session
 * open (TabTab-style search mode): Alt-up no longer executes, keyboard
 * passes to the panel, and the renderer search field resolves the switch.
 *
 * Window grouping (setting switcherGroupWindows): multiple windows of the
 * same app collapse into one visible row carrying a count badge and the
 * drill-in window list. Row indices in DTOs stay in the ungrouped z-order
 * space so hover/click map straight back to the snapshot.
 */
import { getMainWindow, setInteractive, isInteractive } from './window'
import koffi from 'koffi'
import { app, screen } from 'electron'
import { runtime } from './config'
import { snapshotWindows, type SwitcherWindow } from './windowSnapshot'
import { activateHwnd } from './windowSwitch'
import { releasePanelFocusNow, requestPanelFocus } from './focus'
import { isFullscreenAppActive } from './fullscreen'
import { setHookPinned } from './hookManager'
import { loadSettings } from '../store/settings'
import type { SwitcherEntryDto } from '../../shared/types'

// user32 mouse glue for the search-field click fallback (see activatePanel).
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const user32 = koffi.load('user32.dll')
const getCursorPos = user32.func('bool GetCursorPos(void* lpPoint)')
const setCursorPos = user32.func('bool SetCursorPos(int x, int y)')
const mouseEvent = user32.func('void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, void* dwExtraInfo)')
// OS foreground handle — used to detect click-outside abandonment.
// Electron's focus events are NOT reliable here: a window activated via
// SetForegroundWindow (activateHwnd) reports isFocused()=true forever and
// never fires 'blur' when the OS foreground moves elsewhere (verified
// on-device). Only a real mouse-activated window (WM_MOUSEACTIVATE, i.e. the
// user clicking the search field) tracks focus correctly. The foreground
// watch below polls GetForegroundWindow directly instead — OS truth, not
// Electron's model.
const getForegroundWindow = user32.func('GetForegroundWindow', 'void *', [])

/**
 * Foreground-window watch for pinned search mode. click-outside must cancel
 * the session (like Esc), but it can only be detected via the OS foreground:
 * once the panel HAS been the foreground window, any switch away means the
 * user gave up on the switcher. A panel that never made it to the foreground
 * (activation failed) is left alone — the user may still click it manually.
 */
let fgWatchTimer: ReturnType<typeof setInterval> | null = null
let panelWasForeground = false
function startForegroundWatch(): void {
  if (fgWatchTimer) return
  panelWasForeground = false
  fgWatchTimer = setInterval(() => {
    if (!active) return
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    let fg: unknown
    try {
      fg = getForegroundWindow()
    } catch {
      return
    }
    const panelHwnd = koffi.decode(win.getNativeWindowHandle(), koffi.pointer('void'))
    if (fg === panelHwnd) {
      panelWasForeground = true
    } else if (panelWasForeground) {
      console.log('[Switcher] foreground left panel — cancel session')
      setHookPinned(false)
      resetSession()
    }
  }, 150)
}
function stopForegroundWatch(): void {
  if (fgWatchTimer) {
    clearInterval(fgWatchTimer)
    fgWatchTimer = null
  }
}

/** A visible switcher row: one window, or all windows of one app when grouped. */
interface Row {
  wins: SwitcherWindow[]
  /** Z-order index of the row's first window — the index reported in DTOs. */
  index: number
}

/**
 * Quick Alt+Tab tap (keyboardHook onTapExecute): switch to the next MRU
 * window directly, without showing the switcher UI — mirrors the native
 * tap behaviour (repeated taps flip between the two most recent windows).
 * Runs outside the hook callback, so the snapshot + activation are safe.
 */
export function switcherTapExecute(opts: { shiftDown: boolean }): void {
  if (active) return
  let entries: SwitcherWindow[] = []
  try {
    entries = snapshotWindows()
  } catch (err) {
    console.error('[Switcher] tap snapshot failed:', err)
  }
  if (entries.length < 2) return
  const target = entries[opts.shiftDown ? entries.length - 1 : 1]
  if (target?.hwnd) {
    setTimeout(() => {
      try {
        const ok = activateHwnd(target.hwnd)
        console.log('[Switcher] tap execute →', target.title, 'ok=' + ok)
      } catch (err) {
        console.error('[Switcher] tap activate failed:', err)
      }
    }, 0)
  }
}

let active = false
let windows: SwitcherWindow[] = []
let rows: Row[] = []
let selectedRow = 0
/** Exact window selection (z-order index into `windows`). Row-level for
 * keyboard advance; window-level for hover/click inside a drill group —
 * execute must activate the window the user actually picked, not always
 * the group's first. */
let selectedWin = 0
/** Panel interactivity before the session started — restored on exit. */
let prevInteractive = false
/** Safety net: a session must end (execute) within this window or it is reset. */
let sessionTimer: NodeJS.Timeout | undefined
// Long enough that a user holding Alt to browse the list never hits it; short
// enough that a stuck session (lost Alt-up) self-heals. Reset on any interaction.
const SESSION_TIMEOUT_MS = 30000

export function isSwitcherActive(): boolean {
  return active
}

/** Group the z-order snapshot into visible rows (one per app when enabled). */
function buildRows(ws: SwitcherWindow[], group: boolean): Row[] {
  if (!group) return ws.map((w) => ({ wins: [w], index: ws.indexOf(w) }))
  const byExe = new Map<string, SwitcherWindow[]>()
  for (const w of ws) {
    const key = w.exePath.toLowerCase()
    const list = byExe.get(key)
    if (list) list.push(w)
    else byExe.set(key, [w])
  }
  const out: Row[] = []
  for (const wins of byExe.values()) {
    out.push({ wins, index: ws.indexOf(wins[0]) })
  }
  return out
}

/** Find the row containing a window at z-order `index`; null when stale. */
function rowByIndex(index: number): Row | null {
  for (const row of rows) {
    for (const w of row.wins) {
      if (windows.indexOf(w) === index) return row
    }
  }
  return null
}

/** Select a row (and the exact window within it when hovering/clicking a drill sub-row). */
function selectRow(row: Row, winIndex?: number): void {
  selectedRow = rows.indexOf(row)
  selectedWin = winIndex ?? windows.indexOf(row.wins[0])
}

function winToDto(w: SwitcherWindow, index: number): SwitcherEntryDto {
  return { title: w.title, exePath: w.exePath, isCurrent: w.isCurrent, index }
}

function rowToDto(row: Row): SwitcherEntryDto {
  const first = row.wins[0]
  const dto = winToDto(first, row.index)
  if (row.wins.length > 1) {
    dto.groupCount = row.wins.length
    dto.windows = row.wins.map((w) => winToDto(w, windows.indexOf(w)))
  }
  return dto
}

function broadcast(channel: 'switcher:show' | 'switcher:select' | 'switcher:pin' | 'switcher:unpin' | 'switcher:hide' | 'switcher:control-key', payload?: unknown): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (payload !== undefined) win.webContents.send(channel, payload)
  else win.webContents.send(channel)
}

/** First Tab press after Alt (keyboardHook onShow). Runs synchronously inside the hook callback. */
export function switcherShow(opts: { shiftDown: boolean }): void {
  if (active) return
  ensureBlurWatch()
  try {
    const entries = snapshotWindows()
    console.log('[Switcher] show: entries=' + entries.length, 'shift=' + opts.shiftDown)
    // Fewer than 2 entries: nothing to switch to (index 1 would be out of range).
    if (entries.length < 2) return
    windows = entries
    rows = buildRows(entries, loadSettings().switcherGroupWindows)
    const initialRow = rows[opts.shiftDown ? rows.length - 1 : Math.min(1, rows.length - 1)]
    selectRow(initialRow)
    active = true
    prevInteractive = isInteractive()
    runtime.switcherActive = true
    // The hook callback must stay light: Electron window calls (setInteractive)
    // are deferred out of it — they may throw or re-enter the message loop
    // while the hook dispatch is on the stack. Broadcast is a plain
    // webContents.send, safe anywhere.
    broadcast('switcher:show', {
      entries: rows.map(rowToDto),
      selectedIndex: selectedRow
    })
    clearTimeout(sessionTimer)
    sessionTimer = setTimeout(resetSession, SESSION_TIMEOUT_MS)
    // Deferred window work (also keeps the hook callback lean).
    setTimeout(() => {
      if (!active) return
      setInteractive(true) // close click-through so the mouse can pick entries
      // Exclusive-fullscreen apps cover always-on-top windows; stealing the
      // foreground makes the fullscreen app exit fullscreen (like the native
      // switcher does) so the panel becomes visible. NOACTIVATE is stripped
      // and restored with the session.
      if (isFullscreenAppActive()) requestPanelFocus()
    }, 0)
  } catch (err) {
    // Never let an exception escape into the keyboard hook callback — the
    // hook chain would break and the switcher state would stay pinned.
    console.error('[Switcher] show failed:', err)
    resetSession()
  }
}

/**
 * Clicking any other window while the switcher owns the foreground (pinned
 * search mode) means the user gave up on the switcher — drop the session
 * like Esc. Bound once; the panel only has the foreground during a session
 * (NOACTIVATE otherwise), so blur only fires on real abandonment. execute
 * clears `active` first, so the deferred activation of the target window
 * can't trip it.
 */
let blurWatchBound = false
function ensureBlurWatch(): void {
  if (blurWatchBound) return
  blurWatchBound = true
  const win = getMainWindow()
  if (!win) return
  win.on('blur', () => {
    if (!active) return
    console.log('[Switcher] panel blurred — cancel session')
    setHookPinned(false)
    resetSession()
  })
}

/** Force-end a session (timeout / error path) — never leave the panel pinned. */
function resetSession(): void {
  clearTimeout(sessionTimer)
  sessionTimer = undefined
  stopForegroundWatch()
  const wasActive = active
  active = false
  runtime.switcherActive = false
  setHookPinned(false)
  if (wasActive) {
    broadcast('switcher:hide')
    releasePanelFocusNow()
    setInteractive(prevInteractive)
  }
}

/** Extend the safety net on user interaction (Tab/hover/click). */
function touchSession(): void {
  if (!active || !sessionTimer) return
  clearTimeout(sessionTimer)
  sessionTimer = setTimeout(resetSession, SESSION_TIMEOUT_MS)
}

/** Tab / Shift+Tab repeat (keyboardHook onAdvance). */
export function switcherAdvance(delta: 1 | -1): void {
  if (!active || rows.length === 0) return
  selectRow(rows[(selectedRow + delta + rows.length) % rows.length])
  touchSession()
  console.log('[Switcher] advance to', selectedRow, 'of', rows.length)
  broadcast('switcher:select', selectedRow)
}

/** Mouse hover moved the highlight (renderer switcher:hover) — index is a z-order window index. */
export function switcherHover(index: number): void {
  if (!active) return
  const row = rowByIndex(index)
  if (!row) return
  selectRow(row, index)
  touchSession()
}

/** Enter while armed (keyboardHook onPin): pin the session open for search. */
export function switcherPin(initialQuery?: string): void {
  if (!active) return
  setHookPinned(true)
  broadcast('switcher:pin', initialQuery)
  // The panel has been a non-activated NOACTIVATE window all session, so the
  // search input can't receive keys. requestPanelFocus strips NOACTIVATE and
  // calls win.focus() — but the foreground lock refuses that here (no click
  // ever granted this process input rights; keys went to the hook host).
  // Real activation happens on Alt-up (switcherPinReleased), see there.
  requestPanelFocus()
  touchSession()
  // click-outside detection: watch the OS foreground once pinned.
  startForegroundWatch()
}

/**
 * Is the panel the actual OS foreground window? win.isFocused() lies for
 * programmatically activated windows (Electron reports true while the OS
 * foreground never moved — foreground lock, verified on-device). Compare
 * GetForegroundWindow against the panel's own hwnd instead: OS truth.
 */
function isPanelForeground(): boolean {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return false
  try {
    const hwnd = koffi.decode(win.getNativeWindowHandle(), koffi.pointer('void'))
    return getForegroundWindow() === hwnd
  } catch {
    return false
  }
}

/**
 * Force the panel window into the foreground. Deferred exactly like
 * switcherExecute's activation: Alt-up leaves the system cleaning up menu
 * mode for a few milliseconds, during which foreground changes are still
 * refused. Three escalation steps, each verified against the OS foreground
 * (not Electron's isFocused, which reports success without the OS moving):
 *  1. activateHwnd — the AttachThreadInput + SetForegroundWindow path the
 *     switcher's own execute uses on every switch. Works for normal app
 *     windows; the Electron layered panel has refused it under a foreground
 *     lock (e.g. a fullscreen window holding the front).
 *  2. app.focus() — on Windows focuses the application's first window. This
 *     is the path that actually lands when the foreground lock is gone but
 *     SetForegroundWindow alone is refused (verified on the notes branch).
 *  3. Simulated click on the search field — reproduces the one activation
 *     path that is proven to work: a real click grants the process input
 *     rights and the system activates the window (WM_MOUSEACTIVATE). The
 *     cursor jumps for <100ms and returns; the click lands on the field,
 *     which is exactly where the user is about to type anyway.
 */
function activatePanel(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  setTimeout(() => {
    if (!active || win.isDestroyed()) return
    const hwnd = koffi.decode(win.getNativeWindowHandle(), koffi.pointer('void'))
    activateHwnd(hwnd)
    if (isPanelForeground()) return
    try {
      app.focus()
      win.focus()
    } catch {
      // fail silent — escalation continues
    }
    if (isPanelForeground()) return
    clickSearchField()
    // One retry: the first click can land before the window finished its
    // current resize/layout pass (the click would hit the wrong element).
    if (!isPanelForeground()) {
      setTimeout(() => {
        if (!active || win.isDestroyed() || isPanelForeground()) return
        clickSearchField()
      }, 150)
    }
  }, 0)
}

/**
 * Inject a click on the search field — the one activation path that is
 * proven to work: a real click grants the process input rights and the
 * system activates the window (WM_MOUSEACTIVATE). The cursor jumps for
 * <100ms and returns; the click lands on the field, which is exactly where
 * the user is about to type anyway.
 */
function clickSearchField(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    // Search field sits at the top of the switcher page (8px padding +
    // 32px field): click its center in physical pixels.
    const bounds = win.getContentBounds()
    const pt = screen.dipToScreenPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + 26 })
    const orig = Buffer.alloc(8) // POINT {x, y}
    if (!getCursorPos(orig)) return
    setCursorPos(pt.x, pt.y)
    mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, null)
    mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, null)
    setCursorPos(orig.readInt32LE(0), orig.readInt32LE(4))
    console.log(`[Switcher] panel activation: simulated click on search field (focused=${win.isFocused()})`)
  } catch (err) {
    console.error('[Switcher] panel activation fallback failed:', err)
  }
}

/**
 * Real Alt-up after pinning (keyboardHook onPinReleased). Pin happens while
 * Alt is still physically held, and Windows refuses foreground changes while
 * Alt is down; with Alt released the lock is gone and the panel finally
 * activates — click-outside (blur) and Esc then work without a manual
 * click, and the renderer's focus polling (which never gave up) lands.
 */
export function switcherPinReleased(): void {
  if (!active) return
  activatePanel()
}

/** Any keydown while pinned: keep the safety timeout alive during typing. */
export function switcherTouch(): void {
  touchSession()
  // Keydown reached the hook, so the user is typing — if the keystroke
  // isn't landing in the panel (activation failed), pull the foreground
  // back so the very next key reaches the search field.
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.isFocused()) return
  activatePanel()
}

/** Esc in search mode (renderer): drop the session — TabTab's cancel. */
export function switcherCancel(): void {
  if (!active) return
  console.log('[Switcher] cancel (search Esc)')
  setHookPinned(false)
  resetSession()
}

/**
/** Control key while pinned (keyboardHook onControlKey): the hook swallowed
 * the key because the panel window often isn't the OS foreground (so the
 * key would land in the window in front). Esc cancels outright; the rest
 * are resolved in the renderer (drill vs execute depends on local state).
 */
export function switcherControlKey(key: 'enter' | 'escape' | 'up' | 'down' | 'left' | 'right'): void {
  if (!active) return
  if (key === 'escape') {
    switcherCancel()
    return
  }
  broadcast('switcher:control-key', key)
}

/**
 * Left-button down while pinned (hook mouse-down). The panel often never
 * reaches the OS foreground, so focus-based click-outside detection can't
 * work; a click that lands outside the panel bounds means the user gave up
 * on the switcher — drop the session like Esc. The click target's own
 * activation is untouched (the mouse hook never swallows).
 */
export function switcherMouseDown(pt: { x: number; y: number }): void {
  if (!active) return
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    // Physical screen point vs the panel's screen rect (DIP→physical).
    const b = win.getBounds()
    const sr = screen.dipToScreenRect(win, b)
    if (pt.x >= sr.x && pt.x <= sr.x + sr.width && pt.y >= sr.y && pt.y <= sr.y + sr.height) return
    console.log('[Switcher] click outside panel — cancel session')
    setHookPinned(false)
    resetSession()
  } catch (err) {
    console.error('[Switcher] click-outside check failed:', err)
  }
}

/**
 * Execute the switch for the current highlight. Runs on Alt-up (onExecute),
 * a mouse click (switcher:click), or the search field's Enter. The exact
 * window the user picked (drill sub-row hover/click) wins over the row's
 * first window. Window activation is deferred out of the hook callback so
 * the OS keyboard processing is not held up by SetForegroundWindow work.
 */
export function switcherExecute(): void {
  if (!active) return
  const target = windows[selectedWin]
  const targetHwnd = target?.hwnd
  active = false
  runtime.switcherActive = false
  setHookPinned(false)
  clearTimeout(sessionTimer)
  sessionTimer = undefined
  broadcast('switcher:hide')
  console.log('[Switcher] execute →', target?.title ?? '(none)')
  releasePanelFocusNow()
  if (targetHwnd) {
    setTimeout(() => {
      try {
        // Window work is deferred out of the hook callback (setInteractive
        // may throw there; activation is also subject to the foreground lock
        // until the hook dispatch unwinds).
        setInteractive(prevInteractive)
        activateHwnd(targetHwnd)
      } catch {
        // fail silent — activation is best-effort
      }
    }, 0)
  } else {
    setTimeout(() => {
      try {
        setInteractive(prevInteractive)
      } catch {
        // fail silent
      }
    }, 0)
  }
}

/** Mouse click on entry `index` (renderer switcher:click): switch immediately. */
export function switcherClick(index: number): void {
  if (!active) return
  const row = rowByIndex(index)
  if (!row) return
  selectRow(row, index)
  switcherExecute()
}
