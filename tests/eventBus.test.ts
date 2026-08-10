import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UsageEvent } from '../shared/types'

/**
 * Event bus tests. The bus keeps module-level listener + ring-buffer state, so
 * each test re-imports a fresh module instance via vi.resetModules().
 */
async function freshBus() {
  vi.resetModules()
  return await import('../electron/main/eventBus')
}

function makeEvent(seed: number): UsageEvent {
  return { type: 'app-switch', appName: `app-${seed}`, exePath: `C:\\app-${seed}.exe`, pid: seed, windowTitle: `win-${seed}`, ts: seed }
}

describe('eventBus', () => {
  beforeEach(() => vi.useRealTimers())

  it('delivers emitted events to subscribers', async () => {
    const { subscribe, emit } = await freshBus()
    const listener = vi.fn()
    subscribe(listener)
    const event = makeEvent(1)
    emit(event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(event)
  })

  it('stops delivering after unsubscribe', async () => {
    const { subscribe, unsubscribe, emit } = await freshBus()
    const listener = vi.fn()
    subscribe(listener)
    unsubscribe(listener)
    emit(makeEvent(1))
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribe handle returned by subscribe works', async () => {
    const { subscribe, emit } = await freshBus()
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    unsubscribe()
    emit(makeEvent(1))
    expect(listener).not.toHaveBeenCalled()
  })

  it('delivers to all subscribers', async () => {
    const { subscribe, emit } = await freshBus()
    const a = vi.fn()
    const b = vi.fn()
    subscribe(a)
    subscribe(b)
    emit(makeEvent(1))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('exposes emitted events via recentEvents in order', async () => {
    const { emit, recentEvents } = await freshBus()
    emit(makeEvent(1))
    emit(makeEvent(2))
    const events = recentEvents()
    expect(events).toHaveLength(2)
    expect(events[0].ts).toBe(1)
    expect(events[1].ts).toBe(2)
  })

  it('recentEvents(limit) returns only the newest events', async () => {
    const { emit, recentEvents } = await freshBus()
    emit(makeEvent(1))
    emit(makeEvent(2))
    emit(makeEvent(3))
    const events = recentEvents(2)
    expect(events).toHaveLength(2)
    expect(events[0].ts).toBe(2)
    expect(events[1].ts).toBe(3)
  })

  it('ring buffer evicts the oldest events past the 1000 cap', async () => {
    const { emit, recentEvents, EVENT_LOG_LIMIT } = await freshBus()
    for (let i = 0; i < EVENT_LOG_LIMIT + 50; i++) emit(makeEvent(i))
    const events = recentEvents()
    expect(events).toHaveLength(EVENT_LOG_LIMIT)
    // Oldest survivor is the (EVENT_LOG_LIMIT+50 - EVENT_LOG_LIMIT)th = 50th emission.
    expect(events[0].ts).toBe(50)
    expect(events[events.length - 1].ts).toBe(EVENT_LOG_LIMIT + 49)
  })

  it('a throwing subscriber does not break delivery to other subscribers', async () => {
    const { subscribe, emit, recentEvents } = await freshBus()
    const good = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribe(() => { throw new Error('boom') })
    subscribe(good)
    emit(makeEvent(1))
    expect(good).toHaveBeenCalledTimes(1)
    expect(recentEvents()).toHaveLength(1)
    expect(errSpy).toHaveBeenCalledOnce()
    errSpy.mockRestore()
  })
})
