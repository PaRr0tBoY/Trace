import { describe, expect, it, vi } from 'vitest'

import { appKeyFromEvent, createAttributor } from '../electron/main/attributor'
import { TaskStore, type TaskIndex } from '../electron/store/TaskStore'
import type { AppRef, AppSwitchEvent, UsageEvent } from '../shared/types'

/** In-memory storage + fake clock harness (same shape as TaskStore.test.ts). */
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

function ev(overrides: Partial<AppSwitchEvent> = {}): AppSwitchEvent {
  return {
    type: 'app-switch',
    appName: 'Code',
    exePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    pid: 1234,
    windowTitle: 'App.tsx — Trace',
    ts: 1_000_000,
    ...overrides
  }
}

/** Fake bus: captures the registered listener so tests can fire events. */
function makeBus() {
  let listener: ((e: UsageEvent) => void) | null = null
  return {
    subscribe: vi.fn((fn: (e: UsageEvent) => void) => {
      listener = fn
      return () => { listener = null }
    }),
    fire: (e: UsageEvent) => listener?.(e)
  }
}

function makeAttributor(store: TaskStore) {
  const bus = makeBus()
  const onAttributed = vi.fn()
  const attributor = createAttributor({ store, subscribe: bus.subscribe, onAttributed })
  return { attributor, bus, onAttributed }
}

describe('appKeyFromEvent', () => {
  it('lowercases and slash-normalizes the exePath', () => {
    expect(appKeyFromEvent(ev())).toBe('c:/program files/microsoft vs code/code.exe')
    expect(appKeyFromEvent(ev({ exePath: 'C:\\Users\\Acid\\AppData\\Local\\Code\\Code.EXE' }))).toBe(
      'c:/users/acid/appdata/local/code/code.exe'
    )
  })

  it('falls back to the process name when no exePath is known', () => {
    expect(appKeyFromEvent(ev({ exePath: '' }))).toBe('code')
    expect(appKeyFromEvent(ev({ exePath: '   ', appName: 'Chrome' }))).toBe('chrome')
  })
})

describe('Attributor', () => {
  it('attributes an app-switch event to the matching task and notifies', () => {
    const { store, tick } = makeHarness()
    const task = store.create('写周报', { apps: [app('c:/program files/microsoft vs code/code.exe')] })!
    tick(60_000)
    const { bus, onAttributed } = makeAttributor(store)

    bus.fire(ev())
    expect(onAttributed).toHaveBeenCalledWith(task.id)
    expect(store.get(task.id)!.status).toBe('active')
    expect(store.get(task.id)!.lastActiveAt).toBe(1_060_000)
  })

const CHROME_KEY = 'c:/program files/google/chrome/application/chrome.exe'

  it('attributes to the most recently active task when three share an app', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(120)
    const older = store.create('旧任务', { apps: [app(CHROME_KEY)] })!
    tick(60_000)
    const middle = store.create('中间任务', { apps: [app(CHROME_KEY)] })!
    tick(60_000)
    const newer = store.create('新任务', { apps: [app(CHROME_KEY)] })!
    const { bus, onAttributed } = makeAttributor(store)

    bus.fire(ev({ appName: 'Chrome', exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }))

    expect(onAttributed).toHaveBeenCalledOnce()
    expect(onAttributed).toHaveBeenCalledWith(newer.id)
    expect(store.get(newer.id)!.lastActiveAt).toBe(1_120_000)
    // Losers are untouched: no bump, no status change, no interruption.
    expect(store.get(older.id)!.lastActiveAt).toBe(1_000_000)
    expect(store.get(middle.id)!.lastActiveAt).toBe(1_060_000)
    expect(store.get(older.id)!.status).toBe('active')
    expect(store.get(middle.id)!.status).toBe('active')
  })

  it('auto-resumes a paused task on an attribution event', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(15)
    const task = store.create('写周报', { apps: [app('code.exe')] })!
    tick(20 * 60_000)
    store.sweep()
    expect(store.get(task.id)!.status).toBe('paused')
    const { bus, onAttributed } = makeAttributor(store)

    bus.fire(ev({ exePath: 'code.exe' }))
    expect(onAttributed).toHaveBeenCalledWith(task.id)
    expect(store.get(task.id)!.status).toBe('active')
  })

  it('does nothing when no task matches the event app', () => {
    const { store, tick } = makeHarness()
    const task = store.create('写周报', { apps: [app('code.exe')] })!
    tick(60_000)
    const { bus, onAttributed } = makeAttributor(store)

    bus.fire(ev({ appName: 'Chrome', exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }))
    expect(onAttributed).not.toHaveBeenCalled()
    expect(store.get(task.id)!.lastActiveAt).toBe(1_000_000)
  })

  it('never attributes to waiting or completed tasks', () => {
    const { store } = makeHarness()
    const waiting = store.create('等待', { apps: [app('code.exe')] })!
    store.update(waiting.id, { status: 'waiting' })
    const done = store.create('完成', { apps: [app('code.exe')] })!
    store.update(done.id, { status: 'completed' })
    const { bus, onAttributed } = makeAttributor(store)

    bus.fire(ev({ exePath: 'code.exe' }))
    expect(onAttributed).not.toHaveBeenCalled()
  })

  it('refreshes the matched AppRef lastContext snapshot with the event title', () => {
    const { store } = makeHarness()
    const task = store.create('写周报', { apps: [app('code.exe', 'Code'), app('chrome.exe', 'Chrome')] })!
    const { bus } = makeAttributor(store)

    bus.fire(ev({ exePath: 'code.exe', windowTitle: 'attributor.ts — Trace' }))
    const apps = store.get(task.id)!.apps
    expect(apps[0].id).toBe('code.exe')
    expect(apps[0].lastContext?.windowTitle).toBe('attributor.ts — Trace')
    expect(apps[1].lastContext).toBeUndefined()
  })

  it('ignores non-app-switch events (clipboard attribution is a later ticket)', () => {
    const { store } = makeHarness()
    const task = store.create('写周报', { apps: [app('code.exe')] })!
    const { bus, onAttributed } = makeAttributor(store)

    bus.fire({ type: 'clipboard', appName: 'Code', exePath: 'code.exe', pid: 1, ts: 1 })
    expect(onAttributed).not.toHaveBeenCalled()
    expect(store.get(task.id)!.lastActiveAt).toBe(1_000_000)
  })

  it('stops reacting after dispose', () => {
    const { store } = makeHarness()
    store.create('写周报', { apps: [app('code.exe')] })
    const { attributor, bus, onAttributed } = makeAttributor(store)

    attributor.dispose()
    bus.fire(ev({ exePath: 'code.exe' }))
    expect(onAttributed).not.toHaveBeenCalled()
  })
})
