/**
 * Main-process side of the Alt+Tab hook (ADR-0005).
 *
 * Forks the keyboard hook into a utilityProcess (pure Node) — see hookHost.ts
 * for why the hook must not run in the Electron main process. This module only
 * bridges the host's messages to the switcher controller and owns the host's
 * lifecycle. A host crash does NOT restart it automatically: the OS unhooks
 * on process exit, so keyboard input is never at risk; the user just loses
 * the takeover until Trace restarts (the hook re-installs on next launch).
 */
import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { KeyboardHookEvents } from './keyboardHook'

let child: Electron.UtilityProcess | null = null

/** Fork the hook host and bridge its events. Idempotent. */
export function startKeyboardHook(events: KeyboardHookEvents): void {
  if (child) return
  try {
    child = utilityProcess.fork(join(__dirname, 'hookHost.js'), [], {
      serviceName: 'alt-tab-hook',
      stdio: 'inherit'
    })
    child.on('message', (msg: unknown) => {
      const m = msg as { type?: string; shiftDown?: boolean; delta?: 1 | -1; initialQuery?: string; key?: string; x?: number; y?: number } | null
      if (!m) return
      if (m.type === 'show') events.onShow({ shiftDown: m.shiftDown ?? false })
      else if (m.type === 'advance') events.onAdvance(m.delta === -1 ? -1 : 1)
      else if (m.type === 'execute') events.onExecute()
      else if (m.type === 'tap') events.onTapExecute({ shiftDown: m.shiftDown ?? false })
      else if (m.type === 'pin') events.onPin(m.initialQuery)
      else if (m.type === 'touch') events.onTouch()
      else if (m.type === 'pin-released') events.onPinReleased()
      else if (m.type === 'control-key') events.onControlKey((m.key ?? 'enter') as 'enter' | 'escape' | 'up' | 'down' | 'left' | 'right')
      else if (m.type === 'mouse-down' && typeof m.x === 'number' && typeof m.y === 'number') events.onMouseDown({ x: m.x, y: m.y })
    })
    child.on('exit', () => {
      child = null
      console.log('[Hook] host exited — Alt+Tab takeover released (system restored)')
    })
  } catch (err) {
    console.error('[Hook] failed to fork hook host — Alt+Tab takeover disabled:', err)
    child = null
  }
}

/** Kill the host (unhooks immediately). Idempotent. */
export function stopKeyboardHook(): void {
  if (child) {
    child.kill()
    child = null
  }
}

/** Push the pinned (search-mode) flag into the hook state machine. */
export function setHookPinned(pinned: boolean): void {
  child?.postMessage({ type: 'pin-state', pinned })
}

/**
 * Gate the mouse hook's click reporting on panel interactivity (see
 * keyboardHook.setMouseTracking). Idempotent; no-op before the host forks.
 */
export function setPanelInteractive(interactive: boolean): void {
  if (!child) return
  try {
    child.postMessage({ type: interactive ? 'panel-open' : 'panel-close' })
  } catch {
    // fail silent — click-outside detection degrades, panel behavior unchanged
  }
}
