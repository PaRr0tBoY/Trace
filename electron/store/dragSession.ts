/**
 * Drag session state machine (T4b, ADR-0007).
 *
 * Decides panel expand/retract and always-on-top heartbeat pause from the
 * drag facts defined in ADR-0007: { isFileDrag, cursorInPanel, dragActive }.
 * Pure logic, zero Electron imports — vitest-tested directly (same pattern
 * as keyboardHook.ts's state machine).
 *
 * Behavior contract (ticket #7, amended by real-drag data — ADR-0007 T4a):
 *   - A file drag starting ANYWHERE on screen expands the panel — no edge
 *     dwell needed. The source window class (Explorer/desktop classes =
 *     file drag, everything else = not) classifies the drag; a failed class
 *     read ('' — every poll-path start, since 0x0F never fires on Windows)
 *     is treated as a file drag by the manager, so any OS drag pops the
 *     panel for the drop to land (T5/T7 depend on it).
 *   - Hook-classified non-file drags (a real source class outside the
 *     Explorer/desktop sets) NEVER expand the panel.
 *   - A drag that ends without ever reaching the panel retracts it again.
 *     A drag that ends with the cursor inside the panel leaves it open (the
 *     user just dropped something on it / is looking at it).
 *   - The always-on-top heartbeat is paused for the whole drag (the
 *     SetWindowPos(HWND_TOPMOST) re-assert would push the panel in front of
 *     the DWM drag ghost) and resumed on end.
 *
 * The event source (SetWinEventHook 0x0F/0x10, with DragWindow polling as
 * fallback — both feed identical facts) lives in dragDetect.ts; this module
 * only turns facts into commands. end reason is carried but does not change
 * panel commands — the success/cancel heuristic is T3's territory.
 *
 * Timeout: a drag with no end signal for longer than timeoutMs is force-
 * ended (stuck OLE session, source app died, event eaten). The manager
 * schedules an explicit end(timeout); this module also re-checks on every
 * event so a late start cannot resurrect a stale session. Initial value
 * 30 000 ms, to be calibrated against real drag data (ADR-0007 T4a addendum
 * forbids fixing it without measurements).
 */

export type DragSessionPhase = 'idle' | 'drag'

export interface DragSessionState {
  phase: DragSessionPhase
  /** Whether the in-flight drag is a file drag (Explorer / desktop source). */
  fileDrag: boolean
  /** Last known cursor-in-panel fact (retract decision at end). */
  cursorInPanel: boolean
  /**
   * Whether this session expanded the panel itself. If the panel was
   * already open (user hovered it open) the drag must not retract it —
   * that is the user's state, not the drag's.
   */
  expandedByDrag: boolean
  /** Wall-clock of the drag start (timeout base). */
  startedAt: number
}

export type DragEndReason = 'hook' | 'dragwindow' | 'capture' | 'timeout'

export type DragSessionEvent =
  | { type: 'start'; isFileDrag: boolean; cursorInPanel: boolean; panelOpen: boolean }
  | { type: 'end'; reason: DragEndReason; cursorInPanel: boolean }

export type DragCommand = 'expand' | 'retract' | 'pause-heartbeat' | 'resume-heartbeat'

/** Timeout initial value — see file header; calibrate from real drag data. */
export const DRAG_SESSION_TIMEOUT_MS = 30000

export function initialDragSession(): DragSessionState {
  return { phase: 'idle', fileDrag: false, cursorInPanel: false, expandedByDrag: false, startedAt: 0 }
}

/**
 * One transition: facts event in, next state + commands out.
 *
 * `now` is the caller's clock (Date.now()); `timeoutMs` defaults to the
 * calibration constant but is injectable for tests.
 */
export function dragSessionTransition(
  state: DragSessionState,
  event: DragSessionEvent,
  now: number,
  timeoutMs: number = DRAG_SESSION_TIMEOUT_MS
): { state: DragSessionState; commands: DragCommand[] } {
  let s = state
  const commands: DragCommand[] = []

  // Stale-session pre-check: the previous drag outlived its timeout and the
  // next event is not its end — force-close it before handling the event.
  if (s.phase === 'drag' && event.type !== 'end' && now - s.startedAt > timeoutMs) {
    commands.push('resume-heartbeat')
    if (s.fileDrag && s.expandedByDrag && !s.cursorInPanel) commands.push('retract')
    s = initialDragSession()
  }

  if (event.type === 'start') {
    // A start while a drag is still tracked means the previous session lost
    // its end signal — close it first, then begin the new one.
    if (s.phase === 'drag') {
      commands.push('resume-heartbeat')
      if (s.fileDrag && s.expandedByDrag && !s.cursorInPanel) commands.push('retract')
    }
    const isFile = event.isFileDrag
    s = {
      phase: 'drag',
      fileDrag: isFile,
      cursorInPanel: event.cursorInPanel,
      expandedByDrag: isFile && !event.panelOpen,
      startedAt: now
    }
    commands.push('pause-heartbeat')
    if (isFile && !event.panelOpen) commands.push('expand')
    return { state: s, commands }
  }

  // end
  if (s.phase === 'idle') return { state: s, commands } // stray end — ignore
  const wasFile = s.fileDrag
  const wasExpandedByDrag = s.expandedByDrag
  s = initialDragSession()
  commands.push('resume-heartbeat')
  if (wasFile && wasExpandedByDrag && !event.cursorInPanel) commands.push('retract')
  return { state: s, commands }
}
