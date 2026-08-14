/**
 * Staged drag-out decisions (ticket #6 / ADR-0007 M-a).
 *
 * Covers the two pure seams: planDragOut (per setting / kind / path
 * availability / in-transit state) and decideDragEnd (the T4a layered
 * drag-end heuristic), plus the settings clamp for moveMode, the
 * path-under-directory predicate, and the in-transit cleanup immunity the
 * feature relies on (locked against the domain's prune).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/types'
import { clampSettings } from '../electron/store/settingsClamp'
import { TransferStation } from '../electron/store/transferStation'
import {
  decideDragEnd,
  DEFAULT_DRAG_TIMEOUT_MS,
  EXPLORER_PROCESS,
  EXPLORER_WINDOW_CLASSES,
  isExplorerTarget,
  isPathUnder,
  planDragOut,
  type PlanDragOutInput
} from '../electron/store/stagedMove'

function input(overrides: Partial<PlanDragOutInput>): PlanDragOutInput {
  return {
    moveMode: 'move',
    kind: 'files',
    paths: ['C:\\src\\report.pdf'],
    exists: () => true,
    ...overrides
  }
}

describe('planDragOut — staging decision', () => {
  it('passes through in copy mode: original paths, entry and source untouched', () => {
    expect(planDragOut(input({ moveMode: 'copy' }))).toEqual({ action: 'pass-through' })
  })

  it('passes through non-file kinds even in move mode (text/image ride the temp-copy path)', () => {
    expect(planDragOut(input({ kind: 'text' }))).toEqual({ action: 'pass-through' })
    expect(planDragOut(input({ kind: 'image' }))).toEqual({ action: 'pass-through' })
    expect(planDragOut(input({ kind: 'image-collection' }))).toEqual({ action: 'pass-through' })
  })

  it('stages a files entry in move mode when every path exists', () => {
    expect(planDragOut(input({}))).toEqual({ action: 'stage', paths: ['C:\\src\\report.pdf'] })
  })

  it('skips when any path is missing — never drag a broken entry (spec story 20)', () => {
    const paths = ['C:\\src\\a.pdf', 'C:\\src\\b.pdf']
    const exists = (p: string) => p.endsWith('a.pdf')
    expect(planDragOut(input({ paths, exists }))).toEqual({ action: 'skip' })
  })

  it('skips when every path is missing', () => {
    expect(planDragOut(input({ exists: () => false }))).toEqual({ action: 'skip' })
  })

  it('skips an empty path list in move mode', () => {
    expect(planDragOut(input({ paths: [] }))).toEqual({ action: 'skip' })
  })

  it('stages an in-transit re-drag as-is (paths already staged; no-op restage)', () => {
    const staged = ['C:\\Users\\u\\AppData\\Roaming\\Trace\\station-stage\\report.pdf']
    expect(planDragOut(input({ paths: staged }))).toEqual({ action: 'stage', paths: staged })
  })

  it('skips an in-transit re-drag whose held file vanished', () => {
    expect(planDragOut(input({ exists: () => false }))).toEqual({ action: 'skip' })
  })
})

describe('decideDragEnd — T4a layered drag-end heuristic', () => {
  const base = { dragEndSeen: false, elapsedMs: 1000 }

  it('success: 0x10 seen with the cursor over an explorer window class', () => {
    for (const cls of EXPLORER_WINDOW_CLASSES) {
      expect(decideDragEnd({ ...base, dragEndSeen: true, cursorClass: cls })).toBe('success')
    }
  })

  it('success: 0x10 seen with the cursor over an explorer.exe process (case-insensitive)', () => {
    expect(decideDragEnd({ ...base, dragEndSeen: true, cursorExe: EXPLORER_PROCESS })).toBe('success')
    expect(decideDragEnd({ ...base, dragEndSeen: true, cursorExe: 'Explorer.EXE' })).toBe('success')
  })

  it('success: class wins even when the exe check fails (vice versa)', () => {
    expect(decideDragEnd({ ...base, dragEndSeen: true, cursorClass: 'CabinetWClass', cursorExe: 'chrome.exe' })).toBe('success')
    expect(decideDragEnd({ ...base, dragEndSeen: true, cursorClass: 'Chrome_WidgetWin_1', cursorExe: 'explorer.exe' })).toBe('success')
  })

  it('cancel: 0x10 seen but the cursor is over a non-explorer target (chat window, browser)', () => {
    expect(decideDragEnd({ ...base, dragEndSeen: true, cursorClass: 'Chrome_WidgetWin_1', cursorExe: 'chrome.exe' })).toBe('cancel')
    expect(decideDragEnd({ ...base, dragEndSeen: true, cursorClass: 'MSTaskSwWClass' })).toBe('cancel')
  })

  it('cancel: 0x10 seen but the cursor window class could not be read — never claim success without evidence', () => {
    expect(decideDragEnd({ ...base, dragEndSeen: true })).toBe('cancel')
  })

  it('cancel: DragWindow disappeared without 0x10 (Esc / release on empty space)', () => {
    expect(decideDragEnd({ ...base, dragWindowGone: true })).toBe('cancel')
  })

  it('cancel: no end evidence at all', () => {
    expect(decideDragEnd({ ...base, elapsedMs: 5_000 })).toBe('cancel')
  })

  it('watchdog: a drag stalled past the timeout is force-ended as cancel', () => {
    expect(decideDragEnd({ ...base, elapsedMs: DEFAULT_DRAG_TIMEOUT_MS - 1 })).toBe('cancel')
    expect(decideDragEnd({ ...base, elapsedMs: DEFAULT_DRAG_TIMEOUT_MS })).toBe('cancel')
    expect(decideDragEnd({ ...base, elapsedMs: DEFAULT_DRAG_TIMEOUT_MS + 60_000 })).toBe('cancel')
  })

  it('respects an explicit timeout override', () => {
    expect(decideDragEnd({ ...base, elapsedMs: 5_000, timeoutMs: 10_000 })).toBe('cancel')
    expect(decideDragEnd({ ...base, elapsedMs: 10_000, timeoutMs: 10_000 })).toBe('cancel')
  })
})

describe('isExplorerTarget', () => {
  it('matches explorer classes exactly and the explorer process case-insensitively', () => {
    expect(isExplorerTarget('CabinetWClass', undefined)).toBe(true)
    expect(isExplorerTarget(undefined, 'EXPLORER.EXE')).toBe(true)
    expect(isExplorerTarget('cabinetwclass')).toBe(false) // class names are case-sensitive
    expect(isExplorerTarget('', '')).toBe(false)
    expect(isExplorerTarget(undefined, undefined)).toBe(false)
    expect(isExplorerTarget('Shell_TrayWnd')).toBe(false) // taskbar is not a drop target
  })
})

describe('isPathUnder — self-drop guard predicate', () => {
  const stage = 'C:\\Users\\u\\AppData\\Roaming\\Trace\\station-stage'
  it('true for direct children, nested paths, mixed separators, different case', () => {
    expect(isPathUnder(stage, 'C:\\Users\\u\\AppData\\Roaming\\Trace\\station-stage\\report.pdf')).toBe(true)
    expect(isPathUnder(stage, 'c:/users/u/appdata/roaming/trace/station-stage/sub/x.txt')).toBe(true)
    expect(isPathUnder(stage, 'C:\\Users\\u\\AppData\\Roaming\\Trace\\station-stage')).toBe(true)
  })
  it('false for siblings and unrelated paths', () => {
    expect(isPathUnder(stage, 'C:\\Users\\u\\AppData\\Roaming\\Trace\\temp\\report.pdf')).toBe(false)
    expect(isPathUnder(stage, 'C:\\station-stage\\report.pdf')).toBe(false)
    expect(isPathUnder(stage, 'C:\\Users\\u\\AppData\\Roaming\\Trace\\station-stages')).toBe(false)
  })
})

describe('moveMode settings registration', () => {
  it('defaults to move', () => {
    expect(DEFAULT_SETTINGS.moveMode).toBe('move')
  })

  it('clamps garbage to move and preserves a valid copy', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS, moveMode: 'garbage' as never }).moveMode).toBe('move')
    expect(clampSettings({ ...DEFAULT_SETTINGS, moveMode: 'copy' }).moveMode).toBe('copy')
    expect(clampSettings({ ...DEFAULT_SETTINGS, moveMode: 'move' }).moveMode).toBe('move')
  })
})

describe('in-transit entries are immune to automatic cleanup (ADR-0007 §4)', () => {
  function makeStation() {
    const entries = [
      {
        id: 'e1',
        paths: ['C:\\staged\\held.pdf'],
        route: 'drag-in' as const,
        pinned: false,
        inTransit: true,
        capturedAt: Date.now() - 48 * 3600 * 1000,
        stats: { 'C:\\staged\\held.pdf': { exists: true, size: 10 } }
      },
      {
        id: 'e2',
        paths: ['C:\\staged\\old.pdf'],
        route: 'clipboard' as const,
        pinned: false,
        inTransit: false,
        capturedAt: Date.now() - 48 * 3600 * 1000,
        stats: { 'C:\\staged\\old.pdf': { exists: true, size: 10 } }
      }
    ]
    return { station: new TransferStation(), entries }
  }

  it('prune keeps the in-transit entry and evicts only the normal one', () => {
    const { station, entries } = makeStation()
    station.hydrate(entries)
    const pruned = station.prune(24)
    expect(pruned.map((e) => e.id)).toEqual(['e2'])
    expect(station.get('e1')).toBeDefined()
    expect(station.get('e1')?.inTransit).toBe(true)
    expect(station.get('e2')).toBeUndefined()
  })

  it('split/merge reject in-transit entries (they can only be re-dragged or deleted)', () => {
    const { station, entries } = makeStation()
    station.hydrate(entries)
    expect(station.split('e1', ['C:\\staged\\held.pdf'])).toEqual({ ok: false, reason: 'in-transit' })
    expect(station.merge('e1', 'e2')).toEqual({ ok: false, reason: 'in-transit' })
  })
})
