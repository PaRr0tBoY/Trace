/**
 * 智能收起 (Smart Collapse Fallbacks) — shared idle guard.
 * Pure-TS unit tests: touch/stop/dispose semantics and the fire-once rule.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createIdleGuard, SMART_COLLAPSE_IDLE_MS } from '../shared/idle'

describe('createIdleGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onIdle after idleMs without activity', () => {
    const onIdle = vi.fn()
    const guard = createIdleGuard({ onIdle })
    guard.touch()
    vi.advanceTimersByTime(SMART_COLLAPSE_IDLE_MS - 1)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('touch restarts the idle window', () => {
    const onIdle = vi.fn()
    const guard = createIdleGuard({ onIdle })
    guard.touch()
    vi.advanceTimersByTime(SMART_COLLAPSE_IDLE_MS - 1)
    guard.touch() // activity right at the edge
    vi.advanceTimersByTime(SMART_COLLAPSE_IDLE_MS - 1)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('stop pauses without firing and touch restarts', () => {
    const onIdle = vi.fn()
    const guard = createIdleGuard({ onIdle })
    guard.touch()
    vi.advanceTimersByTime(1000)
    guard.stop() // cursor re-entered the blade
    vi.advanceTimersByTime(SMART_COLLAPSE_IDLE_MS * 2)
    expect(onIdle).not.toHaveBeenCalled()
    guard.touch() // cursor left again
    vi.advanceTimersByTime(SMART_COLLAPSE_IDLE_MS)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('fires exactly once — touch after firing is a no-op', () => {
    const onIdle = vi.fn()
    const guard = createIdleGuard({ onIdle })
    guard.touch()
    vi.advanceTimersByTime(SMART_COLLAPSE_IDLE_MS + 1000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    guard.touch()
    vi.advanceTimersByTime(SMART_COLLAPSE_IDLE_MS * 2)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('dispose cancels a pending fire', () => {
    const onIdle = vi.fn()
    const guard = createIdleGuard({ onIdle })
    guard.touch()
    guard.dispose()
    vi.advanceTimersByTime(SMART_COLLAPSE_IDLE_MS * 2)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('honours a custom idle window', () => {
    const onIdle = vi.fn()
    const guard = createIdleGuard({ idleMs: 1234, onIdle })
    guard.touch()
    vi.advanceTimersByTime(1233)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })
})
