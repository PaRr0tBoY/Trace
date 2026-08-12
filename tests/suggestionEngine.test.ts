import { describe, expect, it, vi } from 'vitest'
import { createSuggestionEngine, type SuggestionEngine } from '../electron/main/suggestionEngine'
import { createIgnoredTable, type IgnoredTable } from '../electron/main/ignored'
import { createActivityLedger, DEFAULT_SEGMENT_PARAMS, suggestionSignature } from '../electron/store/activityLedger'
import { createMemoryEvidenceStore, evidenceFromUsageEvent, type EvidenceStore } from '../electron/store/evidenceStore'
import { DEFAULT_POLICY, type PrivacyPolicy } from '../electron/store/privacyGate'
import { TaskStore } from '../electron/store/TaskStore'
import type { AppSwitchEvent, ClipboardItem, Memory, TaskProposal, UsageEvent } from '../shared/types'
import type { ChatFn, ChatResult } from '../electron/main/provider'

/** Privacy interceptions recorded via the engine's recordPrivacy sink (t44). */
interface PrivacyRecord {
  reason: string
  access?: string
  appExePath?: string
}

/** Single-app event batch; gaps are small so the whole batch is one segment. */
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

function clipEv(appName: string, ts: number, itemId?: string): UsageEvent {
  return { type: 'clipboard', appName, exePath: `C:\\Apps\\${appName.toLowerCase()}.exe`, pid: 1, ts, itemId }
}

/** 5 events, one segment (1s gaps < transientMs 2.5s), spread over 4s. */
function batch(base = 10_000): UsageEvent[] {
  return [
    ev('Code', base),
    ev('Code', base + 1_000, 'report.md — Code'),
    ev('Chrome', base + 2_000, 'docs.example.com'),
    ev('Chrome', base + 3_000),
    ev('Code', base + 4_000)
  ]
}

/** Same shape, but only the first event carries a window title (deterministic token set). */
function singleTitleBatch(title: string, base = 10_000): UsageEvent[] {
  return [
    ev('Code', base, title),
    ev('Code', base + 1_000),
    ev('Chrome', base + 2_000),
    ev('Chrome', base + 3_000),
    ev('Code', base + 4_000)
  ]
}

/** App dwell ties 20s/20s, so the alphabetical order wins: Chrome before Code. */
const ALGO_TITLE = 'Chrome + Code task'

interface Harness {
  engine: SuggestionEngine
  store: TaskStore
  events: UsageEvent[]
  evidence: EvidenceStore
  now: number
  settings: { suggestionMinEvents: number; suggestionSilenceSeconds: number; confidenceHigh: number; confidenceLow: number }
  ignored: IgnoredTable
  pushed: TaskProposal[][]
  chat: ChatFn | undefined
  /** Privacy interceptions captured through the engine's sink (t44). */
  privacyRecords: PrivacyRecord[]
}

function makeHarness(
  initialEvents: UsageEvent[] = [],
  items: Map<string, ClipboardItem> = new Map(),
  policy?: PrivacyPolicy
): Harness {
  const h: Harness = {
    events: [...initialEvents],
    now: 1_000_000,
    settings: { suggestionMinEvents: 5, suggestionSilenceSeconds: 60, confidenceHigh: 0.7, confidenceLow: 0.45 },
    ignored: createIgnoredTable({ load: () => null, save: () => {} }),
    pushed: [],
    chat: undefined,
    privacyRecords: [],
    store: new TaskStore({ load: () => null, save: () => {} }),
    evidence: createMemoryEvidenceStore()
  }
  for (const e of initialEvents) h.evidence.record(evidenceFromUsageEvent(e))
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
    onSuggestions: (sugs) => h.pushed.push(sugs),
    readItem: (itemId) => items.get(itemId),
    ...(policy ? { getPolicy: () => policy, recordPrivacy: (r) => h.privacyRecords.push(r) } : {})
  })
  return h
}

/** A minimal text clipboard item (buildClipboardRef only needs id/data/capturedAt). */
function textItem(id: string, text: string, capturedAt: number): ClipboardItem {
  return { id, capturedAt, data: { kind: 'text', text, isUrl: false } } as ClipboardItem
}

/** Push events (ring buffer + evidence timeline), advance the clock, await one tick. */
async function trigger(h: Harness, events: UsageEvent[], silenceMs = 60_000): Promise<void> {
  h.events.push(...events)
  for (const e of events) h.evidence.record(evidenceFromUsageEvent(e))
  h.now = events[events.length - 1].ts + silenceMs
  await h.engine.tick()
}

const SIG_CODE = suggestionSignature(['c:/apps/chrome.exe', 'c:/apps/code.exe'], 10_000)

describe('trigger conditions (injected clock)', () => {
  it('ignores pre-start events (baseline cursor)', async () => {
    const h = makeHarness(batch())
    h.engine.start()
    await h.engine.tick()
    expect(h.pushed).toHaveLength(0)
    expect(h.engine.suggestions()).toHaveLength(0)
  })

  it('does not fire below the min-events threshold', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch().slice(0, 4))
    expect(h.pushed).toHaveLength(0)
  })

  it('does not fire before the silence floor elapses', async () => {
    const h = makeHarness()
    h.engine.start()
    const batchEvents = batch()
    h.events.push(...batchEvents)
    for (const e of batchEvents) h.evidence.record(evidenceFromUsageEvent(e))
    const last = h.events[h.events.length - 1].ts
    h.now = last + 59_999 // silence 59.999s < 60s
    await h.engine.tick()
    expect(h.pushed).toHaveLength(0)

    h.now = last + 60_000 // exactly at the floor
    await h.engine.tick()
    expect(h.pushed).toHaveLength(1)
    expect(h.pushed[0]).toHaveLength(1)
  })

  it('counts only events since the last analysis for the next trigger', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch(10_000))
    expect(h.pushed).toHaveLength(1)

    // Same events again: nothing new since the analysis -> no re-trigger.
    await h.engine.tick()
    expect(h.pushed).toHaveLength(1)

    // New activity re-triggers.
    await trigger(h, batch(20_000))
    expect(h.pushed).toHaveLength(2)
  })

  it('respects a custom min-events threshold from settings', async () => {
    const h = makeHarness()
    h.settings.suggestionMinEvents = 8
    h.engine.start()
    await trigger(h, batch())
    expect(h.pushed).toHaveLength(0)
    h.settings.suggestionMinEvents = 5
    await trigger(h, batch(20_000))
    expect(h.pushed).toHaveLength(1)
  })

  it('advances the cursor on clipboard-only batches without producing suggestions', async () => {
    const h = makeHarness()
    h.engine.start()
    const clips = [clipEv('Code', 10_000), clipEv('Chrome', 20_000), clipEv('Code', 30_000), clipEv('Chrome', 40_000), clipEv('Code', 50_000)]
    await trigger(h, clips)
    expect(h.pushed).toHaveLength(0)
    // Cursor advanced: the same batch must not re-trigger on the next tick.
    await h.engine.tick()
    expect(h.pushed).toHaveLength(0)
  })
})

describe('analysis output', () => {
  it('produces a new-candidate suggestion without a provider (algorithmic title)', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.taskId).toBeUndefined()
    expect(s.title).toBe(ALGO_TITLE)
    expect(s.lowConfidence).toBe(false) // no candidate at all -> 'new' zone, not the low band
    expect(s.appNames).toEqual(['Chrome', 'Code'])
    // appExePaths parallel appNames; original-case paths feed icon
    // extraction (normalized keys are the fallback when no raw path exists).
    expect(s.appExePaths).toEqual(['C:\\Apps\\chrome.exe', 'C:\\Apps\\code.exe'])
    expect(s.algorithmReason).toContain('New activity pattern')
    expect(s.reason).toBeUndefined()
  })

  it('merges into an existing task when the prefilter matches (zone high)', async () => {
    const h = makeHarness()
    h.store.create('Writing report', {
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }, { id: 'c:/apps/chrome.exe', name: 'Chrome' }]
    })
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.taskId).toBeTruthy()
    expect(s.title).toBe('Writing report')
    expect(s.lowConfidence).toBe(false)
  })

  it('flags low-confidence suggestions when the best score sits in the ambiguous band', async () => {
    const h = makeHarness()
    // One app each: best = 0.7·0.5 + 0.3·(2/3) ≈ 0.55, margin 0.2 < θ_high − θ_low = 0.25.
    h.store.create('Coding session', { apps: [{ id: 'c:/apps/code.exe', name: 'Code' }] })
    h.store.create('Research reading', { apps: [{ id: 'c:/apps/chrome.exe', name: 'Chrome' }] })
    h.engine.start()
    await trigger(h, singleTitleBatch('coding session notes'))
    const [s] = h.pushed[0]
    expect(s.taskId).toBeTruthy()
    expect(s.title).toBe('Coding session')
    expect(s.lowConfidence).toBe(true)
  })

  it('skips ignored signatures', async () => {
    const h = makeHarness()
    h.ignored.add(SIG_CODE)
    h.engine.start()
    await trigger(h, batch())
    // The analysis ran but every segment was suppressed -> empty list push.
    expect(h.pushed).toHaveLength(1)
    expect(h.pushed[0]).toHaveLength(0)
  })

  it('replaces the pending list on a new analysis', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch(10_000))
    expect(h.engine.suggestions()).toHaveLength(1)
    const firstId = h.engine.suggestions()[0].id
    await trigger(h, batch(20_000))
    expect(h.engine.suggestions()).toHaveLength(1)
    expect(h.engine.suggestions()[0].id).not.toBe(firstId)
  })
})

describe('accept', () => {
  it('creates a new task from a new-candidate suggestion', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    const created = h.engine.accept(s.id)
    expect(created).toBeTruthy()
    const tasks = h.store.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe(ALGO_TITLE)
    expect(tasks[0].apps.map((a) => a.id)).toEqual(['c:/apps/chrome.exe', 'c:/apps/code.exe'])
    expect(tasks[0].apps.map((a) => a.name)).toEqual(['Chrome', 'Code'])
    // TaskProposal left the pending list.
    expect(h.engine.suggestions()).toHaveLength(0)
    expect(h.pushed[h.pushed.length - 1]).toHaveLength(0)
  })

  it('honours a title override on creation', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id, { title: '  Bug fixing  ' })
    expect(h.store.list()[0].title).toBe('Bug fixing')
  })

  it('merges a candidate suggestion into the existing task (type-safe merge)', async () => {
    const h = makeHarness()
    h.store.create('Writing report', {
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }]
    })
    h.engine.start()
    await trigger(h, singleTitleBatch('writing report draft'))
    const [s] = h.pushed[0]
    const targetId = s.taskId!
    h.engine.accept(s.id)
    const tasks = h.store.list()
    expect(tasks).toHaveLength(1) // merged, not duplicated
    expect(tasks[0].id).toBe(targetId)
    expect(tasks[0].title).toBe('Writing report')
    expect(tasks[0].apps.map((a) => a.id).sort()).toEqual(['c:/apps/chrome.exe', 'c:/apps/code.exe'])
  })

  it('renames the target task on a merged accept with an override', async () => {
    const h = makeHarness()
    h.store.create('Writing report', {
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }, { id: 'c:/apps/chrome.exe', name: 'Chrome' }]
    })
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id, { title: 'Research + write' })
    const tasks = h.store.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('Research + write')
  })

  it('returns null for a stale suggestion id', () => {
    const h = makeHarness()
    h.engine.start()
    expect(h.engine.accept('s_unknown')).toBeNull()
  })

  it('writes the segment window titles, confidence and reason into a created task', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id)
    const task = h.store.list()[0]!
    // Both window titles from the batch survive, trimmed and deduped.
    expect([...task.windowTitles].sort()).toEqual(['docs.example.com', 'report.md — Code'])
    expect(task.confidence).toBe(s.confidence)
    // No provider configured: the stored reason is the algorithm evidence summary.
    expect(task.reason).toBe(s.algorithmReason)
  })

  it('writes window titles, confidence and reason into the merged target', async () => {
    const h = makeHarness()
    h.store.create('Writing report', {
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }]
    })
    h.engine.start()
    await trigger(h, singleTitleBatch('writing report draft'))
    const [s] = h.pushed[0]
    const targetId = s.taskId!
    h.engine.accept(s.id)
    const task = h.store.get(targetId)!
    expect(task.windowTitles).toEqual(['writing report draft'])
    expect(task.confidence).toBe(s.confidence)
    expect(task.reason).toBe(s.algorithmReason)
  })

  it('stores the LLM reason when annotation succeeded', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: '{"items":[{"title":"Doc writing","reason":"You switched between an editor and a browser for research."}]}',
      parsed: { items: [{ title: 'Doc writing', reason: 'You switched between an editor and a browser for research.' }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id)
    const task = h.store.list()[0]!
    expect(task.title).toBe('Doc writing')
    expect(task.reason).toBe('You switched between an editor and a browser for research.')
    expect(task.confidence).toBe(s.confidence)
  })
})

describe('ignore', () => {
  it('drops the card and writes the signature into the table', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(h.engine.ignore(s.id)).toBe(true)
    expect(h.engine.suggestions()).toHaveLength(0)
    expect(h.ignored.has(SIG_CODE)).toBe(true)

    // Same app combination in the same hour bucket (2_000_000 → hour 0, like
    // 10_000) produces the same signature; the ledger's gate drops it — the
    // second pass runs but pushes nothing (push #2 came from ignore() itself).
    h.events = []
    await trigger(h, batch(2_000_000))
    expect(h.pushed).toHaveLength(3) // [suggestions, ignore(), second pass]
    expect(h.pushed[2]).toHaveLength(0)
  })

  it('returns false for an unknown id', () => {
    const h = makeHarness()
    h.engine.start()
    expect(h.engine.ignore('s_unknown')).toBe(false)
  })
})

describe('LLM annotation and degradation', () => {
  it('applies batched LLM titles and reasons to low/new candidates', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: '{"items":[{"title":"Doc writing","reason":"You switched between an editor and a browser for research."}]}',
      parsed: { items: [{ title: 'Doc writing', reason: 'You switched between an editor and a browser for research.' }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.title).toBe('Doc writing')
    expect(s.reason).toBe('You switched between an editor and a browser for research.')
    expect(h.chat).toHaveBeenCalledOnce()
  })

  it('degrades silently when the chain reports failure', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({ ok: false, error: 'all providers failed', attempts: [] })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.title).toBe(ALGO_TITLE)
    expect(s.reason).toBeUndefined()
  })

  it('degrades silently when the chain throws', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.title).toBe(ALGO_TITLE)
    expect(s.reason).toBeUndefined()
  })

  it('degrades silently when no provider is configured at all', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.title).toBe(ALGO_TITLE)
    expect(s.reason).toBeUndefined()
  })

  it('annotates high-confidence merges too (all built candidates go to the LLM)', async () => {
    const h = makeHarness()
    h.store.create('Writing report', {
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }, { id: 'c:/apps/chrome.exe', name: 'Chrome' }]
    })
    h.chat = vi.fn(async () => ({
      ok: true,
      content: '{"items":[{"title":"LLM merge title","reason":"r"}]}',
      parsed: { items: [{ title: 'LLM merge title', reason: 'r' }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.lowConfidence).toBe(false)
    expect(h.chat).toHaveBeenCalledOnce()
    expect(s.title).toBe('LLM merge title')
  })

  it('sanitizes malformed LLM payloads (garbage dropped)', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: '{"items":[{"title":"   ", "reason":123}]}',
      parsed: { items: [{ title: '   ', reason: 123 }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.title).toBe(ALGO_TITLE)
    expect(s.reason).toBeUndefined()
  })
})

describe('suggestTitle (task:suggest-title)', () => {
  const ctx = {
    title: 'draft',
    note: 'polish the CAD drawings',
    appNames: ['Code', 'Chrome'],
    resourcePreviews: ['report.md']
  }

  it('returns 1-3 sanitized candidates when the chain succeeds', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: 'x',
      parsed: { titles: ['Finish CAD drawings', '   ', 'CAD polish', 'CAD polish', 'A very long title that exceeds the sixty character cap for a suggestion title and should be cut', 'Extra'] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    const titles = await h.engine.suggestTitle(ctx)
    expect(titles).toEqual(['Finish CAD drawings', 'CAD polish', 'A very long title that exceeds the sixty character cap for a']) // 去空、去重、截断、上限 3
    const req = (h.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(JSON.parse(req.messages[1].content.slice('Task: '.length))).toEqual({
      title: 'draft',
      note: 'polish the CAD drawings',
      appNames: ['Code', 'Chrome'],
      resourcePreviews: ['report.md']
    })
  })

  it('returns null without a provider', async () => {
    const h = makeHarness()
    expect(await h.engine.suggestTitle(ctx)).toBeNull()
  })

  it('returns null when the chain reports failure', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({ ok: false, error: 'all providers failed', attempts: [] })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    expect(await h.engine.suggestTitle(ctx)).toBeNull()
  })

  it('returns null when the chain throws', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as ChatFn
    h.engine.setChat(h.chat)
    expect(await h.engine.suggestTitle(ctx)).toBeNull()
  })

  it('returns null when the reply fails validation', async () => {
    const h = makeHarness()
    for (const parsed of [null, { nope: [] }, { titles: 'x' }, { titles: [] }, { titles: ['   '] }]) {
      h.chat = vi.fn(async () => ({ ok: true, content: 'x', parsed })) as unknown as ChatFn
      h.engine.setChat(h.chat)
      expect(await h.engine.suggestTitle(ctx)).toBeNull()
    }
  })

  it('omits empty draft fields from the request', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: 'x',
      parsed: { titles: ['Only app names'] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    const titles = await h.engine.suggestTitle({ title: '', note: '  ', appNames: ['Code'], resourcePreviews: [] })
    expect(titles).toEqual(['Only app names'])
    const req = (h.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(JSON.parse(req.messages[1].content.slice('Task: '.length))).toEqual({ appNames: ['Code'] })
  })

  it('injects confirmed project/workflow memories overlapping the draft as memoryContext (ADR-0003)', async () => {
    const memories: Memory[] = [
      { id: 'm1', type: 'project', content: 'CAD drawings', userState: 'confirmed', confidence: 1, hitCount: 2, lastSeenAt: 1, createdAt: 1, source: 'user' },
      { id: 'm2', type: 'tool', content: 'Chrome', userState: 'confirmed', confidence: 1, hitCount: 1, lastSeenAt: 1, createdAt: 1, source: 'user' },
      { id: 'm3', type: 'project', content: 'polish the CAD drawings', userState: 'suggested', confidence: 1, hitCount: 1, lastSeenAt: 1, createdAt: 1, source: 'ai-suggest' }
    ]
    const store = new TaskStore({ load: () => null, save: () => {} })
    const engine = createSuggestionEngine({
      now: () => 1_000_000,
      readEvents: () => [],
      store,
      getSettings: () => ({ suggestionMinEvents: 5, suggestionSilenceSeconds: 60 }),
      ledger: createActivityLedger({
        evidence: createMemoryEvidenceStore(),
        getTasks: () => store.list(),
        getParams: () => ({ ...DEFAULT_SEGMENT_PARAMS, confidenceHigh: 0.7, confidenceLow: 0.45 }),
        ignored: createIgnoredTable({ load: () => null, save: () => {} })
      }),
      onSuggestions: () => {},
      readMemories: () => memories
    })
    const chat = vi.fn(async () => ({
      ok: true,
      content: 'x',
      parsed: { titles: ['Finish CAD work'] }
    })) as unknown as ChatFn
    engine.setChat(chat)
    await engine.suggestTitle({ title: '', note: 'polish the CAD drawings', appNames: ['Code'], resourcePreviews: [] })
    const payload = JSON.parse(chat.mock.calls[0][0].messages[1].content.slice('Task: '.length))
    // 'CAD drawings' sits inside the draft note (memory → text direction); m2
    // is a tool (never injected), m3 is not user-confirmed (never injected).
    expect(payload.memoryContext).toEqual(['CAD drawings'])
  })

  it('omits memoryContext when no memory overlaps the draft', async () => {
    const memories: Memory[] = [
      { id: 'm1', type: 'project', content: 'CAD Agent', userState: 'confirmed', confidence: 1, hitCount: 1, lastSeenAt: 1, createdAt: 1, source: 'user' }
    ]
    const store = new TaskStore({ load: () => null, save: () => {} })
    const engine = createSuggestionEngine({
      now: () => 1_000_000,
      readEvents: () => [],
      store,
      getSettings: () => ({ suggestionMinEvents: 5, suggestionSilenceSeconds: 60 }),
      ledger: createActivityLedger({
        evidence: createMemoryEvidenceStore(),
        getTasks: () => store.list(),
        getParams: () => ({ ...DEFAULT_SEGMENT_PARAMS, confidenceHigh: 0.7, confidenceLow: 0.45 }),
        ignored: createIgnoredTable({ load: () => null, save: () => {} })
      }),
      onSuggestions: () => {},
      readMemories: () => memories
    })
    const chat = vi.fn(async () => ({
      ok: true,
      content: 'x',
      parsed: { titles: ['Unrelated title'] }
    })) as unknown as ChatFn
    engine.setChat(chat)
    await engine.suggestTitle({ title: 'Tax filing', note: '', appNames: ['Excel'], resourcePreviews: [] })
    const payload = JSON.parse(chat.mock.calls[0][0].messages[1].content.slice('Task: '.length))
    expect(payload.memoryContext).toBeUndefined()
  })
})

describe('OCR context in LLM annotation (t30)', () => {
  it('includes foreground OCR text in the LLM request when available', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: 'x',
      parsed: { items: [{ title: 'OCR-aware', reason: 'r' }] }
    })) as unknown as ChatFn
    const ocr = vi.fn(async () => '装配图纸 检查清单 final-v3')
    h.engine.setChat(h.chat)
    h.engine.setOcr(ocr as unknown as OcrFn)
    h.engine.start()
    await trigger(h, batch())
    expect(ocr).toHaveBeenCalledOnce()
    const req = (h.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const payload = JSON.parse(req.messages[1].content.slice('Segments: '.length))
    expect(payload.ocrContext).toBe('装配图纸 检查清单 final-v3')
    expect(Array.isArray(payload.segments)).toBe(true)
  })

  it('omits ocrContext when OCR returns null', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: 'x',
      parsed: { items: [{ title: 'No OCR', reason: 'r' }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.setOcr((async () => null) as unknown as OcrFn)
    h.engine.start()
    await trigger(h, batch())
    const req = (h.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const payload = JSON.parse(req.messages[1].content.slice('Segments: '.length))
    expect(payload.ocrContext).toBeUndefined()
    expect(Array.isArray(payload.segments)).toBe(true)
  })

  it('degrades silently when OCR throws', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: 'x',
      parsed: { items: [{ title: 'Still works', reason: 'r' }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.setOcr((async () => {
      throw new Error('ocr engine unavailable')
    }) as unknown as OcrFn)
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.title).toBe('Still works')
    const req = (h.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const payload = JSON.parse(req.messages[1].content.slice('Segments: '.length))
    expect(payload.ocrContext).toBeUndefined()
  })

  it('does not run OCR without a provider (no consumer, no capture)', async () => {
    const h = makeHarness()
    const ocr = vi.fn(async () => 'should not run')
    h.engine.setOcr(ocr as unknown as OcrFn)
    h.engine.start()
    await trigger(h, batch())
    expect(ocr).not.toHaveBeenCalled()
  })

  it('runs without OCR wired (no ocrContext, no errors)', async () => {
    const h = makeHarness()
    h.chat = vi.fn(async () => ({
      ok: true,
      content: 'x',
      parsed: { items: [{ title: 'Plain', reason: 'r' }] }
    })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())
    const req = (h.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const payload = JSON.parse(req.messages[1].content.slice('Segments: '.length))
    expect(payload.ocrContext).toBeUndefined()
  })
})

describe('clipboard material on suggestions (segment window)', () => {
  it('attaches items copied during the segment window as refs', async () => {
    const items = new Map<string, ClipboardItem>()
    items.set('i1', textItem('i1', 'hello world', 12_000))
    const h = makeHarness([], items)
    h.engine.start()
    // The copy (ts 12_000) must arrive before the later switches: the ledger
    // anchors the silence floor at the newest event, so append in ts order.
    const midClip = [...batch(), clipEv('Code', 12_000, 'i1')]
    midClip.sort((a, b) => a.ts - b.ts)
    await trigger(h, midClip)
    expect(h.pushed[0]).toHaveLength(1)
    const [s] = h.pushed[0]
    expect(s.clipboardRefs).toEqual([
      { kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'hello world', capturedAt: 12_000 } }
    ])
  })

  it('keeps copies made after the final app switch with the last segment', async () => {
    const items = new Map<string, ClipboardItem>()
    items.set('i2', textItem('i2', 'late copy', 15_000))
    const h = makeHarness([], items)
    h.engine.start()
    await trigger(h, [...batch(), clipEv('Code', 15_000, 'i2')])
    expect(h.pushed[0]).toHaveLength(1)
    expect(h.pushed[0][0].clipboardRefs).toHaveLength(1)
  })

  it('attributes between-segment copies to the preceding segment', async () => {
    const items = new Map<string, ClipboardItem>()
    items.set('a', textItem('a', 'mid', 20_000))
    items.set('b', textItem('b', 'in word', 30_500))
    const h = makeHarness([], items)
    h.engine.start()
    await trigger(h, [
      ...batch(),
      clipEv('Code', 20_000, 'a'),
      ev('Word', 30_000, 'word doc'),
      clipEv('Word', 30_500, 'b'),
      ev('Word', 31_000)
    ])
    const sugs = h.pushed[0]
    expect(sugs).toHaveLength(2)
    const first = sugs.find((s) => s.appNames.includes('Code'))!
    const second = sugs.find((s) => s.appNames.includes('Word'))!
    expect(first.clipboardRefs!.map((r) => (r.kind === 'clipboard' ? r.itemId : ''))).toContain('a')
    expect(first.clipboardRefs!.some((r) => r.kind === 'clipboard' && r.itemId === 'b')).toBe(false)
    expect(second.clipboardRefs!.some((r) => r.kind === 'clipboard' && r.itemId === 'b')).toBe(true)
  })

  it('skips clipboard events whose item is already evicted', async () => {
    const h = makeHarness() // no items registered
    h.engine.start()
    const midClip = [...batch(), clipEv('Code', 12_000, 'gone')]
    midClip.sort((a, b) => a.ts - b.ts)
    await trigger(h, midClip)
    expect(h.pushed[0]).toHaveLength(1)
    expect(h.pushed[0][0].clipboardRefs).toEqual([])
  })
})

describe('accept with convert-panel payload', () => {
  it('creates the task from the edited title/note/apps/clipboard refs', async () => {
    const items = new Map<string, ClipboardItem>()
    items.set('i1', textItem('i1', 'note body', 12_000))
    const h = makeHarness([], items)
    h.engine.start()
    const midClip = [...batch(), clipEv('Code', 12_000, 'i1')]
    midClip.sort((a, b) => a.ts - b.ts)
    await trigger(h, midClip)
    const [s] = h.pushed[0]
    const taskId = h.engine.accept(s.id, {
      title: 'My title',
      note: 'My note',
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }],
      clipboardRefs: [{ kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'note body', capturedAt: 12_000 } }]
    })
    expect(taskId).toBeTruthy()
    const task = h.store.get(taskId!)!
    expect(task.title).toBe('My title')
    expect(task.note).toBe('My note')
    expect(task.apps.map((a) => a.id)).toEqual(['c:/apps/code.exe'])
    expect(task.resources).toHaveLength(1)
    expect(task.resources[0]).toMatchObject({ kind: 'clipboard', itemId: 'i1' })
  })

  it('merges the payload into the candidate task, keeping its evidence', async () => {
    const items = new Map<string, ClipboardItem>()
    items.set('i1', textItem('i1', 'note body', 12_000))
    const h = makeHarness([], items)
    h.store.create('Writing report', {
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }, { id: 'c:/apps/chrome.exe', name: 'Chrome' }]
    })
    h.engine.start()
    const midClip = [...batch(), clipEv('Code', 12_000, 'i1')]
    midClip.sort((a, b) => a.ts - b.ts)
    await trigger(h, midClip)
    const [s] = h.pushed[0]
    const targetId = s.taskId!
    h.engine.accept(s.id, { note: 'edited note' })
    const task = h.store.get(targetId)!
    expect(task.title).toBe('Writing report') // unchanged without a title override
    expect(task.note).toBe('edited note')
    expect(task.confidence).toBe(s.confidence)
  })
})

describe('privacy: denied-app candidacy filter (t44)', () => {
  it('blocks an activity containing a denied app and records the interception', async () => {
    // batch() is Code+Chrome in one segment → Chrome on the denied list
    // blocks the whole activity (its data would leak via the suggestion).
    const h = makeHarness([], new Map(), { ...DEFAULT_POLICY, deniedApps: ['c:/apps/chrome.exe'] })
    h.engine.start()
    await trigger(h, batch())
    expect(h.pushed[0]).toHaveLength(0)
    expect(h.privacyRecords).toHaveLength(1)
    expect(h.privacyRecords[0].reason).toContain('app on denied list')
    expect(h.privacyRecords[0].appExePath).toBe('c:/apps/chrome.exe')
    expect(h.privacyRecords[0].access).toBe('activities')
  })

  it('keeps allowed activities when another activity is blocked', async () => {
    const h = makeHarness([], new Map(), { ...DEFAULT_POLICY, deniedApps: ['c:/apps/chrome.exe'] })
    h.engine.start()
    // First batch: Code only → one allowed suggestion.
    await trigger(h, [ev('Code', 10_000), ev('Code', 11_000), ev('Code', 12_000), ev('Code', 13_000), ev('Code', 14_000)])
    expect(h.pushed[0]).toHaveLength(1)
    expect(h.pushed[0][0].appNames).toEqual(['Code'])
    // Second batch: Chrome only → filtered, recorded, no card.
    await trigger(h, [ev('Chrome', 20_000), ev('Chrome', 21_000), ev('Chrome', 22_000), ev('Chrome', 23_000), ev('Chrome', 24_000)])
    expect(h.pushed[1]).toHaveLength(0)
    expect(h.privacyRecords).toHaveLength(1)
  })

  it('matches the denied list with normalized exePath keys', async () => {
    // Settings stores normalized keys; the activity's app id is normalized
    // too, so original-case raw paths never appear here — but mixed case
    // must still match (same normalizeExePath rule as the gate).
    const h = makeHarness([], new Map(), { ...DEFAULT_POLICY, deniedApps: ['C:/Apps/CODE.EXE'] })
    h.engine.start()
    await trigger(h, batch())
    expect(h.pushed[0]).toHaveLength(0)
    expect(h.privacyRecords[0].appExePath).toBe('c:/apps/code.exe')
  })

  it('keeps the algorithmic pipeline when the AI master switch is off', async () => {
    // aiEnabled gates AI services (OCR / prefill / tools), NOT the local
    // candidacy — the no-AI fallback must keep producing suggestions.
    const h = makeHarness([], new Map(), { ...DEFAULT_POLICY, aiEnabled: false })
    h.engine.start()
    await trigger(h, batch())
    expect(h.pushed[0]).toHaveLength(1)
    expect(h.privacyRecords).toHaveLength(0)
  })

  it('does not filter and records nothing when no policy is injected', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch())
    expect(h.pushed[0]).toHaveLength(1)
    expect(h.privacyRecords).toHaveLength(0)
  })
})
