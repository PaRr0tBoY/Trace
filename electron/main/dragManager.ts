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
import { completeAllInFlightDrags, type DragEndSignal } from './drag'
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
  reason: 'hook' | 'dragwindow' | 'capture'
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

function pushDragIndicator(show: boolean): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('drag:indicator', show)
  }
}

// Detection-zone poll: while an armed drag is in flight, sample the cursor
// against the panel window rect (the screen space the expanded panel covers).
// Entering it expands the panel; leaving it again never retracts (the state
// machine locks the expand until end).
const ZONE_POLL_MS = 16
let zoneTimer: ReturnType<typeof setInterval> | null = null

function stopZonePoll(): void {
  if (zoneTimer !== null) {
    clearInterval(zoneTimer)
    zoneTimer = null
  }
}

function startZonePoll(): void {
  stopZonePoll()
  zoneTimer = setInterval(() => {
    if (session.phase !== 'drag') {
      stopZonePoll()
      return
    }
    const pt = screen.getCursorScreenPoint()
    const inZone = cursorInPanelAt(pt)
    const { state, commands } = dragSessionTransition(
      session,
      { type: 'cursor', inDropZone: inZone, cursorInPanel: inZone },
      Date.now()
    )
    session = state
    if (commands.length > 0) applyCommands(commands)
  }, ZONE_POLL_MS)
}

// End-of-drag retract is deferred: a rapid re-drag right after the drop must
// not fight the collapse animation (double-panel ghost). A new start cancels
// the pending retract and the panel simply stays open.
const RETRACT_DELAY_MS = 250
let retractTimer: ReturnType<typeof setTimeout> | null = null

function clearRetractTimer(): void {
  if (retractTimer !== null) {
    clearTimeout(retractTimer)
    retractTimer = null
  }
}

function scheduleRetract(): void {
  clearRetractTimer()
  retractTimer = setTimeout(() => {
    retractTimer = null
    pushState.togglePanel(false)
  }, RETRACT_DELAY_MS)
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
        // Deferred so a re-drag within RETRACT_DELAY_MS cancels it (no
        // collapse/expand animation overlap → no ghost panel).
        scheduleRetract()
        break
      case 'show-indicator':
        pushDragIndicator(true)
        break
      case 'hide-indicator':
        pushDragIndicator(false)
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
    stopZonePoll()
    pushDragActive(false)
    applyCommands(commands)
    // T3 seam: no end signal ever arrived — decideDragEnd's elapsedMs branch
    // force-cancels records older than the timeout; younger records stay
    // pending and their own watchdog settles them later.
    completeAllInFlightDrags({ dragEndSeen: false, dragWindowGone: false })
    console.log('[DragDetect] drag force-ended after timeout')
  }, DRAG_SESSION_TIMEOUT_MS)
}

function handleStart(msg: HostStartMsg): void {
  const cursorInPanel = cursorInPanelAt(msg.cursor)
  // Real-drag data (ADR-0007 T4a + 2026-08-14 capture measurements): starts
  // come from the capture hook (OLE drags — ole32 captures the mouse to its
  // CLIPBRDWNDCLASS window) or the DragWindow poll, neither of which names
  // a source window the manager could classify; 0x0F never fires. Treating
  // unknown-source drags as non-file made the panel never expand — a drag
  // from Explorer stayed dead. Unknown-source drags now count as file drags:
  // the panel pops for any drag so the save zone can receive the drop
  // (T5/T7 need it too); hook-path starts keep the precise classification.
  const isFileDrag = msg.isFileDrag || msg.srcClass === ''
  const { state, commands } = dragSessionTransition(
    session,
    { type: 'start', isFileDrag, cursorInPanel, panelOpen: isInteractive() },
    Date.now()
  )
  session = state
  clearRetractTimer() // a re-drag cancels the pending end-of-drag retract
  pushDragActive(true)
  applyCommands(commands)
  if (state.armed) startZonePoll()
  armTimeout()
}

/** T3 seam input: the signal facts of one drag end (decideDragEnd consumes it). */
function dragEndSignal(msg: HostEndMsg): DragEndSignal {
  // hook end = 0x10 seen → success iff the cursor sits on an Explorer target
  // (decideDragEnd). dragwindow end = ghost vanished without 0x10 → cancel.
  // timeout end is built by armTimeout (neither flag set → elapsedMs verdict).
  return msg.reason === 'hook' || msg.reason === 'capture'
    ? { dragEndSeen: true, cursorClass: msg.curClass, cursorExe: msg.curExe }
    : { dragEndSeen: false, dragWindowGone: true, cursorClass: msg.curClass, cursorExe: msg.curExe }
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
  stopZonePoll()
  pushDragActive(false)
  applyCommands(commands)
  // T3 seam: settle every in-flight staged drag with this end's facts
  // (success → staged copy to Recycle Bin + entry removed; else stays
  // in-transit). No-op when nothing is staged.
  completeAllInFlightDrags(dragEndSignal(msg))
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
      stopZonePoll()
      clearRetractTimer()
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
  stopZonePoll()
  clearRetractTimer()
  session = initialDragSession()
}
