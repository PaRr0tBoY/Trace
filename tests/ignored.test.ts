import { describe, expect, it } from 'vitest'
import { createIgnoredTable, type IgnoredTable } from '../electron/main/ignored'
import { suggestionSignature } from '../electron/store/activityLedger'

/** In-memory persistence adapter. */
function memoryTable(initial: string[] | null = null): { table: IgnoredTable; saved: string[][] } {
  const saved: string[][] = []
  let store = initial
  const table = createIgnoredTable({
    load: () => store,
    save: (sigs) => {
      saved.push([...sigs])
      store = [...sigs]
    }
  })
  return { table, saved }
}

describe('suggestionSignature', () => {
  it('is deterministic for the same app keys + time slot', () => {
    const a = suggestionSignature(['c:/apps/code.exe', 'c:/apps/chrome.exe'], 1_700_000_000_000)
    const b = suggestionSignature(['c:/apps/chrome.exe', 'c:/apps/code.exe'], 1_700_000_000_000)
    expect(a).toBe(b)
  })

  it('changes with the app combination', () => {
    const a = suggestionSignature(['c:/apps/code.exe'], 1_700_000_000_000)
    const b = suggestionSignature(['c:/apps/chrome.exe'], 1_700_000_000_000)
    expect(a).not.toBe(b)
  })

  it('changes across time-slot buckets (hour boundary)', () => {
    const bucketMs = 3_600_000
    const a = suggestionSignature(['code'], 1_700_000_000_000, bucketMs)
    const b = suggestionSignature(['code'], 1_700_000_000_000 + bucketMs, bucketMs)
    expect(a).not.toBe(b)
  })

  it('is stable within the same hour bucket', () => {
    const bucketMs = 3_600_000
    const a = suggestionSignature(['code', 'chrome'], 1_700_000_000_000, bucketMs)
    // 30 min later, still inside the same hour (remainder 800s + 1800s < 3600s).
    const b = suggestionSignature(['code', 'chrome'], 1_700_000_000_000 + 1_800_000, bucketMs)
    expect(a).toBe(b)
  })
})

describe('IgnoredTable', () => {
  it('starts empty and reports membership', () => {
    const { table } = memoryTable()
    expect(table.size()).toBe(0)
    expect(table.has('abc')).toBe(false)
    table.add('abc')
    expect(table.has('abc')).toBe(true)
    expect(table.size()).toBe(1)
  })

  it('persists on every add', () => {
    const { table, saved } = memoryTable()
    table.add('a')
    table.add('b')
    expect(saved).toEqual([['a'], ['b', 'a']])
  })

  it('loads persisted signatures', () => {
    const { table } = memoryTable(['x', 'y'])
    expect(table.has('x')).toBe(true)
    expect(table.has('y')).toBe(true)
    expect(table.has('z')).toBe(false)
  })

  it('survives a round-trip through the persistence adapter', () => {
    const first = memoryTable()
    first.table.add('sig-1')
    first.table.add('sig-2')
    const persisted = first.saved[first.saved.length - 1]

    const second = memoryTable(persisted)
    expect(second.table.has('sig-1')).toBe(true)
    expect(second.table.has('sig-2')).toBe(true)
  })

  it('re-adding an existing signature refreshes it (LRU), not duplicates', () => {
    const { table } = memoryTable()
    table.add('a')
    table.add('b')
    table.add('a')
    expect(table.size()).toBe(2)
    expect(table.has('a')).toBe(true)
    expect(table.has('b')).toBe(true)
  })

  it('evicts the least-recently-used entry past the cap', () => {
    const capped = createIgnoredTable({ load: () => null, save: () => {}, limit: 3 })
    capped.add('a')
    capped.add('b')
    capped.add('c')
    capped.add('d')
    expect(capped.size()).toBe(3)
    expect(capped.has('a')).toBe(false) // oldest, evicted
    expect(capped.has('b')).toBe(true)
    expect(capped.has('d')).toBe(true)

    // Refresh keeps a entry young: a is re-added, so b becomes the tail.
    capped.add('a')
    capped.add('e')
    expect(capped.has('b')).toBe(false)
    expect(capped.has('a')).toBe(true)
    expect(capped.has('e')).toBe(true)
  })

  it('drops garbage from the persisted list', () => {
    const { table } = memoryTable(['ok', '', 42 as unknown as string, 'ok'])
    expect(table.size()).toBe(1)
    expect(table.has('ok')).toBe(true)
  })
})
