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
import { runtime } from './config'
import { snapshotWindows, type SwitcherWindow } from './windowSnapshot'
import { activateHwnd } from './windowSwitch'
import { releasePanelFocusNow, requestPanelFocus } from './focus'
import { isFullscreenAppActive } from './fullscreen'
import { setHookPinned } from './hookManager'
import { loadSettings } from '../store/settings'
import type { SwitcherEntryDto } from '../../shared/types'

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

function broadcast(channel: 'switcher:show' | 'switcher:select' | 'switcher:pin' | 'switcher:unpin' | 'switcher:hide', payload?: unknown): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (payload !== undefined) win.webContents.send(channel, payload)
  else win.webContents.send(channel)
}

/** First Tab press after Alt (keyboardHook onShow). Runs synchronously inside the hook callback. */
export function switcherShow(opts: { shiftDown: boolean }): void {
  if (active) return
  try {
    const entries = snapshotWindows()
    console.log('[Switcher] show: entries=' + entries.length, 'shift=' + opts.shiftDown)
    // Fewer than 2 entries: nothing to switch to (index 1 would be out of range).
    if (entries.length < 2) return
    windows = entries
    rows = buildRows(entries, loadSettings().switcherGroupWindows)
    selectedRow = opts.shiftDown ? rows.length - 1 : Math.min(1, rows.length - 1)
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

/** Force-end a session (timeout / error path) — never leave the panel pinned. */
function resetSession(): void {
  clearTimeout(sessionTimer)
  sessionTimer = undefined
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
  selectedRow = (selectedRow + delta + rows.length) % rows.length
  touchSession()
  console.log('[Switcher] advance to', selectedRow, 'of', rows.length)
  broadcast('switcher:select', selectedRow)
}

/** Mouse hover moved the highlight (renderer switcher:hover) — index is a z-order window index. */
export function switcherHover(index: number): void {
  if (!active) return
  const row = rowByIndex(index)
  if (!row) return
  selectedRow = rows.indexOf(row)
  touchSession()
}

/** Enter while armed (keyboardHook onPin): pin the session open for search. */
export function switcherPin(): void {
  if (!active) return
  setHookPinned(true)
  broadcast('switcher:pin')
  touchSession()
}

/** Any keydown while pinned: keep the safety timeout alive during typing. */
export function switcherTouch(): void {
  touchSession()
}

/** Esc in search mode (renderer): drop the session — TabTab's cancel. */
export function switcherCancel(): void {
  if (!active) return
  console.log('[Switcher] cancel (search Esc)')
  setHookPinned(false)
  resetSession()
}

/**
 * Execute the switch for the current highlight. Runs on Alt-up (onExecute),
 * a mouse click (switcher:click), or the search field's Enter. A grouped
 * row activates its most recent window (z-order first). Window activation
 * is deferred out of the hook callback so the OS keyboard processing is not
 * held up by SetForegroundWindow work.
 */
export function switcherExecute(): void {
  if (!active) return
  const target = rows[selectedRow]?.wins[0]
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
  selectedRow = rows.indexOf(row)
  switcherExecute()
}
