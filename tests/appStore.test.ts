/**
 * Renderer store regression: hideSwitcher's 150ms collapse-finish timer must
 * not wipe a switcher session that was re-armed inside the animation window
 * (Alt released, then Alt+Tab pressed again within 150ms).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { useStore } from '../src/store/appStore'
import type { SwitcherEntryDto } from '../shared/types'

const entry = (id: string): SwitcherEntryDto => ({ title: id, exePath: `${id}.exe`, isCurrent: false, index: 0 })

function reset(): void {
  useStore.setState({
    switcherActive: false,
    switcherEntries: [],
    switcherSelected: 0,
    switcherPinned: false,
    switcherSeedQuery: '',
    switcherControlKey: null,
    switcherPrevOpen: false,
    open: false
  })
}

describe('switcher session race (hideSwitcher collapse timer)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a stale collapse timer does not wipe a re-armed session', () => {
    const store = useStore.getState()
    store.showSwitcher({ entries: [entry('a')], selectedIndex: 0 })
    store.hideSwitcher() // schedules the finish cleanup at +150ms
    useStore.getState().showSwitcher({ entries: [entry('b')], selectedIndex: 0 }) // re-armed inside the window

    vi.advanceTimersByTime(160)

    const now = useStore.getState()
    expect(now.switcherActive).toBe(true)
    expect(now.switcherEntries).toHaveLength(1)
    expect(now.switcherEntries[0].title).toBe('b')
  })

  it('a lone hide still cleans up after the animation window', () => {
    const store = useStore.getState()
    store.showSwitcher({ entries: [entry('a')], selectedIndex: 0 })
    store.hideSwitcher()

    vi.advanceTimersByTime(160)

    const now = useStore.getState()
    expect(now.switcherActive).toBe(false)
    expect(now.switcherEntries).toHaveLength(0)
  })
})

describe('智能收起 — notesCurrentId restore semantics', () => {
  beforeEach(() => {
    useStore.setState({
      open: false,
      lastClosedAt: 0,
      notesCurrentId: 'n1',
      settings: {
        ...useStore.getState().settings,
        tutorialCompleted: true,
        landing: { view: 'notes' },
        restoreTime: 'relaxed'
      }
    })
  })

  it('applying the landing page (first launch) forgets the remembered note', () => {
    useStore.getState().setOpen(true)
    expect(useStore.getState().notesCurrentId).toBeNull()
  })

  it('a re-open within the restore TTL keeps the remembered note', () => {
    useStore.setState({ lastClosedAt: Date.now() })
    useStore.getState().setOpen(true)
    expect(useStore.getState().notesCurrentId).toBe('n1')
  })

  it('a landing page on another view does not touch the remembered note', () => {
    useStore.setState({ settings: { ...useStore.getState().settings, landing: { view: 'tasks', filter: 'existing' } } })
    useStore.getState().setOpen(true)
    expect(useStore.getState().notesCurrentId).toBe('n1')
  })
})
