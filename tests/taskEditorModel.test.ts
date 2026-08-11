import { describe, expect, it } from 'vitest'

import {
  buildClipboardRows,
  canSaveTaskForm,
  clipboardPreview,
  fallbackTaskTitle,
  revealStepForApps,
  CLIPBOARD_ANCHOR_COUNT,
  CLIPBOARD_MAX_ROWS,
  type ClipboardRow
} from '../src/lib/taskEditor'
import type { ClipboardItemDto, ResourceSnapshot } from '../shared/types'

function item(id: string, capturedAt: number, sourceApp?: ClipboardItemDto['sourceApp']): ClipboardItemDto {
  return { id, data: { kind: 'text', text: `text-${id}`, isUrl: false }, capturedAt, hitCount: 1, pinned: false, sourceApp }
}

const CHROME = { name: 'Chrome', exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
const CODE = { name: 'Code', exePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' }

/** Key of the app identity rule (AppRef.id semantics) — mirrors the shared normalize. */
const key = (exePath: string) => exePath.trim().toLowerCase().replace(/\\/g, '/')

const snapshot = (preview: string): ResourceSnapshot => ({ type: 'text', preview, capturedAt: 1 })

describe('buildClipboardRows', () => {
  it('shows the 3 most recent items as anchors when nothing is selected', () => {
    const items = [
      item('a', 300, CHROME),
      item('b', 200, CODE),
      item('c', 100),
      item('d', 50, CHROME)
    ]
    const rows = buildClipboardRows(items, new Set(), new Map(), new Set())
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(rows.every((r) => r.item !== null && !r.checked)).toBe(true)
  })

  it('adds items of the selected app, newest first, deduped with anchors winning', () => {
    const items = [
      item('a', 300, CHROME), // anchor + Chrome
      item('b', 200, CODE),
      item('c', 100, CODE),
      item('d', 50, CHROME) // Chrome-only, below the anchor cut
    ]
    // Selecting Chrome: 3 anchors + the app's extra item, single time-ordered list.
    const rows = buildClipboardRows(items, new Set([key(CHROME.exePath)]), new Map(), new Set())
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(rows.map((r) => r.item!.capturedAt)).toEqual([300, 200, 100, 50])
    // Selecting Code: only the anchors (its items are already anchored) — no
    // foreign-app rows leak in.
    const codeRows = buildClipboardRows(items, new Set([key(CODE.exePath)]), new Map(), new Set())
    expect(codeRows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
  })

  it('matches sourceApp by the AppRef.id rule (normalized exePath, name fallback)', () => {
    const items = [
      item('a', 300, { name: 'Code', exePath: 'C:\\USERS\\X\\APP\\Code.EXE' }),
      item('b', 200, { name: 'Chrome' }) // no exePath — matched by name key
    ]
    const rows = buildClipboardRows(items, new Set(['c:/users/x/app/code.exe']), new Map(), new Set())
    expect(rows.map((r) => r.key)).toEqual(['a', 'b'])
    const rowsByName = buildClipboardRows(items, new Set(['chrome']), new Map(), new Set())
    expect(rowsByName.map((r) => r.key)).toEqual(['a', 'b'])
  })

  it('reflects the user selection in the checkmark, independent of the linked set', () => {
    const items = [item('a', 300), item('b', 200)]
    // 'a' linked but deselected; 'b' unlinked but checked by the user.
    const linked = new Map<string, ResourceSnapshot>([['a', snapshot('a-preview')]])
    const rows = buildClipboardRows(items, new Set(), linked, new Set(['b']))
    expect(rows.find((r) => r.key === 'a')!.checked).toBe(false)
    expect(rows.find((r) => r.key === 'b')!.checked).toBe(true)
  })

  it('keeps live linked items in the candidate list even when their app is not selected', () => {
    const items = [item('a', 300), item('b', 200, CODE), item('c', 100)]
    const linked = new Map<string, ResourceSnapshot>([['b', snapshot('b-preview')]])
    const rows = buildClipboardRows(items, new Set(), linked, new Set(['b']))
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(rows.find((r) => r.key === 'b')!.checked).toBe(true)
  })

  it('marks linked live rows checked and appends evicted snapshots as dead rows', () => {
    const items = [item('a', 300), item('b', 200)]
    const linked = new Map<string, ResourceSnapshot>([
      ['b', snapshot('b-preview')],
      ['gone', snapshot('gone-preview')]
    ])
    const rows = buildClipboardRows(items, new Set(), linked, new Set(['b', 'gone']))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ key: 'a', checked: false, item: items[0], dead: null })
    expect(rows[1]).toMatchObject({ key: 'b', checked: true, item: items[1], dead: null })
    expect(rows[2]).toMatchObject({ key: 'gone', checked: true, item: null })
    expect(rows[2].dead).toEqual(snapshot('gone-preview'))
  })

  it('sorts by capturedAt desc even when app items are older than anchors', () => {
    const items = [
      item('anchor1', 500),
      item('anchor2', 400),
      item('anchor3', 300),
      item('app-old', 10, CODE),
      item('app-new', 350, CODE)
    ]
    const rows = buildClipboardRows(items, new Set([key(CODE.exePath)]), new Map(), new Set())
    expect(rows.map((r) => r.item!.capturedAt)).toEqual([500, 400, 350, 300, 10])
  })
})

describe('revealStepForApps', () => {
  it('starts at 3 anchors and grows 3 per selected app, capped at 15', () => {
    expect(revealStepForApps(0)).toBe(CLIPBOARD_ANCHOR_COUNT)
    expect(revealStepForApps(1)).toBe(6)
    expect(revealStepForApps(4)).toBe(15)
    expect(revealStepForApps(10)).toBe(CLIPBOARD_MAX_ROWS)
  })
})

describe('canSaveTaskForm', () => {
  it('saves with a title alone or any single context field', () => {
    expect(canSaveTaskForm('  title  ', false, false, '')).toBe(true)
    expect(canSaveTaskForm('', true, false, '')).toBe(true)
    expect(canSaveTaskForm('', false, true, '')).toBe(true)
    expect(canSaveTaskForm('', false, false, '  note  ')).toBe(true)
  })

  it('is disabled only when all four inputs are empty', () => {
    expect(canSaveTaskForm('', false, false, '')).toBe(false)
    expect(canSaveTaskForm('   ', false, false, '  ')).toBe(false)
  })
})

describe('fallbackTaskTitle', () => {
  it('uses the app-based algorithm title when apps are selected', () => {
    expect(fallbackTaskTitle(['Code', 'Chrome', 'Zed'], '', [])).toBe('Code + Chrome task')
  })

  it('names from the note when there are no apps — never "Untitled task"', () => {
    expect(fallbackTaskTitle([], '整理设计文档', [])).toBe('整理设计文档')
  })

  it('falls back to the first checked preview and caps the length', () => {
    expect(fallbackTaskTitle([], '', ['https://example.com/very/long/url'])).toBe('https://example.com/very/long/url')
    expect(fallbackTaskTitle([], '', ['x'.repeat(120)])).toHaveLength(60)
  })
})

describe('clipboardPreview', () => {
  it('renders each kind compactly', () => {
    expect(clipboardPreview(item('t', 1))).toBe('text-t')
    expect(clipboardPreview({ id: 'i', data: { kind: 'image', imageId: 'x', width: 1920, height: 1080, bytes: 1 }, capturedAt: 1, hitCount: 1, pinned: false })).toBe('1920×1080')
    expect(clipboardPreview({ id: 'c', data: { kind: 'image-collection', images: [] }, capturedAt: 1, hitCount: 1, pinned: false })).toBe('0 images')
    expect(clipboardPreview({ id: 'f', data: { kind: 'files', paths: ['C:\\a.txt', 'C:\\b.txt'] }, capturedAt: 1, hitCount: 1, pinned: false })).toBe('a.txt, b.txt')
  })
})
