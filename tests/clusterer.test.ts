import { describe, expect, it } from 'vitest'

import {
  clusterEvents,
  prefilterTasks,
  segmentEvents,
  tokenizeTitle,
  validateParams,
  type ClusterParams,
  type EmbeddingChannel
} from '../electron/main/clusterer'
import type { AppSwitchEvent, Task } from '../shared/types'

/** Baseline params: defaults as t19 will inject from settings. */
const P: ClusterParams = {
  hardGapMs: 600_000,
  transientMs: 2_500,
  overlapThreshold: 0.3,
  confidenceHigh: 0.7,
  confidenceLow: 0.45
}

function ev(appName: string, ts: number, title = ''): AppSwitchEvent {
  return {
    type: 'app-switch',
    appName,
    exePath: `C:\\Apps\\${appName.toLowerCase()}.exe`,
    pid: 1,
    windowTitle: title,
    ts
  }
}

function task(id: string, title: string, apps: string[], lastActiveAt = 0): Task {
  return {
    id,
    title,
    status: 'active',
    apps: apps.map((a) => ({ id: a, name: a })),
    resources: [],
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt
  }
}

function summary(result: Awaited<ReturnType<typeof clusterEvents>>): string[] {
  return result.attributions.map((a) => `${a.zone}:${a.taskId ?? 'new'}`)
}

describe('tokenizeTitle', () => {
  it('keeps ascii words, drops stopwords, digits and single letters', () => {
    expect(tokenizeTitle('The main.ts file v1.2.3')).toEqual(['main', 'ts', 'file', 'v1'])
  })
  it('splits CJK titles into overlapping bigrams', () => {
    expect(tokenizeTitle('查资料')).toEqual(['查资', '资料'])
    expect(tokenizeTitle('A')).toEqual([])
    expect(tokenizeTitle('报')).toEqual(['报'])
  })
  it('is case-insensitive', () => {
    expect(tokenizeTitle('VS Code')).toEqual(['vs', 'code'])
  })
})

describe('validateParams', () => {
  it('accepts sane params', () => {
    expect(() => validateParams(P)).not.toThrow()
  })
  it('rejects hardGapMs ≤ transientMs', () => {
    expect(() => validateParams({ ...P, hardGapMs: 5_000, transientMs: 10_000 })).toThrow(/hardGapMs/)
  })
  it('rejects non-positive gaps and NaNs', () => {
    expect(() => validateParams({ ...P, hardGapMs: 0 })).toThrow(/hardGapMs/)
    expect(() => validateParams({ ...P, transientMs: Number.NaN })).toThrow(/transientMs/)
  })
  it('rejects inverted or out-of-range confidence thresholds', () => {
    expect(() => validateParams({ ...P, confidenceHigh: 0.4, confidenceLow: 0.6 })).toThrow(/confidenceHigh/)
    expect(() => validateParams({ ...P, confidenceHigh: 1.2 })).toThrow(/confidenceHigh/)
    expect(() => validateParams({ ...P, confidenceLow: 0 })).toThrow(/confidenceLow/)
  })
  it('rejects out-of-range overlap thresholds', () => {
    expect(() => validateParams({ ...P, overlapThreshold: 1.01 })).toThrow(/overlapThreshold/)
  })
  it('accepts boundary values (overlap 0 = pure-timeout segmentation)', () => {
    expect(() => validateParams({ ...P, overlapThreshold: 0, confidenceHigh: 1 })).not.toThrow()
  })
})

describe('segmentEvents — 时间间隙硬切分', () => {
  it('returns nothing for an empty batch', () => {
    expect(segmentEvents([], P)).toEqual([])
  })
  it('returns one zero-duration segment for a single event', () => {
    const segs = segmentEvents([ev('Code', 0)], P)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ startTs: 0, endTs: 0, durationMs: 0, eventCount: 1, appNames: ['Code'] })
  })
  it('splits when the gap is at least hardGapMs (boundary inclusive)', () => {
    const segs = segmentEvents([ev('Code', 0), ev('Chrome', 600_000)], P)
    expect(segs).toHaveLength(2)
    expect(segs[1].startTs).toBe(600_000)
  })
  it('does not split below hardGapMs (same app set merges back)', () => {
    const segs = segmentEvents([ev('Code', 0), ev('Code', 599_999)], P)
    expect(segs).toHaveLength(1)
  })
  it('handles events out of order (batch is normalized to ts order)', () => {
    const segs = segmentEvents([ev('Chrome', 700_000), ev('Code', 0)], P)
    expect(segs).toHaveLength(2)
    expect(segs[0].appNames).toEqual(['Code'])
  })
})

describe('segmentEvents — 瞬时切换并入', () => {
  it('merges a sub-transient gap into the preceding events', () => {
    const segs = segmentEvents([ev('Code', 0), ev('Chrome', 1_000)], P)
    expect(segs).toHaveLength(1)
    expect(segs[0].appNames).toEqual(['Code', 'Chrome'])
    expect(segs[0].durationMs).toBe(1_000)
  })
  it('collapses rapid A-B-A switching into one segment', () => {
    const segs = segmentEvents(
      [ev('Code', 0), ev('Chrome', 500), ev('Code', 1_000), ev('Chrome', 1_500)],
      P
    )
    expect(segs).toHaveLength(1)
    expect(segs[0].eventCount).toBe(4)
  })
  it('a blip before a hard gap stays with its left neighbor (dwell-ordered apps)', () => {
    const segs = segmentEvents([ev('Code', 0), ev('Chrome', 1_000), ev('Chrome', 700_000)], P)
    expect(segs).toHaveLength(2)
    expect(segs[0].appNames).toEqual(['Chrome', 'Code'])
    expect(segs[1].appNames).toEqual(['Chrome'])
  })
  it('transient boundary is inclusive (gap == transientMs splits)', () => {
    const segs = segmentEvents([ev('Code', 0), ev('Chrome', 2_500)], P)
    expect(segs).toHaveLength(2)
  })
})

describe('segmentEvents — 应用重叠率软切分', () => {
  it('splits disjoint app sets on a moderate gap', () => {
    const segs = segmentEvents([ev('Code', 0), ev('Chrome', 180_000)], P)
    expect(segs).toHaveLength(2)
  })
  it('merges overlapping app sets on the same gap', () => {
    const segs = segmentEvents([ev('Code', 0), ev('Code', 180_000)], P)
    expect(segs).toHaveLength(1)
  })
  it('merge threshold is inclusive (overlap == overlapThreshold)', () => {
    // [Code, Chrome] vs [Chrome]: overlap 1/2 = 0.5; threshold 0.5 merges,
    // a hair above splits.
    const events = [ev('Code', 0), ev('Chrome', 100), ev('Chrome', 180_000)]
    expect(segmentEvents(events, { ...P, overlapThreshold: 0.5 })).toHaveLength(1)
    expect(segmentEvents(events, { ...P, overlapThreshold: 0.51 })).toHaveLength(2)
  })
  it('Code → Chrome → Code with moderate gaps yields three segments', () => {
    const segs = segmentEvents(
      [ev('Code', 0), ev('Code', 180_000), ev('Chrome', 360_000), ev('Chrome', 540_000), ev('Code', 720_000)],
      P
    )
    expect(segs.map((s) => s.appNames)).toEqual([['Code'], ['Chrome'], ['Code']])
  })
  it('hard gaps force separation even with identical apps', () => {
    const segs = segmentEvents([ev('Code', 0), ev('Code', 600_000)], P)
    expect(segs).toHaveLength(2)
  })
  it('app identity matches on name, ignoring exePath case and slashes', () => {
    const segs = segmentEvents(
      [
        { ...ev('Code', 0), exePath: 'c:\\apps\\code.exe' },
        { ...ev('Code', 180_000), exePath: 'C:/Apps/Code.EXE' }
      ],
      P
    )
    expect(segs).toHaveLength(1)
  })
  it('events with no app identity still form a segment', () => {
    const segs = segmentEvents([{ ...ev('', 0), exePath: '' }], P)
    expect(segs).toHaveLength(1)
    expect(segs[0].appNames).toEqual([])
  })
  it('aggregates dwell-weighted app order and title tokens', () => {
    const segs = segmentEvents(
      [
        ev('Chrome', 0, 'research'),
        ev('Chrome', 100_000, 'main.ts'),
        ev('Chrome', 200_000),
        ev('Code', 200_100)
      ],
      P
    )
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({
      durationMs: 200_100,
      appNames: ['Chrome', 'Code'],
      windowTitles: ['main.ts', 'research'],
      titleTokens: ['main', 'research', 'ts']
    })
  })
})

describe('prefilterTasks — 规则预筛', () => {
  it('keeps tasks sharing an app with the batch, drops the rest', () => {
    const tasks = [task('t1', 'coding', ['Code']), task('t2', 'browsing', ['Chrome'])]
    const pool = prefilterTasks([ev('Code', 0)], tasks)
    expect(pool.map((t) => t.id)).toEqual(['t1'])
  })
  it('matches on exePath when the task app has no display name', () => {
    const tasks: Task[] = [{
      id: 't1',
      title: 'x',
      status: 'active',
      apps: [{ id: 'c:/apps/code.exe', name: '' }],
      resources: [],
      createdAt: 0,
      updatedAt: 0,
      lastActiveAt: 0
    }]
    const pool = prefilterTasks([ev('Code', 0)], tasks)
    expect(pool.map((t) => t.id)).toEqual(['t1'])
  })
  it('returns nothing for an empty batch', () => {
    expect(prefilterTasks([], [task('t1', 'coding', ['Code'])])).toEqual([])
  })
  it('prefilter gates clustering: title overlap alone cannot attach a segment', async () => {
    // The Chrome task shares no app with this Code-only batch, so the
    // Chrome segment must come back as a new candidate despite title overlap.
    const result = await clusterEvents(
      [ev('Code', 0, 'chrome docs')],
      [task('t1', 'browsing', ['Chrome'])],
      P
    )
    expect(result.attributions[0]).toMatchObject({ taskId: null, zone: 'new', confidence: 0 })
  })
})

describe('clusterEvents — 三区置信度', () => {
  it('exact app match, single candidate → high with margin == best', async () => {
    const result = await clusterEvents([ev('Code', 0)], [task('t1', 'coding', ['Code'])], P)
    // appScore 1.0 → 0.7; no titles → titleScore 0; single candidate → margin = best
    expect(result.attributions[0]).toMatchObject({
      taskId: 't1',
      zone: 'high',
      confidence: 0.7,
      bestScore: 0.7,
      secondScore: 0,
      margin: 0.7
    })
  })
  it('no candidate pool → new', async () => {
    const result = await clusterEvents([ev('Code', 0)], [], P)
    expect(result.attributions[0]).toMatchObject({ taskId: null, zone: 'new', confidence: 0, margin: 0 })
  })
  it('disjoint apps and titles → new (below θ_low)', async () => {
    const result = await clusterEvents(
      [ev('Chrome', 0, 'research page')],
      [task('t1', 'coding', ['Code'])],
      P
    )
    expect(result.attributions[0]).toMatchObject({ taskId: null, zone: 'new' })
  })
  it('partial app match with matching title → low (θ_low ≤ conf < θ_high)', async () => {
    // {Code} vs {Code, Chrome}: appScore 0.5 → 0.35; title Jaccard 1 → 0.3;
    // combined 0.65 sits in the low band.
    const result = await clusterEvents(
      [ev('Code', 0, 'cad plugin')],
      [task('t1', 'cad plugin', ['Code', 'Chrome'])],
      P
    )
    const a = result.attributions[0]
    expect(a.zone).toBe('low')
    expect(a.taskId).toBe('t1')
    expect(a.bestScore).toBeCloseTo(0.65, 10)
  })
  it('identical tasks tie → low with margin 0', async () => {
    const result = await clusterEvents(
      [ev('Code', 0)],
      [task('t1', 'coding', ['Code']), task('t2', 'coding', ['Code'])],
      P
    )
    expect(result.attributions[0]).toMatchObject({ taskId: 't1', zone: 'low', margin: 0, bestScore: 0.7 })
  })
  it('best ≥ θ_high but margin below the band width → low', async () => {
    // seg {Code} 'alpha': T1 'alpha' → 1.0; T2 'alpha beta' → 0.85;
    // margin 0.15 < θ_high − θ_low (0.25) → the near-tie is not high-confidence.
    const result = await clusterEvents(
      [ev('Code', 0, 'alpha')],
      [task('t1', 'alpha', ['Code']), task('t2', 'alpha beta', ['Code'])],
      P
    )
    const a = result.attributions[0]
    expect(a.bestScore).toBeCloseTo(1, 10)
    expect(a.secondScore).toBeCloseTo(0.85, 10)
    expect(a.margin).toBeCloseTo(0.15, 10)
    expect(a.zone).toBe('low')
  })
  it('clear winner with margin above the floor → high', async () => {
    const result = await clusterEvents(
      [ev('Code', 0, 'alpha')],
      [task('t1', 'alpha', ['Code']), task('t2', 'unrelated', ['Chrome'])],
      P
    )
    expect(result.attributions[0]).toMatchObject({ taskId: 't1', zone: 'high' })
    expect(result.attributions[0].margin).toBeCloseTo(1, 10)
  })
  it('overlappingTasks excludes the winner, sorted by score, capped at 3', async () => {
    const result = await clusterEvents(
      [ev('Code', 0)],
      [
        task('t1', 'one', ['Code']),
        task('t2', 'two', ['Code']),
        task('t3', 'three', ['Code']),
        task('t4', 'four', ['Code'])
      ],
      P
    )
    const a = result.attributions[0]
    expect(a.taskId).toBe('t1')
    expect(a.evidence.overlappingTasks).toHaveLength(3)
    expect(a.evidence.overlappingTasks).not.toContain('one')
  })
  it('evidence: appCombination is dwell-ordered and capped at 5', async () => {
    const result = await clusterEvents(
      [
        ev('A', 0), ev('B', 100), ev('C', 200), ev('D', 300),
        ev('E', 400), ev('F', 500)
      ],
      [task('t1', 'x', ['A'])],
      P
    )
    expect(result.attributions[0].evidence.appCombination).toBe('A, B, C, D, E (+1)')
    expect(result.attributions[0].evidence.durationMs).toBe(500)
  })
  it('empty batch → empty result', async () => {
    expect(await clusterEvents([], [task('t1', 'x', ['Code'])], P)).toEqual({ attributions: [] })
  })
})

describe('clusterEvents — 跨任务切分（查资料回写代码）', () => {
  it('research segment becomes a new candidate while code segments return to the code task', async () => {
    const tasks = [task('t1', 'fix flaky test', ['Code']), task('t2', 'research tracing', ['Chrome'])]
    const events = [
      ev('Code', 0), ev('Code', 180_000), // code 1
      ev('Chrome', 360_000), ev('Chrome', 540_000), // research
      ev('Code', 720_000), ev('Code', 900_000) // code 2
    ]
    const result = await clusterEvents(events, tasks, P)
    expect(result.attributions).toHaveLength(3)
    expect(summary(result)).toEqual(['high:t1', 'high:t2', 'high:t1'])
  })
  it('code task merges back even when the research app has no task yet', async () => {
    const result = await clusterEvents(
      [ev('Code', 0), ev('Chrome', 180_000), ev('Chrome', 360_000), ev('Code', 540_000)],
      [task('t1', 'fix flaky test', ['Code'])],
      P
    )
    expect(summary(result)).toEqual(['high:t1', 'new:new', 'high:t1'])
    expect(result.attributions[1].evidence.overlappingTasks).toEqual([])
  })
})

describe('clusterEvents — 增量簇归属与吸收', () => {
  it('a merged segment teaches its task new apps for later segments in the batch', async () => {
    // overlapThreshold 0 → segmentation is pure hard-gap, so the mixed-app
    // segments stay whole: seg1 [Code, Chrome] @0, seg2 [Code, Chrome] @1.4M.
    const P0 = { ...P, overlapThreshold: 0 }
    const events = [
      ev('Code', 0, 'cad plugin'), ev('Chrome', 60_000, 'cad plugin'),
      ev('Code', 1_400_000, 'cad plugin'), ev('Chrome', 1_460_000, 'cad plugin')
    ]
    const withAbsorption = await clusterEvents(events, [task('t1', 'cad plugin', ['Code'])], P0)
    // seg1: appScore 0.5 → 0.65 → low (pending merge, absorbs Chrome into t1).
    // seg2 then sees {Code, Chrome} → 1.0 → high.
    expect(summary(withAbsorption)).toEqual(['low:t1', 'high:t1'])

    // Control: the same second segment against a fresh task (no absorption)
    // only reaches the low band.
    const fresh = await clusterEvents(
      [ev('Code', 1_400_000, 'cad plugin'), ev('Chrome', 1_460_000, 'cad plugin')],
      [task('t1', 'cad plugin', ['Code'])],
      P0
    )
    expect(summary(fresh)).toEqual(['low:t1'])
  })
})

describe('clusterEvents — embedding 通道与降级', () => {
  const embedOf = (map: Record<string, number[]>): EmbeddingChannel => ({
    embed: async (texts) => texts.map((t) => map[t] ?? [0, 0, 0])
  })

  it('uses cosine over embeddings for title similarity when the channel works', async () => {
    const embed = embedOf({
      'cad plugin': [1, 0, 0],
      'cad plugin window': [1, 0.5, 0]
    })
    const result = await clusterEvents(
      [ev('Code', 0, 'cad plugin window')],
      [task('t1', 'cad plugin', ['Code'])],
      P,
      embed
    )
    // cosine([1,0,0],[1,0.5,0]) = 1/√1.25 ≈ 0.8944 → 0.7 + 0.3·0.8944
    expect(result.attributions[0].bestScore).toBeCloseTo(0.9683, 3)
    expect(result.attributions[0].zone).toBe('high')
  })

  it('token path computes the same score without a channel', async () => {
    // tokens {cad,plugin} vs {cad,plugin,window} → 2/3 → 0.7 + 0.3·(2/3) = 0.9
    const result = await clusterEvents(
      [ev('Code', 0, 'cad plugin window')],
      [task('t1', 'cad plugin', ['Code'])],
      P
    )
    expect(result.attributions[0].bestScore).toBeCloseTo(0.9, 10)
  })

  it('falls back to the token path when the channel throws', async () => {
    const failing: EmbeddingChannel = {
      embed: async () => { throw new Error('ollama down') }
    }
    const withEmbed = await clusterEvents(
      [ev('Code', 0, 'cad plugin window')],
      [task('t1', 'cad plugin', ['Code'])],
      P,
      failing
    )
    const without = await clusterEvents(
      [ev('Code', 0, 'cad plugin window')],
      [task('t1', 'cad plugin', ['Code'])],
      P
    )
    expect(withEmbed).toEqual(without)
  })

  it('falls back when the channel returns malformed rows (wrong count, NaN, ragged dims)', async () => {
    const short: EmbeddingChannel = { embed: async (texts) => texts.slice(0, -1).map(() => [1]) }
    const nan: EmbeddingChannel = { embed: async (texts) => texts.map(() => [Number.NaN]) }
    const ragged: EmbeddingChannel = { embed: async (texts) => texts.map((_, i) => [1, 2, 3].slice(0, 1 + (i % 3))) }
    const base = [ev('Code', 0, 'cad plugin window')]
    const tasks = [task('t1', 'cad plugin', ['Code'])]
    const expected = await clusterEvents(base, tasks, P)
    expect(await clusterEvents(base, tasks, P, short)).toEqual(expected)
    expect(await clusterEvents(base, tasks, P, nan)).toEqual(expected)
    expect(await clusterEvents(base, tasks, P, ragged)).toEqual(expected)
  })

  it('empty titles score 0 on the embedding path (no crash, no phantom signal)', async () => {
    const result = await clusterEvents(
      [ev('Code', 0, '')],
      [task('t1', 'cad plugin', ['Code'])],
      P,
      embedOf({ 'cad plugin': [1, 0, 0] })
    )
    // Channel is accepted (zero row for ''), but the empty-title guard
    // returns titleScore 0 → appScore 1.0 → 0.7.
    expect(result.attributions[0].bestScore).toBeCloseTo(0.7, 10)
    expect(result.attributions[0].zone).toBe('high')
  })

  it('zero-vector rows score title 0 (embedding path, not fallback)', async () => {
    // All-zero rows are valid channel output; cosine = 0. The token path
    // would score 0.9 here (title Jaccard 2/3), so 0.7 proves the embed
    // path ran and produced nothing for the title channel.
    const result = await clusterEvents(
      [ev('Code', 0, 'cad plugin window')],
      [task('t1', 'cad plugin', ['Code'])],
      P,
      embedOf({})
    )
    expect(result.attributions[0].bestScore).toBeCloseTo(0.7, 10)
  })

  it('absorption behaves identically with and without an embed channel', async () => {
    const P0 = { ...P, overlapThreshold: 0 }
    const events = [
      ev('Code', 0, 'cad plugin'), ev('Chrome', 60_000, 'cad plugin'),
      ev('Code', 1_400_000, 'cad plugin'), ev('Chrome', 1_460_000, 'cad plugin')
    ]
    const tasks = [task('t1', 'cad plugin', ['Code'])]
    const withEmbed = await clusterEvents(events, tasks, P0, embedOf({ 'cad plugin': [1, 0, 0] }))
    const without = await clusterEvents(events, tasks, P0)
    expect(withEmbed).toEqual(without)
    expect(summary(withEmbed)).toEqual(['low:t1', 'high:t1'])
  })
})

describe('clusterEvents — 置信度边界（含等号侧语义）', () => {
  // θ_high 0.7 / θ_low 0.5 → margin floor 0.2; scores 0.5 and 0.7 are
  // exactly representable here (0.35 + 0.15 and 0.7 + 0), so the inclusive
  // boundaries are deterministic in float arithmetic.
  const P50 = { ...P, confidenceHigh: 0.7, confidenceLow: 0.5 }

  it('best == θ_low exactly → low, not new (θ_low is inclusive)', async () => {
    // appScore 0.5 ({Code} vs {Code, Chrome}) → 0.35; title Jaccard 1/2 → 0.15
    const result = await clusterEvents(
      [ev('Code', 0, 'alpha beta')],
      [task('t1', 'alpha', ['Code', 'Chrome'])],
      P50
    )
    expect(result.attributions[0]).toMatchObject({ zone: 'low', taskId: 't1', bestScore: 0.5, margin: 0.5 })
  })

  it('best == θ_high and margin == floor exactly → high (both inclusive)', async () => {
    // T1 {Code} 'xyz' → 0.7; T2 {Code, Chrome} 'alpha' → 0.5; margin 0.2 = floor
    const result = await clusterEvents(
      [ev('Code', 0, 'alpha beta')],
      [task('t1', 'xyz', ['Code']), task('t2', 'alpha', ['Code', 'Chrome'])],
      P50
    )
    const a = result.attributions[0]
    expect(a.zone).toBe('high')
    expect(a.taskId).toBe('t1')
    expect(a.bestScore).toBe(0.7)
    expect(a.margin).toBeCloseTo(0.2, 10)
  })

  it('best just below θ_low → new', async () => {
    // appScore 0.5 → 0.35; title Jaccard 1/5 → 0.06 → 0.41 < 0.45
    const result = await clusterEvents(
      [ev('Code', 0, 'alpha beta gamma delta epsilon')],
      [task('t1', 'alpha', ['Code', 'Chrome'])],
      P
    )
    expect(result.attributions[0]).toMatchObject({ zone: 'new', taskId: null })
    expect(result.attributions[0].bestScore).toBeCloseTo(0.41, 10)
  })
})

describe('clusterEvents — 参数注入', () => {
  it('confidence thresholds come from params, not constants', async () => {
    const events = [ev('Code', 0)]
    const tasks = [task('t1', 'coding', ['Code'])]
    // 0.7 with default thresholds → high
    expect((await clusterEvents(events, tasks, P)).attributions[0].zone).toBe('high')
    // same data, band moved above 0.7 → low
    const shifted = await clusterEvents(
      events,
      tasks,
      { ...P, confidenceHigh: 0.8, confidenceLow: 0.6 }
    )
    expect(shifted.attributions[0]).toMatchObject({ zone: 'low', taskId: 't1' })
  })
  it('hardGapMs from params changes the split', async () => {
    const events = [ev('Code', 0), ev('Code', 120_000)]
    expect(segmentEvents(events, P)).toHaveLength(1)
    expect(segmentEvents(events, { ...P, hardGapMs: 60_000 })).toHaveLength(2)
  })
  it('overlapThreshold from params changes the soft split', async () => {
    // last boundary: {Code} vs {Code, Chrome} → overlap 0.5
    const events = [ev('Code', 0), ev('Code', 180_000), ev('Code', 360_000), ev('Chrome', 362_000)]
    expect(segmentEvents(events, P)).toHaveLength(1)
    expect(segmentEvents(events, { ...P, overlapThreshold: 0.8 })).toHaveLength(2)
  })
  it('transientMs from params changes the merge', async () => {
    const events = [ev('Code', 0), ev('Chrome', 30_000)]
    expect(segmentEvents(events, P)).toHaveLength(2)
    expect(segmentEvents(events, { ...P, transientMs: 60_000 })).toHaveLength(1)
  })
})
