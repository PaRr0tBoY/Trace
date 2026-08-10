import { describe, expect, it } from 'vitest'

import { appKeyFromEvent, buildClipboardEvent, decideClipboardAttribution } from '../electron/main/attributor'
import { TaskStore, type TaskIndex } from '../electron/store/TaskStore'
import type { AppRef, ClipboardEvent } from '../shared/types'

/** In-memory storage + fake clock harness (same shape as attributor.test.ts). */
function makeHarness() {
  let saved: TaskIndex | null = null
  let now = 1_000_000
  const store = new TaskStore({
    load: () => saved,
    save: (index) => { saved = index },
    now: () => now
  })
  store.load()
  return {
    store,
    tick: (ms: number) => { now += ms }
  }
}

const app = (id: string, name = id): AppRef => ({ id, name })

const CODE_EXE = 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

function clipEvent(overrides: Partial<ClipboardEvent> = {}): ClipboardEvent {
  return {
    type: 'clipboard',
    appName: 'Code',
    exePath: CODE_EXE,
    pid: 1234,
    ts: 1_000_000,
    ...overrides
  }
}

describe('buildClipboardEvent', () => {
  it('constructs a clipboard event from a foreground snapshot', () => {
    const e = buildClipboardEvent({ appName: 'Code', exePath: CODE_EXE, pid: 4242 }, 1_234_567)
    expect(e).toEqual({
      type: 'clipboard',
      appName: 'Code',
      exePath: CODE_EXE,
      pid: 4242,
      ts: 1_234_567
    })
  })
})

describe('decideClipboardAttribution', () => {
  it('links to the task whose AppRef matches the source process', () => {
    const { store } = makeHarness()
    const task = store.create('修 bug', { apps: [app('c:/program files/microsoft vs code/code.exe')] })!

    expect(decideClipboardAttribution(clipEvent(), store.list(), true)).toBe(task.id)
  })

  it('links via the process-name fallback when no exePath is known', () => {
    const { store } = makeHarness()
    const task = store.create('修 bug', { apps: [app('code')] })!

    expect(decideClipboardAttribution(clipEvent({ exePath: '' }), store.list(), true)).toBe(task.id)
  })

  it('picks the most recently active task when several share the app', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(120)
    const older = store.create('旧任务', { apps: [app('c:/program files/google/chrome/application/chrome.exe')] })!
    tick(60_000)
    const newer = store.create('新任务', { apps: [app('c:/program files/google/chrome/application/chrome.exe')] })!

    expect(decideClipboardAttribution(
      clipEvent({ appName: 'Chrome', exePath: CHROME_EXE }),
      store.list(),
      true
    )).toBe(newer.id)
  })

  it('never links to waiting or completed tasks', () => {
    const { store } = makeHarness()
    const waiting = store.create('等待', { apps: [app('code.exe')] })!
    store.update(waiting.id, { status: 'waiting' })
    const done = store.create('完成', { apps: [app('code.exe')] })!
    store.update(done.id, { status: 'completed' })

    expect(decideClipboardAttribution(clipEvent(), store.list(), true)).toBeNull()
  })

  it('returns null when no task matches the source app', () => {
    const { store } = makeHarness()
    store.create('修 bug', { apps: [app('code.exe')] })

    expect(decideClipboardAttribution(
      clipEvent({ appName: 'Chrome', exePath: CHROME_EXE }),
      store.list(),
      true
    )).toBeNull()
  })

  it('returns null when auto-attribution is disabled (pure manual linking)', () => {
    const { store } = makeHarness()
    const task = store.create('修 bug', { apps: [app('c:/program files/microsoft vs code/code.exe')] })!

    expect(decideClipboardAttribution(clipEvent(), store.list(), false)).toBeNull()
  })

  it('is a pure decision: matching never mutates task state', () => {
    const { store, tick } = makeHarness()
    const task = store.create('修 bug', { apps: [app('c:/program files/microsoft vs code/code.exe')] })!
    tick(60_000)

    decideClipboardAttribution(clipEvent({ ts: 1_060_000 }), store.list(), true)

    expect(store.get(task.id)!.lastActiveAt).toBe(1_000_000)
    expect(store.get(task.id)!.status).toBe('active')
    expect(store.get(task.id)!.resources).toHaveLength(0)
  })
})
