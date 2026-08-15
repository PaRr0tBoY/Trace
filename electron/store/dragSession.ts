/**
 * Drag session state machine (T4b, ADR-0008).
 *
 * Decides panel expand/retract, indicator visibility and always-on-top
 * heartbeat pause from the drag facts defined in ADR-0008:
 * { isFileDrag, cursorInPanel, dragActive } plus the detection-zone fact
 * (user feedback 2026-08-14: a drag no longer pops the panel — a compact
 * indicator appears first, and the panel only expands once the cursor
 * enters the zone the expanded panel would occupy).
 * Pure logic, zero Electron imports — vitest-tested directly (same pattern
 * as keyboardHook.ts's state machine).
 *
 * Behavior contract (ticket #7, amended by real-drag data — ADR-0008 T4a,
 * and by the indicator rework — 2026-08-14):
 *   - A file drag starting with the panel closed shows the indicator and
 *     arms the detection zone (the screen space the expanded panel covers)
 *     instead of expanding. Entering the zone expands the panel; leaving it
 *     again does NOT retract — once expanded by a drag, the panel stays
 *     until the drag ends (user feedback: never collapse mid-drag, never
 *     double-expand into a ghost).
 *   - A drag that ends without the panel ever having expanded needs no
 *     retract. A drag that expanded the panel retracts it only when the
 *     cursor is outside the panel at end (the user dropped elsewhere or
 *     cancelled); a drop inside leaves it open.
 *   - A file drag starting with the panel already open (hover or another
 *     trigger) neither arms nor expands — that panel is the user's state,
 *     not the drag's, and the drag must not retract it.
 *   - Hook-classified non-file drags (a real source class outside the
 *     Explorer/desktop sets) never arm, never show the indicator.
 *   - The always-on-top heartbeat is paused for the whole drag (the
 *     SetWindowPos(HWND_TOPMOST) re-assert would push the panel in front of
 *     the DWM drag ghost) and resumed on end.
 *
 * The event source (SetWinEventHook 0x0F/0x10, with DragWindow polling as
 * fallback — both feed identical facts) lives in dragDetect.ts; the
 * detection-zone cursor facts are produced by dragManager.ts's drag-time
 * poll. This module only turns facts into commands. end reason is carried
 * but does not change panel commands — the success/cancel heuristic is
 * T3's territory.
 *
 * Timeout: a drag with no end signal for longer than timeoutMs is force-
 * ended (stuck OLE session, source app died, event eaten). The manager
 * schedules an explicit end(timeout); this module also re-checks on every
 * event so a late start cannot resurrect a stale session. Initial value
 * 30 000 ms, to be calibrated against real drag data (ADR-0008 T4a addendum
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
   * Whether this session expanded the panel itself (cursor entered the
   * detection zone). Once true the panel stays expanded until end — a
   * mid-drag exit never retracts it (user feedback 2026-08-14). If the
   * panel was already open when the drag started, this stays false and the
   * drag must not retract it — that is the user's state, not the drag's.
   */
  expandedByDrag: boolean
  /** Wall-clock of the drag start (timeout base). */
  startedAt: number
  /** Indicator visible: a file drag waits for the detection zone. */
  indicator: boolean
  /** Detection zone armed: cursor enters the expanded-panel space → expand. */
  armed: boolean
}

export type DragEndReason = 'hook' | 'dragwindow' | 'capture' | 'timeout'

export type DragSessionEvent =
  | { type: 'start'; isFileDrag: boolean; cursorInPanel: boolean; panelOpen: boolean }
  | { type: 'cursor'; inDropZone: boolean; cursorInPanel: boolean }
  | { type: 'end'; reason: DragEndReason; cursorInPanel: boolean }

export type DragCommand = 'expand' | 'retract' | 'show-indicator' | 'hide-indicator' | 'pause-heartbeat' | 'resume-heartbeat'

/** Timeout initial value — see file header; calibrate from real drag data. */
export const DRAG_SESSION_TIMEOUT_MS = 30000

export function initialDragSession(): DragSessionState {
  return { phase: 'idle', fileDrag: false, cursorInPanel: false, expandedByDrag: false, startedAt: 0, indicator: false, armed: false }
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
    if (s.indicator) commands.push('hide-indicator')
    if (s.fileDrag && s.expandedByDrag && !s.cursorInPanel) commands.push('retract')
    s = initialDragSession()
  }

  if (event.type === 'start') {
    // A start while a drag is still tracked means the previous session lost
    // its end signal — close it first, then begin the new one.
    if (s.phase === 'drag') {
      commands.push('resume-heartbeat')
      if (s.indicator) commands.push('hide-indicator')
      if (s.fileDrag && s.expandedByDrag && !s.cursorInPanel) commands.push('retract')
    }
    const isFile = event.isFileDrag
    // The detection zone only arms when the panel is closed and the drag is
    // a file drag; an open panel is the user's state and needs no zone.
    const armed = isFile && !event.panelOpen
    s = {
      phase: 'drag',
      fileDrag: isFile,
      cursorInPanel: event.cursorInPanel,
      expandedByDrag: false,
      startedAt: now,
      indicator: armed,
      armed
    }
    commands.push('pause-heartbeat')
    if (armed) commands.push('show-indicator')
    return { state: s, commands }
  }

  if (event.type === 'cursor') {
    if (s.phase !== 'drag') return { state: s, commands }
    s = { ...s, cursorInPanel: event.cursorInPanel }
    // Entering the armed detection zone expands the panel and locks it open
    // for the rest of the drag. Leaving the zone again never retracts.
    if (s.armed && event.inDropZone) {
      s = { ...s, armed: false, indicator: false, expandedByDrag: true }
      commands.push('expand')
      commands.push('hide-indicator')
    }
    return { state: s, commands }
  }

  // end
  if (s.phase === 'idle') return { state: s, commands } // stray end — ignore
  const wasFile = s.fileDrag
  const wasExpandedByDrag = s.expandedByDrag
  const indicatorWasUp = s.indicator
  s = initialDragSession()
  commands.push('resume-heartbeat')
  if (indicatorWasUp) commands.push('hide-indicator')
  if (wasFile && wasExpandedByDrag && !event.cursorInPanel) commands.push('retract')
  return { state: s, commands }
}
