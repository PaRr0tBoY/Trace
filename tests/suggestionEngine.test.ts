import { describe, expect, it, vi } from 'vitest'
import { createSuggestionEngine, type SuggestionEngine } from '../electron/main/suggestionEngine'
import { createIgnoredTable, suggestionSignature, type IgnoredTable } from '../electron/main/ignored'
import { TaskStore } from '../electron/store/TaskStore'
import type { AppSwitchEvent, Suggestion, UsageEvent } from '../shared/types'
import type { ChatFn, ChatResult } from '../electron/main/provider'

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

function clipEv(appName: string, ts: number): UsageEvent {
  return { type: 'clipboard', appName, exePath: `C:\\Apps\\${appName.toLowerCase()}.exe`, pid: 1, ts }
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
  now: number
  settings: { suggestionMinEvents: number; suggestionSilenceSeconds: number; confidenceHigh: number; confidenceLow: number }
  ignored: IgnoredTable
  pushed: Suggestion[][]
  chat: ChatFn | undefined
}

function makeHarness(initialEvents: UsageEvent[] = []): Harness {
  const h: Harness = {
    events: [...initialEvents],
    now: 1_000_000,
    settings: { suggestionMinEvents: 5, suggestionSilenceSeconds: 60, confidenceHigh: 0.7, confidenceLow: 0.45 },
    ignored: createIgnoredTable({ load: () => null, save: () => {} }),
    pushed: [],
    chat: undefined,
    store: new TaskStore({ load: () => null, save: () => {} })
  }
  h.engine = createSuggestionEngine({
    now: () => h.now,
    readEvents: () => h.events,
    store: h.store,
    getSettings: () => h.settings,
    ignored: h.ignored,
    onSuggestions: (sugs) => h.pushed.push(sugs)
  })
  return h
}

/** Push events, advance the clock past the silence floor, and await one tick. */
async function trigger(h: Harness, events: UsageEvent[], silenceMs = 60_000): Promise<void> {
  h.events.push(...events)
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
    h.events.push(...batch())
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
    // Suggestion left the pending list.
    expect(h.engine.suggestions()).toHaveLength(0)
    expect(h.pushed[h.pushed.length - 1]).toHaveLength(0)
  })

  it('honours a title override on creation', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id, '  Bug fixing  ')
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
    h.engine.accept(s.id, 'Research + write')
    const tasks = h.store.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('Research + write')
  })

  it('returns null for a stale suggestion id', () => {
    const h = makeHarness()
    h.engine.start()
    expect(h.engine.accept('s_unknown')).toBeNull()
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

    // Same activity in the same hour bucket must not resurface.
    h.events = []
    await trigger(h, batch(10_000))
    expect(h.pushed).toHaveLength(2) // second pass ran but pushed nothing
    expect(h.pushed[1]).toHaveLength(0)
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

  it('does not call the LLM for high-confidence merges', async () => {
    const h = makeHarness()
    h.store.create('Writing report', {
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }, { id: 'c:/apps/chrome.exe', name: 'Chrome' }]
    })
    h.chat = vi.fn(async () => ({ ok: true, content: 'x', parsed: { items: [] } })) as unknown as ChatFn
    h.engine.setChat(h.chat)
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.lowConfidence).toBe(false)
    expect(h.chat).not.toHaveBeenCalled()
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
