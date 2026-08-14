/**
 * StationStore tests (ticket #5 / ADR-0006).
 *
 * The persistence shell around TransferStation: every mutation persists the
 * JSON index and fires onChange (the pushState hook); reads hydrate from the
 * injected index adapter. The domain semantics themselves are covered by
 * tests/transferStation.test.ts (T1) — here we pin the store wiring.
 */
import { describe, expect, it } from 'vitest'
import {
  StationStore,
  STATION_STORAGE_VERSION,
  type StationIndex,
  type StationStoreDeps
} from '../electron/store/stationStore'
import type { StationEntry } from '../electron/store/transferStation'

interface Harness {
  store: StationStore
  saved: () => StationIndex | null
  saves: () => StationIndex[]
  changes: () => number
}

function makeHarness(opts?: { now?: () => number; stat?: StationStoreDeps['stat']; createId?: () => string }): Harness {
  let saved: StationIndex | null = null
  const saves: StationIndex[] = []
  let changes = 0
  const store = new StationStore({
    loadIndex: () => saved,
    saveIndex: (index) => {
      saved = index
      saves.push(index)
    },
    onChange: () => {
      changes++
    },
    now: opts?.now,
    stat: opts?.stat,
    createId: opts?.createId
  })
  return {
    store,
    saved: () => saved,
    saves: () => saves,
    changes: () => changes
  }
}

let seq = 0
const nextId = (): string => `id-${++seq}`

const entry = (overrides: Partial<StationEntry>): StationEntry => ({
  id: nextId(),
  paths: ['c:\\a\\one.pdf'],
  route: 'drag-in',
  pinned: false,
  inTransit: false,
  capturedAt: 1000,
  stats: { 'c:\\a\\one.pdf': { exists: true, size: 10 } },
  ...overrides
})

describe('StationStore', () => {
  it('load hydrates the persisted index into the domain', () => {
    const seeded = { version: STATION_STORAGE_VERSION, entries: [entry({ id: 'persisted-1', route: 'clipboard' })] }
    let saved: StationIndex | null = seeded
    const store = new StationStore({
      loadIndex: () => saved,
      saveIndex: (i) => {
        saved = i
      }
    })
    store.load()
    expect(store.list().map((e) => e.id)).toEqual(['persisted-1'])
    expect(store.get('persisted-1')?.route).toBe('clipboard')
  })

  it('load drops malformed rows so a corrupt index cannot break hydration', () => {
    const junk = entry({ id: 'ok-entry' })
    const bad = { id: 42, paths: 'not-an-array', route: 'drag-in', pinned: false, inTransit: false, capturedAt: 1, stats: {} }
    const store = new StationStore({
      loadIndex: () => ({ version: 1, entries: [junk, bad as unknown as StationEntry] }),
      saveIndex: () => {}
    })
    store.load()
    expect(store.list().map((e) => e.id)).toEqual(['ok-entry'])
  })

  it('enter persists the index and fires onChange', () => {
    const h = makeHarness()
    const created = h.store.enter(['c:\\a\\one.pdf', 'c:\\b\\two.txt'], 'drag-in')
    expect(created).toHaveLength(1)
    expect(h.saves()).toHaveLength(1)
    expect(h.saved()?.version).toBe(STATION_STORAGE_VERSION)
    expect(h.saved()?.entries[0]).toMatchObject({
      id: created[0].id,
      paths: ['c:\\a\\one.pdf', 'c:\\b\\two.txt'],
      route: 'drag-in'
    })
    expect(h.changes()).toBe(1)
  })

  it('enter with no paths is a no-op that does not persist', () => {
    const h = makeHarness()
    const created = h.store.enter([], 'drag-in')
    expect(created).toHaveLength(0)
    expect(h.saves()).toHaveLength(0)
    expect(h.changes()).toBe(0)
  })

  it('remove persists only when the entry existed', () => {
    const h = makeHarness()
    h.store.enter(['c:\\a\\one.pdf'], 'drag-in')
    const savesAfterEnter = h.saves().length

    expect(h.store.remove('missing-id')).toBeUndefined()
    expect(h.saves().length).toBe(savesAfterEnter)
    expect(h.changes()).toBe(1)

    const removed = h.store.remove(h.saved()!.entries[0].id)
    expect(removed?.paths).toEqual(['c:\\a\\one.pdf'])
    expect(h.saved()?.entries).toHaveLength(0)
    expect(h.changes()).toBe(2)
  })

  it('pin persists only on success', () => {
    const h = makeHarness()
    h.store.enter(['c:\\a\\one.pdf'], 'drag-in')
    const id = h.saved()!.entries[0].id
    const savesAfterEnter = h.saves().length

    expect(h.store.pin('missing-id', true)).toBe(false)
    expect(h.saves().length).toBe(savesAfterEnter)

    expect(h.store.pin(id, true)).toBe(true)
    expect(h.saved()?.entries[0].pinned).toBe(true)
    expect(h.saves().length).toBe(savesAfterEnter + 1)
  })

  it('split forwards to the domain and persists on success', () => {
    const h = makeHarness()
    h.store.enter(['c:\\a\\one.pdf', 'c:\\b\\two.txt'], 'drag-in')
    const id = h.saved()!.entries[0].id
    const savesAfterEnter = h.saves().length

    const miss = h.store.split('missing-id', ['c:\\a\\one.pdf'])
    expect(miss).toEqual({ ok: false, reason: 'notfound' })
    expect(h.saves().length).toBe(savesAfterEnter)

    const ok = h.store.split(id, ['c:\\a\\one.pdf'])
    expect(ok).toEqual({ ok: true })
    expect(h.saved()?.entries).toHaveLength(2)
    expect(h.saved()?.entries[1].paths).toEqual(['c:\\a\\one.pdf'])
  })

  it('merge forwards to the domain and persists on success', () => {
    const h = makeHarness()
    h.store.enter(['c:\\a\\one.pdf'], 'drag-in')
    h.store.enter(['c:\\b\\two.txt'], 'clipboard')
    const saved = h.saved()!.entries
    const srcId = saved[1].id
    const tgtId = saved[0].id
    const savesAfterEnter = h.saves().length

    const ok = h.store.merge(srcId, tgtId)
    expect(ok).toEqual({ ok: true })
    expect(h.saved()?.entries).toHaveLength(1)
    expect(h.saved()?.entries[0].paths).toEqual(['c:\\b\\two.txt', 'c:\\a\\one.pdf'])
    expect(h.saves().length).toBe(savesAfterEnter + 1)

    const miss = h.store.merge(srcId, 'missing-id')
    expect(miss).toEqual({ ok: false, reason: 'notfound' })
    expect(h.saves().length).toBe(savesAfterEnter + 1)
  })

  it('prune persists only when entries were actually removed', () => {
    const h = makeHarness({ now: () => 1_000_000_000_000 })
    h.store.enter(['c:\\a\\old.pdf'], 'drag-in')
    const oldId = h.saved()!.entries[0].id
    h.store.enter(['c:\\b\\pinned.pdf'], 'drag-in')
    const pinnedId = h.saved()!.entries[0].id
    h.store.pin(pinnedId, true)
    h.store.enter(['c:\\c\\fresh.pdf'], 'drag-in')
    const freshId = h.saved()!.entries[0].id
    // Age the old + pinned entries past the 1h cutoff (fresh stays current).
    for (const e of h.saved()!.entries) {
      if (e.id !== freshId) e.capturedAt = 1
    }
    const savesAfterEnter = h.saves().length

    const pruned = h.store.prune(1)
    expect(pruned.map((e) => e.id)).toEqual([oldId])
    expect(h.saved()?.entries.map((e) => e.id)).toEqual([freshId, pinnedId])
    expect(h.saves().length).toBe(savesAfterEnter + 1)

    // A second sweep finds nothing: no persist, no onChange.
    const changesBefore = h.changes()
    expect(h.store.prune(1)).toHaveLength(0)
    expect(h.saves().length).toBe(savesAfterEnter + 1)
    expect(h.changes()).toBe(changesBefore)
  })

  it('prune with autoDeleteHours 0 never removes anything', () => {
    const h = makeHarness({ now: () => 1_000_000_000_000 })
    const seeded: StationIndex = { version: 1, entries: [entry({ capturedAt: 1 })] }
    const store = new StationStore({
      loadIndex: () => seeded,
      saveIndex: (i) => h.saves().push(i),
      onChange: () => {}
    })
    store.load()
    expect(store.prune(0)).toHaveLength(0)
    expect(store.list()).toHaveLength(1)
  })

  it('migrateLegacy converts legacy files items and persists', () => {
    const h = makeHarness()
    const migratedIds = h.store.migrateLegacy([
      { id: 'legacy-1', capturedAt: 42, pinned: true, data: { kind: 'files', paths: ['c:\\x\\a.pdf', 'c:\\x\\b.txt'] } },
      { id: 'legacy-2', capturedAt: 43, pinned: false, data: { kind: 'files', paths: [] } },
      { id: 'legacy-3', capturedAt: 44, pinned: false, data: { kind: 'image', paths: ['c:\\x\\c.png'] } }
    ])
    expect(migratedIds).toEqual(['legacy-1'])
    expect(h.saves()).toHaveLength(1)
    expect(h.saved()?.entries).toHaveLength(1)
    expect(h.saved()?.entries[0]).toMatchObject({
      id: 'legacy-1',
      route: 'clipboard',
      pinned: true,
      capturedAt: 42,
      paths: ['c:\\x\\a.pdf', 'c:\\x\\b.txt']
    })
    expect(h.changes()).toBe(1)
  })

  it('migrateLegacy with nothing to migrate does not persist', () => {
    const h = makeHarness()
    const migratedIds = h.store.migrateLegacy([
      { id: 'text-1', capturedAt: 1, pinned: false, data: { kind: 'text' } }
    ])
    expect(migratedIds).toEqual([])
    expect(h.saves()).toHaveLength(0)
    expect(h.changes()).toBe(0)
  })

  it('toDto exposes the renderer-facing shape with per-path members', () => {
    const h = makeHarness({ stat: (p) => ({ exists: true, size: p.endsWith('.pdf') ? 5 : 7 }) })
    h.store.enter(['c:\\a\\doc.pdf', 'c:\\a\\img.PNG'], 'clipboard')
    const dto = h.store.toDto()
    expect(dto).toHaveLength(1)
    expect(dto[0]).toMatchObject({
      route: 'clipboard',
      pinned: false,
      inTransit: false,
      stale: false,
      paths: ['c:\\a\\doc.pdf', 'c:\\a\\img.PNG']
    })
    expect(dto[0].members[0]).toEqual({ name: 'doc.pdf', ext: 'pdf', size: 5, isImage: false, exists: true })
    expect(dto[0].members[1]).toEqual({ name: 'img.PNG', ext: 'png', size: 7, isImage: true, exists: true })
  })
})
