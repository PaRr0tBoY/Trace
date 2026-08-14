/**
 * Drag session state machine tests (T4b, ADR-0007).
 *
 * Contract under test (ticket #7):
 *   - file drag anywhere → expand
 *   - non-file drag → never expand
 *   - drag ending off-panel → retract; ending on-panel → keep open
 *   - panel the user opened herself is not retracted by a drag
 *   - heartbeat paused for the drag, resumed on end
 *   - timeout force-end; stray events ignored; no lost-end resurrection
 */
import { describe, it, expect } from 'vitest'
import {
  initialDragSession,
  dragSessionTransition,
  DRAG_SESSION_TIMEOUT_MS,
  type DragSessionState,
  type DragSessionEvent
} from '../electron/store/dragSession'

const T0 = 1_000_000

function step(state: DragSessionState, event: DragSessionEvent, now = T0): DragSessionState {
  return dragSessionTransition(state, event, now).state
}

function cmds(state: DragSessionState, event: DragSessionEvent, now = T0): string[] {
  return dragSessionTransition(state, event, now).commands
}

/** A drag started normally (file, panel closed, cursor anywhere). */
function startedFileDrag(now = T0): DragSessionState {
  return step(initialDragSession(), { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: false }, now)
}

describe('drag start', () => {
  it('file drag anywhere expands the panel and pauses the heartbeat', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: false }, T0)
    expect(r.commands).toEqual(['pause-heartbeat', 'expand'])
    expect(r.state.phase).toBe('drag')
    expect(r.state.fileDrag).toBe(true)
    expect(r.state.expandedByDrag).toBe(true)
  })

  it('file drag with the cursor already in the panel still expands', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: true, panelOpen: false }, T0)
    expect(r.commands).toEqual(['pause-heartbeat', 'expand'])
  })

  it('non-file drag never expands — heartbeat only', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0)
    expect(r.commands).toEqual(['pause-heartbeat'])
    expect(r.state.phase).toBe('drag')
    expect(r.state.fileDrag).toBe(false)
    expect(r.state.expandedByDrag).toBe(false)
  })

  it('file drag while the panel is already open does not re-expand (user state kept)', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: true }, T0)
    expect(r.commands).toEqual(['pause-heartbeat'])
    expect(r.state.expandedByDrag).toBe(false)
  })

  it('non-file drag with panel open: heartbeat only, no panel commands', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: true, panelOpen: true }, T0)
    expect(r.commands).toEqual(['pause-heartbeat'])
  })
})

describe('drag end', () => {
  it('file drag ending off-panel retracts and resumes the heartbeat', () => {
    const s = startedFileDrag()
    const r = dragSessionTransition(s, { type: 'end', reason: 'hook', cursorInPanel: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat', 'retract'])
    expect(r.state.phase).toBe('idle')
  })

  it('file drag ending on-panel keeps the panel open', () => {
    const s = startedFileDrag()
    const r = dragSessionTransition(s, { type: 'end', reason: 'hook', cursorInPanel: true }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat'])
    expect(r.state.phase).toBe('idle')
  })

  it('panel the user opened herself is not retracted by a drag end', () => {
    const s = step(initialDragSession(), { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: true }, T0)
    const r = dragSessionTransition(s, { type: 'end', reason: 'dragwindow', cursorInPanel: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat'])
  })

  it('non-file drag end never touches the panel', () => {
    const s = step(initialDragSession(), { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0)
    const r = dragSessionTransition(s, { type: 'end', reason: 'hook', cursorInPanel: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat'])
  })

  it('non-file drag end with cursor on-panel: heartbeat only', () => {
    const s = step(initialDragSession(), { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0)
    const r = dragSessionTransition(s, { type: 'end', reason: 'hook', cursorInPanel: true }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat'])
  })

  it('stray end while idle is ignored', () => {
    const r = dragSessionTransition(initialDragSession(), { type: 'end', reason: 'hook', cursorInPanel: false }, T0)
    expect(r.commands).toEqual([])
    expect(r.state.phase).toBe('idle')
  })

  it('end reason does not change panel commands (hook / dragwindow / timeout equivalent)', () => {
    for (const reason of ['hook', 'dragwindow', 'timeout'] as const) {
      const off = dragSessionTransition(startedFileDrag(), { type: 'end', reason, cursorInPanel: false }, T0 + 1000)
      expect(off.commands).toEqual(['resume-heartbeat', 'retract'])
      const on = dragSessionTransition(startedFileDrag(), { type: 'end', reason, cursorInPanel: true }, T0 + 1000)
      expect(on.commands).toEqual(['resume-heartbeat'])
    }
  })
})

describe('lost end / nesting / timeout', () => {
  it('a start while a drag is tracked closes the previous session first', () => {
    const s = startedFileDrag()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat', 'retract', 'pause-heartbeat'])
    expect(r.state.fileDrag).toBe(false)
  })

  it('stale drag force-ends on a late start (timeout pre-check)', () => {
    const s = startedFileDrag(T0)
    const late = T0 + DRAG_SESSION_TIMEOUT_MS + 1
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: false }, late)
    expect(r.commands).toEqual(['resume-heartbeat', 'retract', 'pause-heartbeat', 'expand'])
    expect(r.state.startedAt).toBe(late)
  })

  it('stale drag with cursor on-panel force-ends without retract', () => {
    const s = step(initialDragSession(), { type: 'start', isFileDrag: true, cursorInPanel: true, panelOpen: false }, T0)
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: true, panelOpen: false }, T0 + DRAG_SESSION_TIMEOUT_MS + 1)
    expect(r.commands).toEqual(['resume-heartbeat', 'pause-heartbeat', 'expand'])
  })

  it('a late end after timeout is a single normal end, no double commands', () => {
    const s = startedFileDrag(T0)
    const late = T0 + DRAG_SESSION_TIMEOUT_MS + 1
    const r = dragSessionTransition(s, { type: 'end', reason: 'timeout', cursorInPanel: false }, late)
    expect(r.commands).toEqual(['resume-heartbeat', 'retract'])
  })

  it('timeout boundary: exactly timeoutMs does not force-end', () => {
    const s = startedFileDrag(T0)
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0 + DRAG_SESSION_TIMEOUT_MS)
    expect(r.commands).toEqual(['resume-heartbeat', 'retract', 'pause-heartbeat'])
  })
})
