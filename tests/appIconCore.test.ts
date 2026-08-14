/**
 * App icon core test suite (t26).
 *
 * Drives the pure cache/batch logic from appIconCore with a fake fetcher —
 * no Electron runtime needed (same pattern as geometry/power tests).
 */
import { describe, it, expect, vi } from 'vitest'
import { createAppIconService, APP_ICON_NEGATIVE_TTL_MS, type IconFetcher } from '../electron/main/appIconCore'
import type { TaskProposal, TaskDto } from '../shared/types'

function makeFetcher(icons: Record<string, string>): { fetcher: IconFetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: IconFetcher = {
    fetchIcon: vi.fn(async (exePath: string) => {
      calls.push(exePath)
      return icons[exePath] ?? null
    })
  }
  return { fetcher, calls }
}

function makeTask(partial: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 't_1',
    title: 'task',
    status: 'running',
    statusSource: 'system',
    apps: [],
    resources: [],
    windowTitles: [],
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    activeMs: 0,
    ...partial
  }
}

function makeSuggestion(partial: Partial<TaskProposal> = {}): TaskProposal {
  return {
    id: 's_1',
    title: 'suggestion',
    appNames: [],
    confidence: 0.5,
    lowConfidence: false,
    algorithmReason: 'reason',
    evidence: { appCombination: 'A + B', durationMs: 60_000, overlappingTasks: [] },
    ...partial
  }
}

const DATA_URL = 'data:image/png;base64,AA=='

describe('app icon cache', () => {
  it('returns cached hits synchronously without refetching', async () => {
    const { fetcher, calls } = makeFetcher({ 'C:\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)

    expect(await svc.resolve('C:\\Code.exe')).toBe(DATA_URL)
    expect(await svc.resolve('C:\\Code.exe')).toBe(DATA_URL)
    expect(calls).toEqual(['C:\\Code.exe'])
  })

  it('treats paths case-insensitively (Windows)', async () => {
    const { fetcher, calls } = makeFetcher({ 'C:\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)

    await svc.resolve('C:\\Code.exe')
    expect(await svc.resolve('c:\\code.EXE')).toBe(DATA_URL)
    expect(calls).toEqual(['C:\\Code.exe'])
  })

  it('evicts the least-recently-used entry at the cap', async () => {
    const { fetcher, calls } = makeFetcher({ 'A.exe': 'a', 'B.exe': 'b', 'C.exe': 'c' })
    const svc = createAppIconService(fetcher, 2)

    await svc.resolve('A.exe')
    await svc.resolve('B.exe')
    await svc.resolve('A.exe') // refresh A so B becomes the oldest
    await svc.resolve('C.exe') // evicts B

    expect(await svc.resolve('A.exe')).toBe('a') // hit
    expect(await svc.resolve('B.exe')).toBe('b') // evicted -> refetched
    expect(await svc.resolve('C.exe')).toBe('c') // evicted by B's reinsert -> refetched
    expect(calls).toEqual(['A.exe', 'B.exe', 'C.exe', 'B.exe', 'C.exe'])
  })

  it('negative-caches failed extractions instead of re-probing', async () => {
    const { fetcher, calls } = makeFetcher({ 'C:\\Ghost.exe': DATA_URL })
    const svc = createAppIconService(fetcher)

    expect(await svc.resolve('C:\\Missing.exe')).toBeNull()
    expect(await svc.resolve('C:\\Missing.exe')).toBeNull()
    expect(calls).toEqual(['C:\\Missing.exe'])
    expect(await svc.resolve('C:\\Ghost.exe')).toBe(DATA_URL)
  })

  it('never rejects when the fetcher throws', async () => {
    const svc = createAppIconService({
      fetchIcon: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    expect(await svc.resolve('C:\\Boom.exe')).toBeNull()
    expect(await svc.resolve('C:\\Boom.exe')).toBeNull()
  })
})

describe('attachToTasks', () => {
  it('fills iconUrl only for apps with a resolvable exePath', async () => {
    const { fetcher } = makeFetcher({ 'C:\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)
    const tasks = [
      makeTask({
        apps: [
          { id: 'code', name: 'Code', exePath: 'C:\\Code.exe' },
          { id: 'editor', name: 'Editor', exePath: 'C:\\Ghost.exe' },
          { id: 'bare', name: 'Bare' }
        ]
      })
    ]

    await svc.attachToTasks(tasks)

    expect(tasks[0].apps[0].iconUrl).toBe(DATA_URL)
    expect(tasks[0].apps[1].iconUrl).toBeUndefined()
    expect(tasks[0].apps[2].iconUrl).toBeUndefined()
  })

  it('fetches each unique exePath once across the whole batch', async () => {
    const { fetcher, calls } = makeFetcher({ 'C:\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)
    const tasks = [
      makeTask({ id: 't_1', apps: [{ id: 'a', name: 'A', exePath: 'C:\\Code.exe' }] }),
      makeTask({ id: 't_2', apps: [{ id: 'b', name: 'B', exePath: 'C:\\Code.exe' }, { id: 'c', name: 'C', exePath: 'C:\\Other.exe' }] })
    ]

    await svc.attachToTasks(tasks)

    expect(calls).toEqual(['C:\\Code.exe', 'C:\\Other.exe'])
    expect(tasks[1].apps[0].iconUrl).toBe(DATA_URL)
  })

  it('returns tasks unchanged when nothing has an exePath', async () => {
    const { fetcher } = makeFetcher({})
    const svc = createAppIconService(fetcher)
    const tasks = [makeTask({ apps: [{ id: 'bare', name: 'Bare' }] })]

    await svc.attachToTasks(tasks)

    expect(fetcher.fetchIcon).not.toHaveBeenCalled()
    expect(tasks[0].apps[0].iconUrl).toBeUndefined()
  })
})

describe('attachToSuggestions', () => {
  it('fills appIcons from appExePaths, zipped with appNames, skipping failures', async () => {
    const { fetcher } = makeFetcher({ 'C:\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)
    const suggestions = [
      makeSuggestion({
        appNames: ['Code', 'Ghost'],
        appExePaths: ['C:\\Code.exe', 'C:\\Ghost.exe']
      })
    ]

    await svc.attachToSuggestions(suggestions)

    expect(suggestions[0].appIcons).toEqual([{ name: 'Code', iconUrl: DATA_URL }])
  })

  it('leaves appIcons unset when the engine provided no appExePaths', async () => {
    const { fetcher } = makeFetcher({ 'C:\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)
    const suggestions = [makeSuggestion({ appNames: ['Code'] })]

    await svc.attachToSuggestions(suggestions)

    expect(fetcher.fetchIcon).not.toHaveBeenCalled()
    expect(suggestions[0].appIcons).toBeUndefined()
  })

  it('dedupes exePaths shared across suggestions', async () => {
    const { fetcher, calls } = makeFetcher({ 'C:\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)
    const suggestions = [
      makeSuggestion({ id: 's_1', appNames: ['Code'], appExePaths: ['C:\\Code.exe'] }),
      makeSuggestion({ id: 's_2', appNames: ['Code'], appExePaths: ['C:\\Code.exe'] })
    ]

    await svc.attachToSuggestions(suggestions)

    expect(calls).toEqual(['C:\\Code.exe'])
    expect(suggestions[0].appIcons?.[0].iconUrl).toBe(DATA_URL)
    expect(suggestions[1].appIcons?.[0].iconUrl).toBe(DATA_URL)
  })
})

describe('disk cache bridge (seed / snapshot / negative TTL)', () => {
  it('seed restores hits without refetching (case-insensitive)', async () => {
    const { fetcher, calls } = makeFetcher({ 'C:\\Apps\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)
    svc.seed(new Map([['c:\\apps\\code.exe', DATA_URL]]))

    expect(await svc.resolve('C:\\Apps\\Code.exe')).toBe(DATA_URL)
    expect(calls).toHaveLength(0)
  })

  it('snapshot excludes negative entries, keeping successful ones', async () => {
    const { fetcher } = makeFetcher({ 'C:\\Apps\\Code.exe': DATA_URL })
    const svc = createAppIconService(fetcher)
    await svc.resolve('C:\\Apps\\Code.exe')
    await svc.resolve('C:\\Apps\\Dead.exe') // extraction fails

    const snap = svc.snapshot()
    expect(snap.get('c:\\apps\\code.exe')).toBe(DATA_URL)
    expect(snap.has('c:\\apps\\dead.exe')).toBe(false)
    expect(snap.size).toBe(1)
  })

  it('re-probes failed extractions once the negative TTL elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const { fetcher } = makeFetcher({}) // nothing resolvable at first
      const svc = createAppIconService(fetcher)
      const probe = vi.mocked(fetcher.fetchIcon)

      expect(await svc.resolve('C:\\Apps\\Code.exe')).toBeNull()
      expect(await svc.resolve('C:\\Apps\\Code.exe')).toBeNull() // negative hit
      expect(probe).toHaveBeenCalledTimes(1)

      probe.mockImplementation(async (p: string) => (p === 'C:\\Apps\\Code.exe' ? DATA_URL : null))
      vi.advanceTimersByTime(APP_ICON_NEGATIVE_TTL_MS + 1)

      expect(await svc.resolve('C:\\Apps\\Code.exe')).toBe(DATA_URL)
      expect(probe).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('seed respects the LRU cap', async () => {
    const { fetcher } = makeFetcher({})
    const svc = createAppIconService(fetcher, 2)
    svc.seed(new Map([
      ['c:\\a.exe', DATA_URL],
      ['c:\\b.exe', DATA_URL],
      ['c:\\c.exe', DATA_URL]
    ]))

    // Only the two newest survive seed-time eviction. Resolving the evicted
    // 'a' refetches (fails here) and its negative entry pushes out 'b'; 'c'
    // stays cached, and the later 'b' resolve finds it evicted (negative).
    expect(await svc.resolve('C:\\a.exe')).toBeNull()
    expect(await svc.resolve('C:\\c.exe')).toBe(DATA_URL)
    expect(await svc.resolve('C:\\b.exe')).toBeNull()
  })
})
