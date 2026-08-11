import { describe, expect, it } from 'vitest'
import { acceptWithResource } from '../electron/main/suggestionDrop'
import { createSuggestionEngine, type SuggestionEngine } from '../electron/main/suggestionEngine'
import { createIgnoredTable } from '../electron/main/ignored'
import { TaskStore } from '../electron/store/TaskStore'
import type { AppSwitchEvent, ResourceRef, UsageEvent } from '../shared/types'

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

interface Harness {
  engine: SuggestionEngine
  store: TaskStore
  events: UsageEvent[]
  now: number
  settings: { suggestionMinEvents: number; suggestionSilenceSeconds: number; confidenceHigh: number; confidenceLow: number }
  pushed: unknown[][]
}

function makeHarness(): Harness {
  const h: Harness = {
    events: [],
    now: 1_000_000,
    settings: { suggestionMinEvents: 5, suggestionSilenceSeconds: 60, confidenceHigh: 0.7, confidenceLow: 0.45 },
    pushed: [],
    store: new TaskStore({ load: () => null, save: () => {} })
  }
  h.engine = createSuggestionEngine({
    now: () => h.now,
    readEvents: () => h.events,
    store: h.store,
    getSettings: () => h.settings,
    ignored: createIgnoredTable({ load: () => null, save: () => {} }),
    onSuggestions: (sugs) => h.pushed.push(sugs)
  })
  return h
}

/** Push events, advance the clock past the silence floor, and await one tick. */
async function trigger(h: Harness, events: UsageEvent[] = batch()): Promise<void> {
  h.events.push(...events)
  h.now = h.events[h.events.length - 1].ts + 60_000
  await h.engine.tick()
}

const clipboardRef = (itemId: string): ResourceRef => ({
  kind: 'clipboard',
  itemId,
  snapshot: { type: 'text', preview: 'p', capturedAt: 1 }
})

describe('acceptWithResource (t25 drop-to-bind composition)', () => {
  it('accepts a suggestion and links the clipboard ref onto the created task', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h)
    const [s] = h.pushed[0] as { id: string }[]

    const acceptedId = acceptWithResource(h.engine, h.store, s.id, undefined, clipboardRef('i1'))
    expect(acceptedId).toBeTruthy()
    const tasks = h.store.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe(acceptedId)
    expect(tasks[0].resources).toEqual([clipboardRef('i1')])
    expect(h.engine.suggestions()).toHaveLength(0)
  })

  it('honours a title override and links into the merged candidate task', async () => {
    const h = makeHarness()
    h.store.create('Writing report', {
      apps: [{ id: 'c:/apps/code.exe', name: 'Code' }]
    })
    h.engine.start()
    await trigger(h, singleTitleBatch('writing report draft'))
    const [s] = h.pushed[0] as { id: string; taskId?: string }[]
    const targetId = s.taskId!

    const acceptedId = acceptWithResource(h.engine, h.store, s.id, 'Doc writing', clipboardRef('i1'))
    expect(acceptedId).toBe(targetId)
    const task = h.store.get(targetId)!
    expect(task.title).toBe('Doc writing')
    expect(task.resources.some((r) => r.kind === 'clipboard' && r.itemId === 'i1')).toBe(true)
  })

  it('links a files ref, sanitizing trims and duplicates', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h)
    const [s] = h.pushed[0] as { id: string }[]

    const acceptedId = acceptWithResource(h.engine, h.store, s.id, undefined, {
      kind: 'files',
      paths: ['  a.txt ', '', 'b.txt', 'a.txt']
    })
    const files = h.store.get(acceptedId!)!.resources.filter((r) => r.kind === 'files')
    expect(files.flatMap((f) => (f.kind === 'files' ? f.paths : []))).toEqual(['a.txt', 'b.txt'])
  })

  it('does not link when the suggestion is stale (accept returned null)', async () => {
    const h = makeHarness()
    h.engine.start()
    const acceptedId = acceptWithResource(h.engine, h.store, 's_unknown', undefined, clipboardRef('i1'))
    expect(acceptedId).toBeNull()
    expect(h.store.list()).toHaveLength(0)
  })

  it('does not create a task when the resource is empty (files all blank)', async () => {
    const h = makeHarness()
    h.engine.start()
    await trigger(h)
    const [s] = h.pushed[0] as { id: string }[]

    // The accept still happens (a task is created); the empty file list is
    // dropped by the store boundary — nothing must throw or double-link.
    const acceptedId = acceptWithResource(h.engine, h.store, s.id, undefined, { kind: 'files', paths: ['  ', ''] })
    expect(acceptedId).toBeTruthy()
    expect(h.store.list()).toHaveLength(1)
    expect(h.store.list()[0].resources).toHaveLength(0)
  })
})
