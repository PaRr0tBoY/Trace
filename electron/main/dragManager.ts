/**
 * Main-process side of drag detection (T4b, ADR-0007).
 *
 * Forks the detector into a utilityProcess (dragHost.js) — see dragHost.ts
 * for why the hook must not run in the Electron main process. This module
 * bridges the host's facts into the dragSession state machine and executes
 * its commands:
 *
 *   expand  → open the panel (same triple as the panel:expand IPC handler:
 *             visible + interactive + renderer toggle)
 *   retract → window:toggle(false) — the renderer's App.tsx runs the normal
 *             close sequence (preview/flyout sequencing included)
 *   pause/resume-heartbeat → setHeartbeatPaused (the always-on-top re-assert
 *             would push the panel in front of the DWM drag ghost)
 *
 * It also schedules the end(timeout) fallback: a drag with no end signal for
 * DRAG_SESSION_TIMEOUT_MS is force-ended (stuck OLE session, eaten event).
 *
 * Every drag session pushes drag:active to the renderer — useEdgeHover must
 * not let the panel collapse mid-drag (cursor poll would otherwise close it
 * the moment the cursor crosses the blade edge).
 *
 * The end-time facts (fgExe/fgClass/curClass/curExe) are kept on
 * getLastDragEndFacts for T3's drop-success heuristic (ADR-0007 addendum
 * point 2); this module only consumes the end event itself.
 */
import { utilityProcess, screen } from 'electron'
import { join } from 'node:path'
import { getMainWindow, setInteractive, setVisible, setHeartbeatPaused, isInteractive } from './window'
import { pushState } from './state'
import {
  dragSessionTransition,
  initialDragSession,
  DRAG_SESSION_TIMEOUT_MS,
  type DragSessionState,
  type DragCommand
} from '../store/dragSession'
import type { DragDetectEndFacts } from './dragDetect'

interface HostStartMsg {
  type: 'start'
  isFileDrag: boolean
  srcClass: string
  cursor: { x: number; y: number }
}

interface HostEndMsg {
  type: 'end'
  reason: 'hook' | 'dragwindow'
  cursor: { x: number; y: number }
  fgExe: string
  fgClass: string
  curClass: string
  curExe: string
}

let child: Electron.UtilityProcess | null = null
let session: DragSessionState = initialDragSession()
let timeoutTimer: ReturnType<typeof setTimeout> | null = null
let lastEndFacts: DragDetectEndFacts | null = null

/** T3 input: drop-target heuristics of the last drag end (null = none yet). */
export function getLastDragEndFacts(): DragDetectEndFacts | null {
  return lastEndFacts
}

/** True while a drag session is tracked (poll fallback for other modules). */
export function isDragActive(): boolean {
  return session.phase === 'drag'
}

function cursorInPanelAt(pt: { x: number; y: number }): boolean {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return false
  const b = win.getBounds()
  return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height
}

function currentCursorInPanel(): boolean {
  return cursorInPanelAt(screen.getCursorScreenPoint())
}

function pushDragActive(active: boolean): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('drag:active', active)
  }
}

function applyCommands(commands: DragCommand[]): void {
  for (const cmd of commands) {
    switch (cmd) {
      case 'expand':
        // Same triple as the panel:expand IPC handler — visible so a hidden
        // window shows, interactive so the drop can land, renderer toggle so
        // the UI state (and its animations) follow.
        setVisible(true)
        setInteractive(true)
        pushState.togglePanel(true)
        break
      case 'retract':
        // The renderer's onToggle(false) runs the normal close sequence
        // (preview/flyout exit springs included).
        pushState.togglePanel(false)
        break
      case 'pause-heartbeat':
        setHeartbeatPaused(true)
        break
      case 'resume-heartbeat':
        setHeartbeatPaused(false)
        break
    }
  }
}

function clearTimeoutTimer(): void {
  if (timeoutTimer !== null) {
    clearTimeout(timeoutTimer)
    timeoutTimer = null
  }
}

function armTimeout(): void {
  clearTimeoutTimer()
  timeoutTimer = setTimeout(() => {
    timeoutTimer = null
    if (session.phase !== 'drag') return // real end already handled it
    const { state, commands } = dragSessionTransition(
      session,
      { type: 'end', reason: 'timeout', cursorInPanel: currentCursorInPanel() },
      Date.now()
    )
    session = state
    pushDragActive(false)
    applyCommands(commands)
    console.log('[DragDetect] drag force-ended after timeout')
  }, DRAG_SESSION_TIMEOUT_MS)
}

function handleStart(msg: HostStartMsg): void {
  const cursorInPanel = cursorInPanelAt(msg.cursor)
  // ADR-0007 fallback: a failed source-class read ('' — no source window on
  // the poll path either) treats "cursor in panel area" as a file drag.
  const isFileDrag = msg.isFileDrag || (msg.srcClass === '' && cursorInPanel)
  const { state, commands } = dragSessionTransition(
    session,
    { type: 'start', isFileDrag, cursorInPanel, panelOpen: isInteractive() },
    Date.now()
  )
  session = state
  pushDragActive(true)
  applyCommands(commands)
  armTimeout()
}

function handleEnd(msg: HostEndMsg): void {
  lastEndFacts = msg
  const { state, commands } = dragSessionTransition(
    session,
    { type: 'end', reason: msg.reason, cursorInPanel: cursorInPanelAt(msg.cursor) },
    Date.now()
  )
  session = state
  clearTimeoutTimer()
  pushDragActive(false)
  applyCommands(commands)
}

/** Fork the detector host and bridge its facts into the state machine. Idempotent. */
export function startDragDetect(): void {
  if (child) return
  try {
    child = utilityProcess.fork(join(__dirname, 'dragHost.js'), [], {
      serviceName: 'drag-detect',
      stdio: 'inherit'
    })
    child.on('message', (msg: unknown) => {
      const m = msg as HostStartMsg | HostEndMsg | null
      if (!m || typeof m !== 'object') return
      if (m.type === 'start') handleStart(m as HostStartMsg)
      else if (m.type === 'end') handleEnd(m as HostEndMsg)
    })
    child.on('exit', () => {
      child = null
      clearTimeoutTimer()
      session = initialDragSession()
      // Release the renderer's drag-lock too: if the host died mid-drag the
      // panel would otherwise never collapse (useEdgeHover refuses to close
      // while dragActive is stuck true).
      pushDragActive(false)
      console.log('[DragDetect] host exited — detection released')
    })
  } catch (err) {
    console.error('[DragDetect] failed to fork host — drag detection disabled:', err)
    child = null
  }
}

/** Kill the host (hooks die with it). Idempotent. */
export function stopDragDetect(): void {
  if (child) {
    child.kill()
    child = null
  }
  clearTimeoutTimer()
  session = initialDragSession()
}
