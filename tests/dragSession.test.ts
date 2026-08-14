/**
 * Drag session state machine tests (T4b, ADR-0007, amended 2026-08-14).
 *
 * Contract under test (ticket #7 + user feedback 2026-08-14):
 *   - file drag with panel closed → indicator + armed zone, NOT expand
 *   - cursor entering the armed zone → expand + hide indicator, locked
 *     until end (exiting the zone never retracts)
 *   - non-file drag → never arms, never expands
 *   - panel the user opened herself is not the drag's: no arm, no expand,
 *     no retract
 *   - drag end: expanded-by-drag + cursor off-panel → retract; otherwise no
 *     retract; indicator-only sessions just hide the indicator
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

/** A file drag started with the panel closed: armed, indicator up. */
function startedFileDrag(now = T0): DragSessionState {
  return step(initialDragSession(), { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: false }, now)
}

/** A file drag that already expanded the panel via the detection zone. */
function expandedFileDrag(now = T0): DragSessionState {
  return step(startedFileDrag(now), { type: 'cursor', inDropZone: true, cursorInPanel: true }, now + 1)
}

describe('drag start', () => {
  it('file drag with panel closed arms the zone and shows the indicator, does not expand', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: false }, T0)
    expect(r.commands).toEqual(['pause-heartbeat', 'show-indicator'])
    expect(r.state.phase).toBe('drag')
    expect(r.state.fileDrag).toBe(true)
    expect(r.state.expandedByDrag).toBe(false)
    expect(r.state.indicator).toBe(true)
    expect(r.state.armed).toBe(true)
  })

  it('file drag with the cursor already in the panel still arms (cursor event will expand)', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: true, panelOpen: false }, T0)
    expect(r.commands).toEqual(['pause-heartbeat', 'show-indicator'])
    expect(r.state.armed).toBe(true)
  })

  it('non-file drag never arms or shows the indicator — heartbeat only', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0)
    expect(r.commands).toEqual(['pause-heartbeat'])
    expect(r.state.phase).toBe('drag')
    expect(r.state.fileDrag).toBe(false)
    expect(r.state.expandedByDrag).toBe(false)
    expect(r.state.indicator).toBe(false)
    expect(r.state.armed).toBe(false)
  })

  it('file drag while the panel is already open does not arm (user state kept)', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: true }, T0)
    expect(r.commands).toEqual(['pause-heartbeat'])
    expect(r.state.armed).toBe(false)
    expect(r.state.indicator).toBe(false)
    expect(r.state.expandedByDrag).toBe(false)
  })

  it('non-file drag with panel open: heartbeat only, no panel commands', () => {
    const s = initialDragSession()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: true, panelOpen: true }, T0)
    expect(r.commands).toEqual(['pause-heartbeat'])
  })
})

describe('detection zone (cursor)', () => {
  it('entering the armed zone expands the panel, hides the indicator and locks it open', () => {
    const s = startedFileDrag()
    const r = dragSessionTransition(s, { type: 'cursor', inDropZone: true, cursorInPanel: true }, T0 + 1000)
    expect(r.commands).toEqual(['expand', 'hide-indicator'])
    expect(r.state.expandedByDrag).toBe(true)
    expect(r.state.armed).toBe(false)
    expect(r.state.indicator).toBe(false)
  })

  it('cursor outside the armed zone keeps the indicator up', () => {
    const s = startedFileDrag()
    const r = dragSessionTransition(s, { type: 'cursor', inDropZone: false, cursorInPanel: false }, T0 + 1000)
    expect(r.commands).toEqual([])
    expect(r.state.indicator).toBe(true)
    expect(r.state.armed).toBe(true)
    expect(r.state.expandedByDrag).toBe(false)
  })

  it('leaving the zone after expansion never retracts mid-drag', () => {
    const s = expandedFileDrag()
    const r = dragSessionTransition(s, { type: 'cursor', inDropZone: false, cursorInPanel: false }, T0 + 2000)
    expect(r.commands).toEqual([])
    expect(r.state.expandedByDrag).toBe(true)
  })

  it('cursor events do nothing when not armed (user-open panel or non-file drag)', () => {
    const s = step(initialDragSession(), { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: true }, T0)
    const r = dragSessionTransition(s, { type: 'cursor', inDropZone: true, cursorInPanel: true }, T0 + 500)
    expect(r.commands).toEqual([])
    expect(r.state.expandedByDrag).toBe(false)
  })

  it('cursor events while idle are ignored', () => {
    const r = dragSessionTransition(initialDragSession(), { type: 'cursor', inDropZone: true, cursorInPanel: true }, T0)
    expect(r.commands).toEqual([])
    expect(r.state.phase).toBe('idle')
  })
})

describe('drag end', () => {
  it('expanded-by-drag ending off-panel retracts and resumes the heartbeat', () => {
    const s = expandedFileDrag()
    const r = dragSessionTransition(s, { type: 'end', reason: 'hook', cursorInPanel: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat', 'retract'])
    expect(r.state.phase).toBe('idle')
  })

  it('expanded-by-drag ending on-panel keeps the panel open', () => {
    const s = expandedFileDrag()
    const r = dragSessionTransition(s, { type: 'end', reason: 'hook', cursorInPanel: true }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat'])
    expect(r.state.phase).toBe('idle')
  })

  it('an indicator-only drag (never expanded) ends without retract', () => {
    const s = startedFileDrag()
    const r = dragSessionTransition(s, { type: 'end', reason: 'hook', cursorInPanel: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat', 'hide-indicator'])
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
      const off = dragSessionTransition(expandedFileDrag(), { type: 'end', reason, cursorInPanel: false }, T0 + 1000)
      expect(off.commands).toEqual(['resume-heartbeat', 'retract'])
      const on = dragSessionTransition(expandedFileDrag(), { type: 'end', reason, cursorInPanel: true }, T0 + 1000)
      expect(on.commands).toEqual(['resume-heartbeat'])
    }
  })
})

describe('lost end / nesting / timeout', () => {
  it('a start while a drag is tracked closes the previous session first', () => {
    const s = startedFileDrag()
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat', 'hide-indicator', 'pause-heartbeat'])
    expect(r.state.fileDrag).toBe(false)
    expect(r.state.indicator).toBe(false)
  })

  it('a start while an expanded drag is tracked retracts before the new session when the cursor left the panel', () => {
    const s = step(expandedFileDrag(), { type: 'cursor', inDropZone: false, cursorInPanel: false }, T0 + 500)
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat', 'retract', 'pause-heartbeat'])
  })

  it('a start while an expanded drag is tracked keeps the panel when the cursor is still inside', () => {
    const s = expandedFileDrag() // cursorInPanel: true
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0 + 1000)
    expect(r.commands).toEqual(['resume-heartbeat', 'pause-heartbeat'])
  })

  it('stale drag force-ends on a late start (timeout pre-check)', () => {
    const s = startedFileDrag(T0)
    const late = T0 + DRAG_SESSION_TIMEOUT_MS + 1
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: false, panelOpen: false }, late)
    expect(r.commands).toEqual(['resume-heartbeat', 'hide-indicator', 'pause-heartbeat', 'show-indicator'])
    expect(r.state.startedAt).toBe(late)
  })

  it('stale expanded drag with cursor on-panel force-ends without retract', () => {
    const s = expandedFileDrag(T0)
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: true, cursorInPanel: true, panelOpen: false }, T0 + DRAG_SESSION_TIMEOUT_MS + 1)
    expect(r.commands).toEqual(['resume-heartbeat', 'pause-heartbeat', 'show-indicator'])
  })

  it('a late end after timeout is a single normal end, no double commands', () => {
    const s = expandedFileDrag(T0)
    const late = T0 + DRAG_SESSION_TIMEOUT_MS + 1
    const r = dragSessionTransition(s, { type: 'end', reason: 'timeout', cursorInPanel: false }, late)
    expect(r.commands).toEqual(['resume-heartbeat', 'retract'])
  })

  it('timeout boundary: exactly timeoutMs does not force-end', () => {
    const s = startedFileDrag(T0)
    const r = dragSessionTransition(s, { type: 'start', isFileDrag: false, cursorInPanel: false, panelOpen: false }, T0 + DRAG_SESSION_TIMEOUT_MS)
    expect(r.commands).toEqual(['resume-heartbeat', 'hide-indicator', 'pause-heartbeat'])
  })
})
