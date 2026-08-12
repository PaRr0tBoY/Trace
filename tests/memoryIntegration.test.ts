import { describe, expect, it, vi } from 'vitest'

import {
  createSuggestionEngine,
  buildMemoryCandidate,
  matchMemories,
  MEMORY_CONFIDENCE_BOOST,
  type SuggestionEngine
} from '../electron/main/suggestionEngine'
import { createIgnoredTable } from '../electron/main/ignored'
import { createActivityLedger, DEFAULT_SEGMENT_PARAMS } from '../electron/store/activityLedger'
import { createMemoryEvidenceStore, evidenceFromUsageEvent, type EvidenceStore } from '../electron/store/evidenceStore'
import { MemoryStore, type MemoryIndex } from '../electron/store/MemoryStore'
import { TaskStore } from '../electron/store/TaskStore'
import type { AppSwitchEvent, Memory, MemoryType, TaskProposal, UsageEvent } from '../shared/types'
import type { ChatFn } from '../electron/main/provider'

/** One segment's events (same shape as suggestionEngine.test.ts). */
function batch(base = 10_000): UsageEvent[] {
  return [
    { type: 'app-switch', appName: 'Code', exePath: 'C:\\Apps\\code.exe', pid: 1, windowTitle: '', ts: base },
    { type: 'app-switch', appName: 'Code', exePath: 'C:\\Apps\\code.exe', pid: 1, windowTitle: 'report.md — Code', ts: base + 1_000 },
    { type: 'app-switch', appName: 'Chrome', exePath: 'C:\\Apps\\chrome.exe', pid: 1, windowTitle: 'docs.example.com', ts: base + 2_000 },
    { type: 'app-switch', appName: 'Chrome', exePath: 'C:\\Apps\\chrome.exe', pid: 1, windowTitle: '', ts: base + 3_000 },
    { type: 'app-switch', appName: 'Code', exePath: 'C:\\Apps\\code.exe', pid: 1, windowTitle: '', ts: base + 4_000 }
  ]
}

interface Harness {
  engine: SuggestionEngine
  store: TaskStore
  events: UsageEvent[]
  evidence: EvidenceStore
  now: number
  settings: { suggestionMinEvents: number; suggestionSilenceSeconds: number; confidenceHigh: number; confidenceLow: number }
  ignored: ReturnType<typeof createIgnoredTable>
  pushed: TaskProposal[][]
  chat: ChatFn | undefined
}

function makeHarness(opts?: { memories?: () => readonly Memory[]; onMemorySuggestion?: (c: { type: MemoryType; content: string }) => void }): Harness {
  const h: Harness = {
    events: [],
    now: 1_000_000,
    settings: { suggestionMinEvents: 5, suggestionSilenceSeconds: 60, confidenceHigh: 0.7, confidenceLow: 0.45 },
    ignored: createIgnoredTable({ load: () => null, save: () => {} }),
    pushed: [],
    chat: undefined,
    store: new TaskStore({ load: () => null, save: () => {} }),
    evidence: createMemoryEvidenceStore()
  }
  h.engine = createSuggestionEngine({
    now: () => h.now,
    readEvents: () => h.events,
    store: h.store,
    getSettings: () => h.settings,
    ledger: createActivityLedger({
      evidence: h.evidence,
      getTasks: () => h.store.list(),
      getParams: () => ({
        ...DEFAULT_SEGMENT_PARAMS,
        confidenceHigh: h.settings.confidenceHigh,
        confidenceLow: h.settings.confidenceLow
      }),
      ignored: h.ignored
    }),
    onSuggestions: (s) => h.pushed.push(s),
    ...(opts?.memories ? { readMemories: opts.memories } : {}),
    ...(opts?.onMemorySuggestion ? { onMemorySuggestion: opts.onMemorySuggestion } : {})
  })
  return h
}

async function trigger(h: Harness, events: UsageEvent[]): Promise<void> {
  h.events.push(...events)
  for (const e of events) h.evidence.record(evidenceFromUsageEvent(e))
  h.now = events[events.length - 1].ts + 60_000
  await h.engine.tick()
}

/** Real MemoryStore harness with injected clock, mirroring memoryStore.test.ts. */
function memoryHarness() {
  let saved: MemoryIndex | null = null
  let now = 1_000_000
  const store = new MemoryStore({ load: () => saved, save: (i) => { saved = i }, now: () => now })
  store.load()
  const suggest = (type: MemoryType, content: string) => store.suggestMemory({ type, content, source: 'task-feedback' })
  return { store, suggest, tick: (ms: number) => { now += ms } }
}

describe('buildMemoryCandidate (feedback distillation)', () => {
  it('uses the confirmed title as a project candidate', () => {
    expect(buildMemoryCandidate('  CAD Agent  ')).toEqual({ type: 'project', content: 'CAD Agent' })
  })

  it('returns null for blank titles', () => {
    expect(buildMemoryCandidate('   ')).toBeNull()
    expect(buildMemoryCandidate('')).toBeNull()
  })
})

describe('matchMemories (context-prior)', () => {
  const memory = (type: MemoryType, content: string, userState: Memory['userState'] = 'confirmed'): Memory => ({
    id: `m_${type}_${content.length}`,
    type,
    content,
    confidence: 0.5,
    hitCount: 1,
    lastSeenAt: 1,
    createdAt: 1,
    source: 'task-feedback',
    userState
  })

  it('matches a confirmed project memory against window titles', () => {
    const hits = matchMemories(
      [{ appNames: ['Code', 'Chrome'], windowTitles: ['cad agent planning — Code'] }],
      [memory('project', 'CAD Agent')]
    )
    expect(hits[0]).toEqual(['CAD Agent'])
  })

  it('matches in the other direction: segment terms inside a longer memory', () => {
    const hits = matchMemories(
      [{ appNames: ['Code'], windowTitles: ['rust borrow checker'] }],
      [memory('workflow', 'rust borrow checker 调试流程')]
    )
    expect(hits[0]).toEqual(['rust borrow checker 调试流程'])
  })

  it('ignores identity/tool memories and anything not confirmed', () => {
    const memories = [
      memory('identity', '双学位'),
      memory('tool', 'koffi'),
      memory('project', 'CAD Agent', 'suggested'),
      memory('project', 'CAD Agent', 'banned'),
      memory('project', 'CAD Agent', 'ignored'),
      memory('project', 'CAD Agent', 'confirmed')
    ]
    const hits = matchMemories([{ appNames: [], windowTitles: ['CAD Agent'] }], memories)
    expect(hits[0]).toEqual(['CAD Agent'])
  })

  it('returns empty hits for empty segment text or no matches', () => {
    expect(matchMemories([{ appNames: [], windowTitles: [] }], [memory('project', 'CAD')])[0]).toEqual([])
    expect(matchMemories([{ appNames: ['Code'], windowTitles: ['write report'] }], [memory('project', 'CAD')])[0]).toEqual([])
  })
})

describe('feedback distillation through the engine (accept -> MemoryStore)', () => {
  it('accepting a suggestion creates a suggested project candidate', async () => {
    const mh = memoryHarness()
    const h = makeHarness({
      onMemorySuggestion: (c) => mh.store.suggestMemory({ ...c, source: 'task-feedback' })
    })
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id)

    const candidates = mh.store.candidates()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].type).toBe('project')
    expect(candidates[0].content).toBe(s.title)
    expect(candidates[0].userState).toBe('suggested')
    expect(candidates[0].source).toBe('task-feedback')
  })

  it('honours the title override in the candidate', async () => {
    const mh = memoryHarness()
    const h = makeHarness({ onMemorySuggestion: (c) => mh.store.suggestMemory({ ...c, source: 'task-feedback' }) })
    h.engine.start()
    await trigger(h, batch())
    h.engine.accept(h.pushed[0][0].id, { title: '开发 CAD Agent' })
    expect(mh.store.candidates()[0].content).toBe('开发 CAD Agent')
  })

  it('a banned type intercepts the candidate (never proposed again)', async () => {
    const mh = memoryHarness()
    const veto = mh.suggest('project', '旧项目')!
    mh.store.ban(veto.id) // retires the whole project category
    const h = makeHarness({ onMemorySuggestion: (c) => mh.store.suggestMemory({ ...c, source: 'task-feedback' }) })
    h.engine.start()
    await trigger(h, batch())
    h.engine.accept(h.pushed[0][0].id)
    expect(mh.store.candidates()).toHaveLength(0)
  })

  it('no candidate for a stale suggestion id', async () => {
    const mh = memoryHarness()
    const h = makeHarness({ onMemorySuggestion: (c) => mh.store.suggestMemory({ ...c, source: 'task-feedback' }) })
    h.engine.start()
    expect(h.engine.accept('s_unknown')).toBeNull()
    expect(mh.store.candidates()).toHaveLength(0)
  })
})

describe('context-prior in the engine (boost + LLM input)', () => {
  it('boosts confidence by the fixed gain when a memory matches', async () => {
    const noPrior = makeHarness()
    noPrior.engine.start()
    await trigger(noPrior, batch())
    const base = noPrior.pushed[0][0].confidence

    const mh = memoryHarness()
    const mem = mh.suggest('project', 'CAD Agent')!
    mh.store.confirm(mem.id)
    const withPrior = makeHarness({ memories: () => mh.store.list() })
    withPrior.engine.start()
    await trigger(withPrior, singleTitleBatch('cad agent'))
    const boosted = withPrior.pushed[0][0].confidence

    expect(boosted).toBeCloseTo(Math.min(1, base + MEMORY_CONFIDENCE_BOOST), 10)
  })

  it('never boosts without a memory hit', async () => {
    const mh = memoryHarness()
    const mem = mh.suggest('project', 'CAD Agent')!
    mh.store.confirm(mem.id)
    const h = makeHarness({ memories: () => mh.store.list() })
    h.engine.start()
    await trigger(h, batch()) // titles don't mention CAD Agent
    const s = h.pushed[0][0]
    // Baseline run, same events, no memories.
    const base = makeHarness()
    base.engine.start()
    await trigger(base, batch())
    expect(s.confidence).toBeCloseTo(base.pushed[0][0].confidence, 10)
  })

  it('carries the matched memory content into the LLM prompt as memoryContext', async () => {
    const mh = memoryHarness()
    const mem = mh.suggest('project', 'CAD Agent')!
    mh.store.confirm(mem.id)
    const h = makeHarness({ memories: () => mh.store.list() })
    h.chat = vi.fn(async () => ({
      ok: true,
      content: '{"items":[{"title":"CAD Agent","reason":"editor + browser session"}]}',
      parsed: { items: [{ title: 'CAD Agent', reason: 'editor + browser session' }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, singleTitleBatch('cad agent'))

    const userMsg = (h.chat as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[1].content as string
    const parsed = JSON.parse(userMsg.slice('Segments: '.length)) as { segments: Array<{ memoryContext?: string[] }> }
    expect(parsed.segments[0].memoryContext).toEqual(['CAD Agent'])
  })

  it('omits memoryContext when nothing matched', async () => {
    const mh = memoryHarness()
    const mem = mh.suggest('project', 'CAD Agent')!
    mh.store.confirm(mem.id)
    const h = makeHarness({ memories: () => mh.store.list() })
    h.chat = vi.fn(async () => ({
      ok: true,
      content: '{"items":[{"title":"x","reason":"y"}]}',
      parsed: { items: [{ title: 'x', reason: 'y' }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())

    const userMsg = (h.chat as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[1].content as string
    const parsed = JSON.parse(userMsg.slice('Segments: '.length)) as { segments: Array<{ memoryContext?: string[] }> }
    expect(parsed.segments[0].memoryContext).toBeUndefined()
  })
})

describe('unban (banned patterns are liftable)', () => {
  it('unban restores the category and stops the veto; entry lands in ignored', () => {
    const mh = memoryHarness()
    const veto = mh.suggest('workflow', '写周报')!
    mh.store.ban(veto.id)
    expect(mh.store.isBanned('写周报的任何变体', 'project')).toBe(true)
    expect(mh.store.isBanned('别的', 'workflow')).toBe(true) // type retired

    expect(mh.store.unban(veto.id)).toBe(true)
    expect(mh.store.get(veto.id)!.userState).toBe('ignored') // dead, never live
    expect(mh.store.isBanned('别的', 'workflow')).toBe(false)
    // Same content+type still deduped (only the veto is lifted).
    expect(mh.store.suggestMemory({ type: 'workflow', content: '写周报', source: 'task-feedback' })).toBeNull()
    // Other content in the un-banned category is fine again.
    expect(mh.store.suggestMemory({ type: 'workflow', content: '每日站会', source: 'task-feedback' })).not.toBeNull()
  })

  it('unban is a no-op for non-banned memories', () => {
    const mh = memoryHarness()
    const m = mh.suggest('tool', 'koffi')!
    mh.store.confirm(m.id)
    expect(mh.store.unban(m.id)).toBe(false)
    expect(mh.store.unban('m_missing')).toBe(false)
  })

  it('ban -> unban -> ban round-trips', () => {
    const mh = memoryHarness()
    const m = mh.suggest('project', 'CAD')!
    mh.store.ban(m.id)
    mh.store.unban(m.id)
    expect(mh.store.ban(m.id)).toBe(true)
    expect(mh.store.get(m.id)!.userState).toBe('banned')
  })
})

/** Same shape as batch(), but the first event carries the given title. */
function singleTitleBatch(title: string, base = 10_000): UsageEvent[] {
  return [
    { type: 'app-switch', appName: 'Code', exePath: 'C:\\Apps\\code.exe', pid: 1, windowTitle: title, ts: base },
    { type: 'app-switch', appName: 'Code', exePath: 'C:\\Apps\\code.exe', pid: 1, windowTitle: '', ts: base + 1_000 },
    { type: 'app-switch', appName: 'Chrome', exePath: 'C:\\Apps\\chrome.exe', pid: 1, windowTitle: '', ts: base + 2_000 },
    { type: 'app-switch', appName: 'Chrome', exePath: 'C:\\Apps\\chrome.exe', pid: 1, windowTitle: '', ts: base + 3_000 },
    { type: 'app-switch', appName: 'Code', exePath: 'C:\\Apps\\code.exe', pid: 1, windowTitle: '', ts: base + 4_000 }
  ]
}
