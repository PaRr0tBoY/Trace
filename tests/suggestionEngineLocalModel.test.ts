import { describe, expect, it, vi } from 'vitest'
import { createSuggestionEngine, MAX_LLM_CANDIDATES, type SuggestionEngine } from '../electron/main/suggestionEngine'
import { createIgnoredTable, type IgnoredTable } from '../electron/main/ignored'
import { createActivityLedger, DEFAULT_SEGMENT_PARAMS } from '../electron/store/activityLedger'
import { createMemoryEvidenceStore, evidenceFromUsageEvent, type EvidenceStore } from '../electron/store/evidenceStore'
import { TaskStore } from '../electron/store/TaskStore'
import type { AppSwitchEvent, CandidateActivity, TaskProposal, UsageEvent } from '../shared/types'
import { MAX_OPTIMIZER_INPUT, type CandidateOptimizer } from '../electron/store/localModelOptimizer'

/**
 * Local model integration (t54, spec 决策 6/11): the runAnalysis candidate
 * post-processing. 不变量 H — 关闭/失败 → 算法候选原样传递；生效 → 过滤 ≤3 /
 * 标题草稿 / 排序。The optimizer is always a fake (t53 precedent); the engine
 * seam is what's under test.
 */

describe('context budget equivalence (t54)', () => {
  it('keeps the optimizer input bound equal to the LLM annotation budget', () => {
    expect(MAX_OPTIMIZER_INPUT).toBe(MAX_LLM_CANDIDATES)
  })
})

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

/** One 3-event segment (1s gaps); segments are separated by a >10min hard gap. */
function segment(apps: Array<[string, string]>, base: number): UsageEvent[] {
  return apps.map(([app, title], i) => ev(app, base + i * 1_000, title))
}

/** 4 segments → 4 activities in one analysis pass. */
function fourSegments(): UsageEvent[] {
  return [
    ...segment([['Code', 'report.md — Code'], ['Chrome', 'docs.example.com'], ['Code', '']], 10_000),
    ...segment([['Figma', 'design.figma.com'], ['Code', 'design.png — Code'], ['Figma', '']], 700_000),
    ...segment([['Excel', 'budget.xlsx — Excel'], ['Outlook', 'mail'], ['Excel', '']], 1_400_000),
    ...segment([['Terminal', ''], ['Code', 'server.ts — Code'], ['Terminal', '']], 2_100_000)
  ]
}

interface Harness {
  engine: SuggestionEngine
  store: TaskStore
  events: UsageEvent[]
  evidence: EvidenceStore
  now: number
  ignored: IgnoredTable
  pushed: TaskProposal[][]
  optimizer: CandidateOptimizer | undefined
}

function makeHarness(optimizer?: CandidateOptimizer): Harness {
  const h: Harness = {
    events: [],
    now: 1_000_000,
    ignored: createIgnoredTable({ load: () => null, save: () => {} }),
    pushed: [],
    optimizer,
    store: new TaskStore({ load: () => null, save: () => {} }),
    evidence: createMemoryEvidenceStore()
  }
  h.engine = createSuggestionEngine({
    now: () => h.now,
    readEvents: () => h.events,
    store: h.store,
    getSettings: () => ({ suggestionMinEvents: 5, suggestionSilenceSeconds: 60 }),
    ledger: createActivityLedger({
      evidence: h.evidence,
      getTasks: () => h.store.list(),
      getParams: () => ({ ...DEFAULT_SEGMENT_PARAMS, confidenceHigh: 0.7, confidenceLow: 0.45 }),
      ignored: h.ignored
    }),
    onSuggestions: (sugs) => h.pushed.push(sugs),
    localModel: optimizer
  })
  return h
}

/** Push events (ring buffer + evidence timeline), advance the clock, await one tick. */
async function trigger(h: Harness, events: UsageEvent[], silenceMs = 60_000): Promise<void> {
  h.events.push(...events)
  for (const e of events) h.evidence.record(evidenceFromUsageEvent(e))
  h.now = events[events.length - 1].ts + silenceMs
  await h.engine.tick()
}

describe('runAnalysis local model post-processing', () => {
  it('passes the algorithm candidates through unchanged when no optimizer is wired (不变量 H)', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, fourSegments())
    expect(h.pushed).toHaveLength(1)
    expect(h.pushed[0]).toHaveLength(4)
    // Algorithm titles + algorithm order, untouched.
    const titles = h.pushed[0].map((s) => s.title)
    expect(titles.every((t) => t.length > 0)).toBe(true)
  })

  it('feeds the optimizer CandidateActivity and applies filter ≤3 / title drafts / rerank', async () => {
    let received: CandidateActivity[] | null = null
    const optimizer: CandidateOptimizer = {
      optimize: vi.fn().mockImplementation(async (candidates) => {
        received = candidates
        // Rerank: reverse the list; draft a title for the new first one.
        return candidates.map((c, i) => ({
          ...c,
          semanticLabel: i === candidates.length - 1 ? 'drafted top pick' : c.semanticLabel
        })).reverse()
      })
    }
    const h = makeHarness(optimizer)
    h.engine.start()
    await trigger(h, fourSegments())

    // The optimizer saw the unified intermediate structure.
    expect(received).not.toBeNull()
    expect(received!.length).toBe(4)
    for (const c of received!) {
      expect(c.activityId.length).toBeGreaterThan(0)
      expect(typeof c.score).toBe('number')
      expect(Array.isArray(c.evidenceRefs)).toBe(true)
      expect(typeof c.semanticLabel).toBe('string')
    }

    // Pushed: reranked (last activity first), title drafted, capped at ≤3
    // (spec 决策 6: 决策产出 ≤3 提案 — the engine enforces the cap even when
    // the optimizer over-delivers).
    const pushed = h.pushed[0]
    expect(pushed).toHaveLength(3)
    expect(pushed[0].title).toBe('drafted top pick')
  })

  it('caps the pushed list at 3 when the optimizer returns more', async () => {
    const optimizer: CandidateOptimizer = {
      // The optimizer ignores the cap contract and returns all 4; the engine
      // still pushes at most MAX_LOCAL_CANDIDATES.
      optimize: async (candidates) => candidates
    }
    const h = makeHarness(optimizer)
    h.engine.start()
    await trigger(h, fourSegments())
    expect(h.pushed[0]).toHaveLength(3)
  })

  it('drops candidates the optimizer filtered out', async () => {
    const optimizer: CandidateOptimizer = {
      optimize: async (candidates) => candidates.slice(0, 2)
    }
    const h = makeHarness(optimizer)
    h.engine.start()
    await trigger(h, fourSegments())
    expect(h.pushed[0]).toHaveLength(2)
  })

  it('degrades to the algorithm path when the optimizer returns null (不变量 H)', async () => {
    const optimizer: CandidateOptimizer = { optimize: async () => null }
    const h = makeHarness(optimizer)
    h.engine.start()
    await trigger(h, fourSegments())
    expect(h.pushed[0]).toHaveLength(4)
    // Same titles as the no-optimizer run (algorithm order preserved).
    const reference = makeHarness()
    reference.engine.start()
    await trigger(reference, fourSegments())
    expect(h.pushed[0].map((s) => s.title)).toEqual(reference.pushed[0].map((s) => s.title))
  })

  it('degrades to the algorithm path when the optimizer throws (不变量 H)', async () => {
    const optimizer: CandidateOptimizer = {
      optimize: async () => { throw new Error('runtime down') }
    }
    const h = makeHarness(optimizer)
    h.engine.start()
    await trigger(h, fourSegments())
    expect(h.pushed[0]).toHaveLength(4)
  })

  it('degrades when the optimizer returns an empty list (never silences the pipeline)', async () => {
    const optimizer: CandidateOptimizer = { optimize: async () => [] }
    const h = makeHarness(optimizer)
    h.engine.start()
    await trigger(h, fourSegments())
    expect(h.pushed[0]).toHaveLength(4)
  })

  it('keeps the algorithm attribution on accepted drafts (score/confidence untouched)', async () => {
    const optimizer: CandidateOptimizer = {
      optimize: async (candidates) => candidates.slice(0, 3).map((c) => ({ ...c, score: 0.99 }))
    }
    const h = makeHarness(optimizer)
    h.engine.start()
    await trigger(h, fourSegments())
    // The local model's rerank score must not overwrite the algorithm
    // confidence (归因全由算法).
    const algo = makeHarness()
    algo.engine.start()
    await trigger(algo, fourSegments())
    expect(h.pushed[0].map((s) => s.confidence)).toEqual(algo.pushed[0].slice(0, 3).map((s) => s.confidence))
    expect(h.pushed[0].every((s) => s.confidence !== 0.99)).toBe(true)
  })
})
