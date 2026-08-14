/**
 * Transfer Station domain module tests (ticket #3 / ADR-0006 / ADR-0007).
 *
 * Pure-module tests: lifecycle, chunking, retention, staleness/revive and
 * the legacy migration transform. Real-filesystem fixtures (temp dirs) cover
 * the stat cache behaviour; an injectable clock covers retention timing.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TransferStation,
  type FileStat,
  type StationEntry
} from '../electron/store/transferStation'

function makeStation(overrides?: { now?: () => number; stat?: (p: string) => FileStat | undefined; createId?: () => string }): TransferStation {
  return new TransferStation(overrides)
}

let seq = 0


describe('enter', () => {
  it('creates an entry with the station fields and puts it first (newest first)', () => {
    const station = makeStation({ now: () => 1000, createId: () => `id-${++seq}` })
    const created = station.enter(['c:\\a\\one.pdf', 'c:\\b\\two.txt'], 'drag-in')
    expect(created).toHaveLength(1)
    expect(station.list()[0]).toMatchObject({
      id: created[0].id,
      paths: ['c:\\a\\one.pdf', 'c:\\b\\two.txt'],
      route: 'drag-in',
      pinned: false,
      inTransit: false,
      capturedAt: 1000
    })
    station.enter(['c:\\c\\three.zip'], 'clipboard')
    expect(station.list().map((e) => e.id)).toEqual([station.list()[0].id, created[0].id])
  })

  it('chunks a batch of more than 10 paths into multiple entries', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const paths = Array.from({ length: 15 }, (_, i) => `c:\\files\\f${String(i).padStart(2, '0')}.bin`)
    const created = station.enter(paths, 'drag-in')
    expect(created).toHaveLength(2)
    expect(created[0].paths).toHaveLength(10)
    expect(created[1].paths).toHaveLength(5)
    // relative order preserved across chunks
    expect([...created[0].paths, ...created[1].paths]).toEqual(paths)
  })

  it('chunks 21 paths into three entries of 10/10/1', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const paths = Array.from({ length: 21 }, (_, i) => `c:\\f\\f${i}.bin`)
    const created = station.enter(paths, 'clipboard')
    expect(created.map((e) => e.paths.length)).toEqual([10, 10, 1])
  })

  it('dedups an exact path list (order-insensitive): bumps, refreshes, creates nothing', () => {
    const station = makeStation({ now: () => 1000, createId: () => `id-${++seq}` })
    const [first] = station.enter(['a\\x', 'b\\y'], 'drag-in')
    station.enter(['c\\z'], 'clipboard')
    const created = station.enter(['b\\y', 'a\\x'], 'drag-in')
    expect(created).toHaveLength(0)
    expect(station.list()).toHaveLength(2)
    const bumped = station.list()[0]
    expect(bumped.id).toBe(first.id)
    expect(bumped.capturedAt).toBe(1000)
    expect(bumped.route).toBe('drag-in')
  })

  it('treats different path lists as distinct entries even when overlapping', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    station.enter(['a\\x', 'b\\y'], 'drag-in')
    const created = station.enter(['a\\x'], 'drag-in')
    expect(created).toHaveLength(1)
    expect(station.list()).toHaveLength(2)
  })

  it('returns nothing for an empty batch', () => {
    const station = makeStation()
    expect(station.enter([], 'drag-in')).toEqual([])
  })

  it('caches a stat snapshot for every path at entry', () => {
    const seen: string[] = []
    const station = makeStation({
      createId: () => `id-${++seq}`,
      stat: (p) => { seen.push(p); return { exists: true, size: 42 } }
    })
    station.enter(['a\\x', 'b\\y'], 'drag-in')
    expect(seen).toEqual(['a\\x', 'b\\y'])
    expect(station.list()[0].stats).toEqual({ 'a\\x': { exists: true, size: 42 }, 'b\\y': { exists: true, size: 42 } })
  })
})

describe('remove', () => {
  it('returns and drops the entry', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [e] = station.enter(['a\\x'], 'drag-in')
    const removed = station.remove(e.id)
    expect(removed?.id).toBe(e.id)
    expect(station.list()).toHaveLength(0)
    expect(station.get(e.id)).toBeUndefined()
  })

  it('returns undefined for an unknown id', () => {
    const station = makeStation()
    expect(station.remove('nope')).toBeUndefined()
  })

  it('allows removing an in-transit entry (manual disposal path)', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [e] = station.enter(['a\\x'], 'drag-in')
    station.setInTransit(e.id, true)
    expect(station.remove(e.id)?.inTransit).toBe(true)
  })
})

describe('pin / unpin / in-transit', () => {
  it('flips pinned and reports notfound', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [e] = station.enter(['a\\x'], 'drag-in')
    expect(station.pin(e.id, true)).toBe(true)
    expect(station.list()[0].pinned).toBe(true)
    expect(station.pin(e.id, false)).toBe(true)
    expect(station.list()[0].pinned).toBe(false)
    expect(station.pin('nope', true)).toBe(false)
  })

  it('flags in-transit', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [e] = station.enter(['a\\x'], 'drag-in')
    expect(station.setInTransit(e.id, true)).toBe(true)
    expect(station.list()[0].inTransit).toBe(true)
    expect(station.setInTransit('nope', true)).toBe(false)
  })

  it('retargets paths and refreshes their stat cache', () => {
    const station = makeStation({
      createId: () => `id-${++seq}`,
      stat: () => ({ exists: true, size: 7 })
    })
    const [e] = station.enter(['c:\\orig\\x'], 'drag-in')
    expect(station.retarget(e.id, ['c:\\stage\\x'])).toBe(true)
    const updated = station.get(e.id)!
    expect(updated.paths).toEqual(['c:\\stage\\x'])
    expect(updated.stats['c:\\stage\\x']).toEqual({ exists: true, size: 7 })
    expect(updated.stats['c:\\orig\\x']).toBeUndefined()
    expect(station.retarget('nope', ['x'])).toBe(false)
  })
})

describe('split', () => {
  function stationWithMembers(): { station: TransferStation; entry: StationEntry } {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [entry] = station.enter(['a\\1.pdf', 'b\\2.txt', 'c\\3.png', 'd\\4.docx', 'e\\5.zip'], 'drag-in')
    return { station, entry }
  }

  it('splits members into a new entry right after the source, inheriting route/pinned/capturedAt', () => {
    const { station, entry } = stationWithMembers()
    station.pin(entry.id, true)
    const before = entry.capturedAt
    const res = station.split(entry.id, ['b\\2.txt', 'e\\5.zip'])
    expect(res).toEqual({ ok: true })
    const list = station.list()
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(entry.id)
    expect(list[0].paths).toEqual(['a\\1.pdf', 'c\\3.png', 'd\\4.docx'])
    expect(list[1]).toMatchObject({
      paths: ['b\\2.txt', 'e\\5.zip'],
      route: 'drag-in',
      pinned: true,
      inTransit: false,
      capturedAt: before
    })
  })

  it('removes the source when everything is split out (new entry takes its slot)', () => {
    const { station, entry } = stationWithMembers()
    station.enter(['z\\other'], 'clipboard')
    const res = station.split(entry.id, entry.paths)
    expect(res).toEqual({ ok: true })
    expect(station.list()).toHaveLength(2)
    expect(station.get(entry.id)).toBeUndefined()
    expect(station.list().map((e) => e.paths)).toEqual([['z\\other'], entry.paths])
  })

  it('rejects unknown ids, empty target lists and in-transit sources', () => {
    const { station, entry } = stationWithMembers()
    expect(station.split('nope', ['x'])).toEqual({ ok: false, reason: 'notfound' })
    expect(station.split(entry.id, ['never-present.pdf'])).toEqual({ ok: false, reason: 'no-paths' })
    station.setInTransit(entry.id, true)
    expect(station.split(entry.id, ['a\\1.pdf'])).toEqual({ ok: false, reason: 'in-transit' })
  })
})

describe('merge', () => {
  it('merges source paths into the target (deduped), removing the source', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [tgt] = station.enter(['a\\1.pdf', 'b\\2.txt'], 'drag-in')
    const [src] = station.enter(['b\\2.txt', 'c\\3.png'], 'clipboard')
    expect(station.merge(src.id, tgt.id)).toEqual({ ok: true })
    expect(station.list()).toHaveLength(1)
    expect(station.list()[0].paths).toEqual(['a\\1.pdf', 'b\\2.txt', 'c\\3.png'])
    expect(station.list()[0].route).toBe('drag-in')
  })

  it('keeps the target pinned when either side was pinned', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [tgt] = station.enter(['a\\1'], 'drag-in')
    const [src] = station.enter(['b\\2'], 'clipboard')
    station.pin(src.id, true)
    station.merge(src.id, tgt.id)
    expect(station.list()[0].pinned).toBe(true)
  })

  it('rejects merges that exceed MAX_STACK (10) paths', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [tgt] = station.enter(Array.from({ length: 10 }, (_, i) => `a\\${i}.bin`), 'drag-in')
    const [src] = station.enter(['b\\x'], 'clipboard')
    expect(station.merge(src.id, tgt.id)).toEqual({ ok: false, reason: 'full' })
    expect(station.list()).toHaveLength(2)
  })

  it('rejects self-merge, unknown ids and in-transit participants', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const [a] = station.enter(['a\\1'], 'drag-in')
    const [b] = station.enter(['b\\2'], 'drag-in')
    const [c] = station.enter(['c\\3'], 'drag-in')
    expect(station.merge(a.id, a.id)).toEqual({ ok: false, reason: 'self' })
    expect(station.merge('nope', a.id)).toEqual({ ok: false, reason: 'notfound' })
    expect(station.merge(a.id, 'nope')).toEqual({ ok: false, reason: 'notfound' })
    station.setInTransit(c.id, true)
    expect(station.merge(c.id, a.id)).toEqual({ ok: false, reason: 'in-transit' })
    expect(station.merge(a.id, c.id)).toEqual({ ok: false, reason: 'in-transit' })
  })
})

describe('retention (prune)', () => {
  function agedStation(): { station: TransferStation; oldId: string; freshId: string } {
    let clock = 0
    const station = makeStation({ now: () => clock, createId: () => `id-${++seq}` })
    clock = 1000
    const [old] = station.enter(['a\\old.bin'], 'drag-in')
    clock = 1000 + 3 * 3600 * 1000
    const [fresh] = station.enter(['b\\fresh.bin'], 'clipboard')
    return { station, oldId: old.id, freshId: fresh.id }
  }

  it('never prunes when autoDeleteHours is 0 or negative', () => {
    const { station } = agedStation()
    expect(station.prune(0)).toEqual([])
    expect(station.prune(-1)).toEqual([])
    expect(station.list()).toHaveLength(2)
  })

  it('prunes only entries older than the cutoff', () => {
    const { station, oldId, freshId } = agedStation()
    // cutoff = 1000 + 2h: old(1000) is below, fresh(1000+3h) is above
    const pruned = station.prune(2, 1000 + 4 * 3600 * 1000)
    expect(pruned.map((e) => e.id)).toEqual([oldId])
    expect(station.list().map((e) => e.id)).toEqual([freshId])
  })

  it('keeps an entry whose capturedAt equals the cutoff', () => {
    let clock = 1000
    const station = makeStation({ now: () => clock, createId: () => `id-${++seq}` })
    station.enter(['a\\x'], 'drag-in') // capturedAt = 1000
    // cutoff = 1000 + 1h - 1h = 1000, entry.capturedAt === cutoff → kept
    expect(station.prune(1, 1000 + 3600 * 1000)).toEqual([])
    expect(station.list()).toHaveLength(1)
  })

  it('exempts pinned entries', () => {
    const { station, oldId } = agedStation()
    station.pin(oldId, true)
    expect(station.prune(2)).toEqual([])
    expect(station.list()).toHaveLength(2)
  })

  it('exempts in-transit entries', () => {
    const { station, oldId } = agedStation()
    station.setInTransit(oldId, true)
    expect(station.prune(2)).toEqual([])
    expect(station.list()).toHaveLength(2)
  })

  it('returns the pruned entries so callers can dispose of their files', () => {
    const { station, oldId } = agedStation()
    const pruned = station.prune(2)
    expect(pruned).toHaveLength(1)
    expect(pruned[0].id).toBe(oldId)
  })
})

describe('staleness and revive (real filesystem fixture)', () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'trace-station-'))
    return dir
  }

  it('reports stale when a file disappears and revives when it returns', () => {
    const dir = fixture()
    const f = join(dir, 'doc.pdf')
    writeFileSync(f, 'content')
    try {
      const station = makeStation({ createId: () => `id-${++seq}` })
      const [e] = station.enter([f], 'drag-in')
      expect(station.isStale(e.id)).toBe(false)
      expect(station.list()[0].stats[f].exists).toBe(true)

      rmSync(f)
      expect(station.isStale(e.id)).toBe(false) // cached view until revived
      const revived = station.revive(e.id)
      expect(revived).toBe(false)
      expect(station.isStale(e.id)).toBe(true)

      writeFileSync(f, 'content again')
      expect(station.revive(e.id)).toBe(true) // stale -> live flip
      expect(station.isStale(e.id)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refreshAll revives every entry whose files came back and counts flips', () => {
    const dir = fixture()
    const a = join(dir, 'a.bin')
    const b = join(dir, 'b.bin')
    writeFileSync(a, 'x')
    writeFileSync(b, 'x')
    try {
      const station = makeStation({ createId: () => `id-${++seq}` })
      station.enter([a], 'drag-in')
      station.enter([b], 'drag-in') // list()[0] = b, list()[1] = a
      rmSync(a)
      station.refreshAll()
      expect(station.isStale(station.list()[1].id)).toBe(true) // a
      expect(station.isStale(station.list()[0].id)).toBe(false) // b

      writeFileSync(a, 'back')
      expect(station.refreshAll()).toBe(1)
      expect(station.isStale(station.list()[0].id)).toBe(false)
      expect(station.isStale(station.list()[1].id)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('entry-level staleness: one missing path marks the whole entry stale', () => {
    const dir = fixture()
    const a = join(dir, 'a.bin')
    const b = join(dir, 'b.bin')
    writeFileSync(a, 'x')
    writeFileSync(b, 'x')
    try {
      const station = makeStation({ createId: () => `id-${++seq}` })
      const [e] = station.enter([a, b], 'drag-in')
      rmSync(a)
      station.revive(e.id)
      expect(station.isStale(e.id)).toBe(true)
      expect(station.list()[0].stats[b].exists).toBe(true) // healthy member keeps its size
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a stat that throws (unreadable) counts as missing', () => {
    const station = makeStation({
      createId: () => `id-${++seq}`,
      stat: () => { throw new Error('access denied') }
    })
    const [e] = station.enter(['x\\locked.bin'], 'drag-in')
    expect(station.isStale(e.id)).toBe(true)
  })
})

describe('migration (legacy clipboard stack -> station)', () => {
  it('maps legacy files items 1:1 to station entries with route=clipboard, keeping id/capturedAt/pinned', () => {
    const station = makeStation({ createId: () => `id-${++seq}` })
    const legacy = [
      { id: 'legacy-f1', capturedAt: 111, pinned: false, data: { kind: 'files', paths: ['c:\\a\\one.pdf', 'c:\\b\\two.txt'] } },
      { id: 'legacy-f2', capturedAt: 222, pinned: true, data: { kind: 'files', paths: ['c:\\c\\three.zip'] } }
    ]
    const res = station.migrateLegacyFileItems(legacy)
    expect(res.migratedIds).toEqual(['legacy-f1', 'legacy-f2'])
    expect(res.entries).toHaveLength(2)
    expect(res.entries[0]).toMatchObject({ id: 'legacy-f1', route: 'clipboard', pinned: false, capturedAt: 111 })
    expect(res.entries[1]).toMatchObject({ id: 'legacy-f2', route: 'clipboard', pinned: true, capturedAt: 222 })
    expect(station.list().map((e) => e.id)).toEqual(['legacy-f1', 'legacy-f2'])
  })

  it('leaves non-files items untouched (image/image-collection/text stay in the stack)', () => {
    const station = makeStation()
    const legacy = [
      { id: 'img', capturedAt: 1, pinned: false, data: { kind: 'image', imageId: 'x' } },
      { id: 'col', capturedAt: 2, pinned: false, data: { kind: 'image-collection', images: [] } },
      { id: 'txt', capturedAt: 3, pinned: false, data: { kind: 'text', text: 'hi' } },
      { id: 'fl', capturedAt: 4, pinned: false, data: { kind: 'files', paths: ['c:\\x.bin'] } }
    ]
    const res = station.migrateLegacyFileItems(legacy)
    expect(res.migratedIds).toEqual(['fl'])
    expect(res.entries).toHaveLength(1)
    expect(station.list()).toHaveLength(1)
  })

  it('skips path-less files items', () => {
    const station = makeStation()
    const res = station.migrateLegacyFileItems([{ id: 'zombie', capturedAt: 1, pinned: false, data: { kind: 'files', paths: [] } }])
    expect(res.migratedIds).toEqual([])
    expect(station.list()).toHaveLength(0)
  })
})

describe('toDto', () => {
  it('shapes the renderer DTO: per-path members, derived stale, flags pass through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-station-dto-'))
    const f = join(dir, 'report.PDF')
    const g = join(dir, 'photo.png')
    writeFileSync(f, 'x')
    writeFileSync(g, 'y')
    try {
      const station = makeStation({ createId: () => `id-${++seq}` })
      const [e] = station.enter([f, g], 'drag-in')
      station.pin(e.id, true)
      const dto = station.toDto()
      expect(dto).toHaveLength(1)
      expect(dto[0]).toMatchObject({
        id: e.id,
        route: 'drag-in',
        pinned: true,
        inTransit: false,
        stale: false,
        paths: [f, g]
      })
      expect(dto[0].members).toEqual([
        { name: 'report.PDF', ext: 'pdf', size: 1, isImage: false, exists: true },
        { name: 'photo.png', ext: 'png', size: 1, isImage: true, exists: true }
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks the entry stale and zeroes missing member sizes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-station-dto-'))
    const f = join(dir, 'gone.bin')
    writeFileSync(f, 'x')
    try {
      const station = makeStation({ createId: () => `id-${++seq}` })
      const [e] = station.enter([f], 'drag-in')
      rmSync(f)
      station.revive(e.id)
      const dto = station.toDto()[0]
      expect(dto.stale).toBe(true)
      expect(dto.members[0]).toMatchObject({ exists: false, size: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
