/**
 * T6 — route filter projections (src/lib/stationRoute.ts).
 */
import { describe, expect, it } from 'vitest'
import type { StationEntryDto } from '../shared/station'
import { filterStationByRoute, countStale } from '../src/lib/stationRoute'

function entry(id: string, route: 'drag-in' | 'clipboard', stale = false): StationEntryDto {
  return {
    id,
    route,
    pinned: false,
    inTransit: false,
    capturedAt: 0,
    stale,
    paths: [`C:\\files\\${id}.txt`],
    members: [{ name: `${id}.txt`, ext: 'txt', size: 1, isImage: false, exists: !stale }]
  }
}

describe('filterStationByRoute', () => {
  it('keeps everything under "all"', () => {
    const list = [entry('a', 'drag-in'), entry('b', 'clipboard')]
    expect(filterStationByRoute(list, 'all')).toEqual(list)
  })

  it('keeps only clipboard captures under "clipboard"', () => {
    const list = [entry('a', 'drag-in'), entry('b', 'clipboard'), entry('c', 'clipboard')]
    const out = filterStationByRoute(list, 'clipboard')
    expect(out.map((e) => e.id)).toEqual(['b', 'c'])
  })

  it('returns [] for an empty station', () => {
    expect(filterStationByRoute([], 'clipboard')).toEqual([])
  })
})

describe('countStale', () => {
  it('counts stale entries only', () => {
    const list = [entry('a', 'drag-in', true), entry('b', 'clipboard'), entry('c', 'clipboard', true)]
    expect(countStale(list)).toBe(2)
  })

  it('is 0 with no stale entries', () => {
    expect(countStale([entry('a', 'drag-in')])).toBe(0)
  })
})
