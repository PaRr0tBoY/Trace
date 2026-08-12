/**
 * t39 — Evidence timeline store (spec 实现决策 2).
 *
 * Covers the store contract over db.ts's events table + events_fts triggers:
 * capture (timestamp + source), the two `search_activities` modes (time
 * window + FTS5 keyword, by-id detail incl. clipboard material preview),
 * retention boundary (injected clock via purgeBefore cutoff), persistence
 * across a full reopen, and the bus-event mapper / preview builder.
 *
 * SQLite tests use the nativeBinding ABI seam from tests/db.test.ts (the
 * installed better-sqlite3 addon targets Electron; vitest runs under Node).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, closeDatabase, type TraceDatabase } from '../electron/store/db'
import {
  buildClipboardPreview,
  createMemoryEvidenceStore,
  createSqliteEvidenceStore,
  evidenceFromUsageEvent,
  type EvidenceEvent,
  type EvidenceStore
} from '../electron/store/evidenceStore'
import type { UsageEvent } from '../shared/types'

const CACHED_NODE_BINDING = join(process.cwd(), 'node_modules', '.cache', 'better-sqlite3-node', 'better_sqlite3.node')

function isAbiMismatch(e: unknown): e is Error {
  return e instanceof Error && e.message.includes('NODE_MODULE_VERSION')
}

function openTestDb(filePath: string): TraceDatabase {
  try {
    return openDatabase(filePath)
  } catch (e) {
    if (!isAbiMismatch(e)) throw e
    if (!existsSync(CACHED_NODE_BINDING)) {
      throw new Error(`better-sqlite3 ABI mismatch and no cached Node build at ${CACHED_NODE_BINDING}`)
    }
    return openDatabase(filePath, { nativeBinding: CACHED_NODE_BINDING })
  }
}

const openDbs: TraceDatabase[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const db of openDbs) closeDatabase(db)
  openDbs.length = 0
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

function newSqliteStore(): EvidenceStore {
  const dir = mkdtempSync(join(tmpdir(), 'trace-evidence-'))
  tempDirs.push(dir)
  const db = openTestDb(join(dir, 'trace.db'))
  openDbs.push(db)
  return createSqliteEvidenceStore(db)
}

const EDITOR = 'C:/Code/Editor.exe'

const appSwitch = (id: string, ts: number, title = 'writing rust code', source = EDITOR): EvidenceEvent => ({
  id,
  kind: 'app-switch',
  capturedAt: ts,
  source,
  windowTitle: title,
  payload: { pid: 1234 }
})

const clipboard = (id: string, ts: number, itemId: string, text = 'rust borrow checker notes'): EvidenceEvent => ({
  id,
  kind: 'clipboard',
  capturedAt: ts,
  source: EDITOR,
  payload: { pid: 1234, itemId, preview: { text } }
})

describe('createSqliteEvidenceStore — capture', () => {
  it('records events with timestamp + source and reads them back newest first', () => {
    const store = newSqliteStore()
    store.record(appSwitch('e1', 1_000_000, 'writing rust borrow checker'))
    store.record(clipboard('e2', 1_100_000, 'item-9'))

    const all = store.query()
    expect(store.count()).toBe(2)
    expect(all.map((e) => e.id)).toEqual(['e2', 'e1'])
    expect(all.map((e) => e.capturedAt)).toEqual([1_100_000, 1_000_000])
    const switchRow = all.find((e) => e.id === 'e1')!
    expect(switchRow.kind).toBe('app-switch')
    expect(switchRow.source).toBe(EDITOR)
    expect(switchRow.windowTitle).toBe('writing rust borrow checker')
    expect(switchRow.payload).toEqual({ pid: 1234 })
    // Clipboard detail keeps the material preview in the payload.
    expect(all.find((e) => e.id === 'e2')!.payload).toEqual({
      pid: 1234,
      itemId: 'item-9',
      preview: { text: 'rust borrow checker notes' }
    })
  })

  it('survives a full reopen of the database file (restart persistence)', () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'trace-evidence-')), 'trace.db')
    tempDirs.push(join(filePath, '..'))
    const db1 = openTestDb(filePath)
    openDbs.push(db1)
    createSqliteEvidenceStore(db1).record(appSwitch('e1', 1_000, 'rust notes', EDITOR))
    createSqliteEvidenceStore(db1).record(clipboard('e2', 2_000, 'item-1'))
    closeDatabase(db1)

    const db2 = openTestDb(filePath)
    openDbs.push(db2)
    const store = createSqliteEvidenceStore(db2)
    expect(store.count()).toBe(2)
    expect(store.getById('e1')!.windowTitle).toBe('rust notes')
    expect(store.getById('e1')!.source).toBe(EDITOR)
    expect(store.getById('e2')!.payload).toEqual({
      pid: 1234,
      itemId: 'item-1',
      preview: { text: 'rust borrow checker notes' }
    })
  })
})

describe('createSqliteEvidenceStore — query mode 1: time window + keyword', () => {
  it('filters by time window (from inclusive, to exclusive)', () => {
    const store = newSqliteStore()
    store.record(appSwitch('a', 100))
    store.record(appSwitch('b', 200))
    store.record(appSwitch('c', 300))

    expect(store.query({ from: 200 }).map((e) => e.id)).toEqual(['c', 'b'])
    expect(store.query({ to: 300 }).map((e) => e.id)).toEqual(['b', 'a'])
    expect(store.query({ from: 200, to: 300 }).map((e) => e.id)).toEqual(['b'])
  })

  it('searches keywords via FTS5 across window title and payload, case-insensitive, AND-combined', () => {
    const store = newSqliteStore()
    store.record(appSwitch('a', 100, 'writing rust borrow checker'))
    store.record(clipboard('b', 200, 'item-1', 'rust borrow checker notes'))
    store.record(appSwitch('c', 300, 'reading docs', 'C:/Users/x/AppData/Local/Chrome/chrome.exe'))

    expect(store.query({ keyword: 'rust' }).map((e) => e.id)).toEqual(['b', 'a'])
    expect(store.query({ keyword: 'RUST' }).map((e) => e.id)).toEqual(['b', 'a'])
    // Whitespace-separated terms are AND-combined.
    expect(store.query({ keyword: 'borrow checker' }).map((e) => e.id)).toEqual(['b', 'a'])
    expect(store.query({ keyword: 'rust checker chrome' }).map((e) => e.id)).toEqual([])
    expect(store.query({ keyword: 'chrome' }).map((e) => e.id)).toEqual(['c'])
  })

  it('combines keyword with a time window', () => {
    const store = newSqliteStore()
    store.record(appSwitch('a', 100, 'rust notes'))
    store.record(appSwitch('b', 200, 'rust compiler'))

    expect(store.query({ keyword: 'rust', from: 150 }).map((e) => e.id)).toEqual(['b'])
    expect(store.query({ keyword: 'rust', to: 150 }).map((e) => e.id)).toEqual(['a'])
  })

  it('treats FTS operator characters in keywords as literal terms', () => {
    const store = newSqliteStore()
    store.record(appSwitch('a', 100, 'plain sentence'))
    store.record(appSwitch('b', 200, 'quoted "phrase" here'))

    expect(store.query({ keyword: '"phrase"' }).map((e) => e.id)).toEqual(['b'])
    // A leading '-' stays a positive AND term — if it leaked as an operator,
    // 'plain NOT sentence' would match b, not a.
    expect(store.query({ keyword: 'plain -sentence' }).map((e) => e.id)).toEqual(['a'])
  })

  it('filters by kind and ignores unknown kind values', () => {
    const store = newSqliteStore()
    store.record(appSwitch('a', 100))
    store.record(clipboard('b', 200, 'i1'))

    expect(store.query({ kinds: ['clipboard'] }).map((e) => e.id)).toEqual(['b'])
    expect(store.query({ kinds: ['app-switch', 'clipboard'] }).map((e) => e.id)).toEqual(['b', 'a'])
    expect(store.query({ kinds: [] }).map((e) => e.id)).toEqual(['b', 'a'])
    expect(store.query({ kinds: ['app-switch', 'bogus' as never] }).map((e) => e.id)).toEqual(['a'])
  })

  it('paginates with limit/offset, newest first', () => {
    const store = newSqliteStore()
    for (let i = 1; i <= 5; i++) store.record(appSwitch(`e${i}`, i * 100))

    expect(store.query({ limit: 2 }).map((e) => e.id)).toEqual(['e5', 'e4'])
    expect(store.query({ limit: 2, offset: 2 }).map((e) => e.id)).toEqual(['e3', 'e2'])
    expect(store.query({ limit: 2, offset: 4 }).map((e) => e.id)).toEqual(['e1'])
  })
})

describe('createSqliteEvidenceStore — query mode 2: by-id detail', () => {
  it('returns the full detail incl. clipboard material preview; unknown id is undefined', () => {
    const store = newSqliteStore()
    store.record(clipboard('e1', 100, 'item-42', 'fix borrow checker lifetime'))

    const detail = store.getById('e1')
    expect(detail).toBeDefined()
    expect(detail!.payload).toEqual({ pid: 1234, itemId: 'item-42', preview: { text: 'fix borrow checker lifetime' } })
    expect(detail!.windowTitle).toBeUndefined()
    expect(store.getById('missing')).toBeUndefined()
  })
})

describe('createSqliteEvidenceStore — retention (injected clock)', () => {
  it('purges only rows captured strictly before the cutoff and syncs FTS', () => {
    const store = newSqliteStore()
    store.record(appSwitch('old', 1_000, 'rust old notes'))
    store.record(appSwitch('edge', 2_000, 'at the cutoff'))
    store.record(appSwitch('new', 3_000, 'rust fresh notes'))

    expect(store.purgeBefore(2_000)).toBe(1)
    expect(store.count()).toBe(2)
    expect(store.getById('old')).toBeUndefined()
    expect(store.getById('edge')).toBeDefined() // at the cutoff survives (strictly before)
    // events_ad trigger removed the row from the FTS index too.
    expect(store.query({ keyword: 'old' })).toEqual([])
    expect(store.query({ keyword: 'rust' }).map((e) => e.id)).toEqual(['new'])
  })

  it('is a no-op when everything is newer than the cutoff', () => {
    const store = newSqliteStore()
    store.record(appSwitch('a', 1_000))
    store.record(appSwitch('b', 2_000))

    expect(store.purgeBefore(1_000)).toBe(0)
    expect(store.count()).toBe(2)
  })
})

describe('createMemoryEvidenceStore — harness semantics', () => {
  it('mirrors capture / time-window / keyword / detail / purge', () => {
    const store = createMemoryEvidenceStore()
    store.record(appSwitch('a', 100, 'rust notes'))
    store.record(appSwitch('b', 200, 'go code'))

    expect(store.count()).toBe(2)
    expect(store.query({ keyword: 'rust' }).map((e) => e.id)).toEqual(['a'])
    expect(store.query({ from: 150 }).map((e) => e.id)).toEqual(['b'])
    expect(store.query({ kinds: ['clipboard'] })).toEqual([])
    expect(store.getById('b')!.capturedAt).toBe(200)

    expect(store.purgeBefore(150)).toBe(1)
    expect(store.count()).toBe(1)
    expect(store.getById('a')).toBeUndefined()
  })
})

describe('buildClipboardPreview — bounded material preview (spec story 35)', () => {
  it('clips text to 200 chars, keeps image dims+bytes, lists file paths', () => {
    expect(buildClipboardPreview({ data: { kind: 'text', text: 'x'.repeat(500), isUrl: false } })).toEqual({
      text: 'x'.repeat(200)
    })
    expect(
      buildClipboardPreview({ data: { kind: 'image', imageId: 'i', width: 640, height: 480, bytes: 1024 } })
    ).toEqual({ image: { width: 640, height: 480, bytes: 1024 } })
    expect(buildClipboardPreview({ data: { kind: 'files', paths: ['C:/a.txt', 'D:/b.png'] } })).toEqual({
      files: ['C:/a.txt', 'D:/b.png']
    })
    // Collections: first image dims + summed bytes (TaskStore buildClipboardRef convention).
    expect(
      buildClipboardPreview({
        data: {
          kind: 'image-collection',
          images: [
            { imageId: 'a', width: 100, height: 200, bytes: 10 },
            { imageId: 'b', width: 300, height: 400, bytes: 20 }
          ]
        }
      })
    ).toEqual({ image: { width: 100, height: 200, bytes: 30 } })
    expect(buildClipboardPreview({ data: { kind: 'text', text: '', isUrl: false } })).toBeUndefined()
    expect(buildClipboardPreview({ data: { kind: 'files', paths: [] } })).toBeUndefined()
  })
})

describe('evidenceFromUsageEvent — bus event → store row mapper', () => {
  it('maps app-switch: kind, timestamp, normalized appKey source, title, pid payload', () => {
    const event: UsageEvent = {
      type: 'app-switch',
      appName: 'Code',
      exePath: 'C:\\Code\\Editor.exe',
      pid: 12,
      windowTitle: 'main.ts',
      ts: 1_000
    }
    const row = evidenceFromUsageEvent(event)
    expect(row.kind).toBe('app-switch')
    expect(row.capturedAt).toBe(1_000)
    expect(row.source).toBe('c:/code/editor.exe') // shared appKey rule (attributor identity)
    expect(row.windowTitle).toBe('main.ts')
    expect(row.payload).toEqual({ pid: 12 })
  })

  it('maps clipboard: itemId + preview in payload, no window title', () => {
    const event: UsageEvent = {
      type: 'clipboard',
      appName: 'Code',
      exePath: 'C:\\Code\\Editor.exe',
      pid: 12,
      ts: 2_000,
      itemId: 'i9'
    }
    const row = evidenceFromUsageEvent(event, { preview: { text: 'hi' } })
    expect(row.kind).toBe('clipboard')
    expect(row.capturedAt).toBe(2_000)
    expect(row.payload).toEqual({ pid: 12, itemId: 'i9', preview: { text: 'hi' } })
    expect(row.windowTitle).toBeUndefined()
  })

  it('falls back to the process name when no exePath is known', () => {
    const row = evidenceFromUsageEvent({ type: 'app-switch', appName: 'Notepad', exePath: '', pid: 1, windowTitle: 'x', ts: 0 })
    expect(row.source).toBe('notepad')
  })
})
