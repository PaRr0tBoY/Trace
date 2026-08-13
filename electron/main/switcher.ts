/**
 * Alt+Tab switcher controller (ADR-0005), main side.
 *
 * The keyboard state machine (keyboardHook.ts) drives this module:
 *
 *   onShow  → snapshot windows, force the panel interactive, broadcast the
 *             list. The ring starts at the current window (index 0); the
 *             initial highlight is index 1 (next MRU) or the last entry
 *             when Shift is held (native Alt+Shift+Tab behaviour).
 *   onAdvance → move the highlight (repeat Tab presses step per press).
 *   onExecute → activate the highlighted window and restore the panel.
 *
 * Mouse: the renderer syncs hover highlights back via switcher:hover and
 * clicks via switcher:click (click = execute immediately, like the native
 * switcher). All selection state lives here so Alt-up always switches to
 * what the user last highlighted, keyboard or mouse.
 *
 * The switcher is a mode, not a view: it swaps the whole panel page for its
 * duration and restores the previous panel state (interactivity, renderer
 * open state) on exit.
 */
import { getMainWindow, setInteractive, isInteractive } from './window'
import { requestPanelFocus, releasePanelFocusNow } from './focus'
import { activateHwnd } from './windowSwitch'
import { snapshotWindows, type SwitcherWindow } from './windowSnapshot'
import { runtime } from './config'
import { isFullscreenAppActive } from './fullscreen'
import type { SwitcherEntryDto } from '../../shared/types'

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
let selectedIndex = 1
/** Panel interactivity before the session started — restored on exit. */
let prevInteractive = false
/** Safety net: a session must end (execute) within this window or it is reset. */
let sessionTimer: ReturnType<typeof setTimeout> | null = null
// Long enough that a user holding Alt to browse the list never hits it; short
// enough that a stuck session (lost Alt-up) self-heals. Reset on any interaction.
const SESSION_TIMEOUT_MS = 30000

export function isSwitcherActive(): boolean {
  return active
}

function toDto(w: SwitcherWindow): SwitcherEntryDto {
  return { title: w.title, exePath: w.exePath, isCurrent: w.isCurrent }
}

function broadcast(channel: 'switcher:show' | 'switcher:select' | 'switcher:hide', payload?: unknown): void {
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
    selectedIndex = opts.shiftDown ? windows.length - 1 : 1
    active = true
    prevInteractive = isInteractive()
    runtime.switcherActive = true
    // The hook callback must stay light: Electron window calls (setInteractive)
    // are deferred out of it — they may throw or re-enter the message loop
    // while the hook dispatch is on the stack. Broadcast is a plain
    // webContents.send, safe anywhere.
    broadcast('switcher:show', {
      entries: windows.map(toDto),
      selectedIndex
    })
    if (sessionTimer) clearTimeout(sessionTimer)
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
  if (sessionTimer) {
    clearTimeout(sessionTimer)
    sessionTimer = null
  }
  const wasActive = active
  active = false
  runtime.switcherActive = false
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
  if (!active || windows.length === 0) return
  selectedIndex = (selectedIndex + delta + windows.length) % windows.length
  touchSession()
  console.log('[Switcher] advance to', selectedIndex, 'of', windows.length)
  broadcast('switcher:select', selectedIndex)
}

/** Mouse hover moved the highlight (renderer switcher:hover). */
export function switcherHover(index: number): void {
  if (!active || index < 0 || index >= windows.length) return
  selectedIndex = index
  touchSession()
}

/**
 * Execute the switch for the current highlight. Runs on Alt-up (onExecute),
 * a mouse click (switcher:click), or after a click-only hover session.
 * Window activation is deferred out of the hook callback so the OS keyboard
 * processing is not held up by SetForegroundWindow work.
 */
export function switcherExecute(): void {
  if (!active) return
  const target = windows[selectedIndex]
  const targetHwnd = target?.hwnd
  active = false
  runtime.switcherActive = false
  if (sessionTimer) {
    clearTimeout(sessionTimer)
    sessionTimer = null
  }
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
  if (!active || index < 0 || index >= windows.length) return
  selectedIndex = index
  switcherExecute()
}
