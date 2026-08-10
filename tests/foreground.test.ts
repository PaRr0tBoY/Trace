import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { decideAppSwitch, ForegroundWatcher, type ForegroundSnapshot } from '../electron/main/foreground'
import type { AppSwitchEvent } from '../shared/types'

function snap(overrides: Partial<ForegroundSnapshot> = {}): ForegroundSnapshot {
  return {
    pid: 1234,
    appName: 'Code',
    exePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    windowTitle: 'index.ts — Trace',
    ...overrides
  }
}

describe('decideAppSwitch', () => {
  it('returns null when there is no next window', () => {
    expect(decideAppSwitch(snap(), null)).toBeNull()
  })

  it('returns null when there is no previous window (first observation is a seed, not a switch)', () => {
    expect(decideAppSwitch(null, snap())).toBeNull()
  })

  it('returns null when the same window is still in front', () => {
    expect(decideAppSwitch(snap(), snap())).toBeNull()
  })

  it('returns an event when the foreground pid changes', () => {
    const next = snap({ pid: 9999, appName: 'chrome', exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', windowTitle: 'docs.google.com' })
    const event = decideAppSwitch(snap(), next)
    expect(event).not.toBeNull()
    expect(event?.type).toBe('app-switch')
    expect(event?.pid).toBe(9999)
    expect(event?.appName).toBe('chrome')
    expect(event?.exePath).toBe(next.exePath)
    expect(event?.windowTitle).toBe('docs.google.com')
    expect(typeof event?.ts).toBe('number')
  })

  it('returns an event when the window title changes within the same app', () => {
    const event = decideAppSwitch(snap(), snap({ windowTitle: 'another-file.ts' }))
    expect(event).not.toBeNull()
    expect(event?.pid).toBe(1234)
    expect(event?.windowTitle).toBe('another-file.ts')
  })
})

describe('ForegroundWatcher', () => {
  let current: ForegroundSnapshot | null
  let poll: ReturnType<typeof vi.fn>
  let events: AppSwitchEvent[]
  let onEvent: (event: AppSwitchEvent) => void

  function makeWatcher(options: { enabled?: () => boolean } = {}) {
    events = []
    onEvent = (e) => events.push(e)
    return new ForegroundWatcher({
      poll,
      intervalMs: 500,
      isEnabled: options.enabled,
      onEvent
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    current = snap()
    poll = vi.fn(() => current)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds the first poll silently, then stays quiet while the window is unchanged', () => {
    const watcher = makeWatcher()
    watcher.start()
    expect(events).toEqual([])
    vi.advanceTimersByTime(2000)
    expect(events).toEqual([])
    expect(poll).toHaveBeenCalledTimes(5) // seed + 4 interval ticks
    expect(watcher.getLatestForeground()).toEqual(snap())
    watcher.stop()
  })

  it('emits one event when the foreground changes', () => {
    const watcher = makeWatcher()
    watcher.start()
    current = snap({ pid: 777, appName: 'explorer', exePath: 'C:\\Windows\\explorer.exe', windowTitle: 'Documents' })
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(1)
    expect(events[0].pid).toBe(777)
    expect(events[0].windowTitle).toBe('Documents')
    watcher.stop()
  })

  it('emits a title-only change and does not repeat while unchanged', () => {
    const watcher = makeWatcher()
    watcher.start()
    current = snap({ windowTitle: 'tab-2' })
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(events).toHaveLength(1)
    watcher.stop()
  })

  it('keeps the last known window when the poll returns null (locked screen)', () => {
    const watcher = makeWatcher()
    watcher.start()
    current = null
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([])
    expect(watcher.getLatestForeground()).toEqual(snap())
    watcher.stop()
  })

  it('does not poll while paused and reseeds silently on resume', () => {
    const watcher = makeWatcher()
    watcher.setPaused(true)
    watcher.start()
    expect(poll).not.toHaveBeenCalled()
    watcher.setPaused(false)
    vi.advanceTimersByTime(500) // seed only
    expect(events).toEqual([])
    current = snap({ pid: 42 })
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(1)
    watcher.stop()
  })

  it('forgets pre-pause context so no retroactive switch is emitted after unpause', () => {
    const watcher = makeWatcher()
    watcher.start()
    vi.advanceTimersByTime(500)
    current = snap({ pid: 42 })
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(1)
    watcher.setPaused(true)
    vi.advanceTimersByTime(1000)
    expect(poll).toHaveBeenCalledTimes(3) // no polling while paused
    watcher.setPaused(false)
    vi.advanceTimersByTime(500) // current differs from pre-pause, but that switch happened while paused
    expect(events).toHaveLength(1)
    watcher.stop()
  })

  it('honours the capture gate and reseeds silently when it turns on', () => {
    let enabled = false
    const watcher = makeWatcher({ enabled: () => enabled })
    watcher.start()
    expect(poll).not.toHaveBeenCalled()
    enabled = true
    vi.advanceTimersByTime(500) // seed only
    expect(events).toEqual([])
    current = snap({ pid: 9 })
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(1)
    watcher.stop()
  })

  it('stops polling after stop()', () => {
    const watcher = makeWatcher()
    watcher.start()
    expect(poll).toHaveBeenCalledTimes(1)
    watcher.stop()
    const calls = poll.mock.calls.length
    vi.advanceTimersByTime(5000)
    expect(poll.mock.calls.length).toBe(calls)
  })

  it('start() is idempotent', () => {
    const watcher = makeWatcher()
    watcher.start()
    watcher.start()
    vi.advanceTimersByTime(500)
    expect(poll).toHaveBeenCalledTimes(2) // one seed + one interval tick, not two
    watcher.stop()
  })
})
