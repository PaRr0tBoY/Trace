import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NoteStore,
  deriveTitle,
  NOTE_STORAGE_VERSION,
  type NoteIndex
} from '../electron/store/NoteStore'

/** In-memory storage harness with a save spy (fake timers control the clock). */
function makeHarness() {
  let saved: NoteIndex | null = null
  const save = vi.fn((index: NoteIndex) => { saved = index })
  const store = new NoteStore({ load: () => saved, save })
  store.load()
  return { store, saved: () => saved, save }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('deriveTitle — NotchNotes-style Markdown title', () => {
  it('strips one markdown line prefix', () => {
    expect(deriveTitle('# Heading')).toBe('Heading')
    expect(deriveTitle('- [ ] todo item')).toBe('todo item')
    expect(deriveTitle('- [x] done item')).toBe('done item')
    expect(deriveTitle('- bullet')).toBe('bullet')
    expect(deriveTitle('* star bullet')).toBe('star bullet')
    expect(deriveTitle('> quote')).toBe('quote')
    expect(deriveTitle('## nested')).toBe('nested')
    expect(deriveTitle('### deeper')).toBe('deeper')
  })

  it('takes the first non-empty line, skipping blank lead-ins', () => {
    expect(deriveTitle('\n\nReal title\nbody')).toBe('Real title')
    expect(deriveTitle('  indented title  ')).toBe('indented title')
  })

  it('returns empty for blank content', () => {
    expect(deriveTitle('')).toBe('')
    expect(deriveTitle('   \n\t ')).toBe('')
  })

  it('truncates at 42 chars with an ellipsis', () => {
    const long = 'x'.repeat(60)
    expect(deriveTitle(long)).toBe('x'.repeat(41) + '…')
    expect(deriveTitle('y'.repeat(42))).toBe('y'.repeat(42))
  })
})

describe('NoteStore — create/update/delete', () => {
  it('creates a note with derived title, newest first, returns its id', () => {
    const { store } = makeHarness()
    const id = store.create('# First')
    vi.advanceTimersByTime(5)
    store.create('Second note')
    const notes = store.toDto()
    expect(notes.map((n) => n.title)).toEqual(['Second note', 'First'])
    expect(store.toDto().find((n) => n.id === id)!.title).toBe('First')
    expect(notes[0].pinned).toBe(false)
    expect(notes[0].folded).toBe(false)
  })

  it('content edits re-derive the title and bump updatedAt', () => {
    const { store } = makeHarness()
    store.create('Old title')
    const id = store.toDto()[0].id
    vi.advanceTimersByTime(1000)
    store.update(id, { content: '# New title\nbody' })
    const note = store.toDto()[0]
    expect(note.title).toBe('New title')
    expect(note.updatedAt).toBeGreaterThan(note.createdAt)
  })

  it('ignores updates and deletes for unknown ids (in-flight race safety)', () => {
    const { store, save } = makeHarness()
    store.create('Solo')
    store.update('missing-id', { content: 'nope' })
    store.delete('missing-id')
    expect(store.toDto()).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('deletes a note', () => {
    const { store } = makeHarness()
    store.create('A')
    store.create('B')
    const id = store.toDto().find((n) => n.title === 'A')!.id
    store.delete(id)
    expect(store.toDto().map((n) => n.title)).toEqual(['B'])
  })
})

describe('NoteStore — ordering', () => {
  it('pinned first, then newest created first', () => {
    const { store } = makeHarness()
    store.create('Earliest')
    vi.advanceTimersByTime(10)
    store.create('Middle')
    vi.advanceTimersByTime(10)
    store.create('Latest')
    const mid = store.toDto().find((n) => n.title === 'Middle')!
    store.update(mid.id, { pinned: true })
    expect(store.toDto().map((n) => n.title)).toEqual(['Middle', 'Latest', 'Earliest'])
  })

  it('content edits never move the note (stable list)', () => {
    const { store } = makeHarness()
    store.create('A')
    vi.advanceTimersByTime(10)
    store.create('B')
    const a = store.toDto().find((n) => n.title === 'A')!
    store.update(a.id, { content: 'A edited' })
    store.update(a.id, { folded: true })
    expect(store.toDto().map((n) => n.title)).toEqual(['B', 'A edited'])
  })

  it('unpinning falls back to creation order', () => {
    const { store } = makeHarness()
    store.create('First')
    vi.advanceTimersByTime(10)
    store.create('Second')
    const second = store.toDto().find((n) => n.title === 'Second')!
    store.update(second.id, { pinned: true })
    store.update(second.id, { pinned: false })
    expect(store.toDto().map((n) => n.title)).toEqual(['Second', 'First'])
  })
})

describe('NoteStore — persistence', () => {
  it('debounces saves for 180 ms; a fresh mutation restarts the window', () => {
    const { store, save } = makeHarness()
    store.create('A') // deadline t+180
    store.create('B')
    store.create('C')
    vi.advanceTimersByTime(100)
    store.update(store.toDto()[0].id, { pinned: true }) // deadline restarts at t+180
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(80)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(save).toHaveBeenCalledTimes(1)
    const index = save.mock.calls[0][0]
    expect(index.version).toBe(NOTE_STORAGE_VERSION)
    expect(index.notes).toHaveLength(3)
  })

  it('flush() writes immediately and cancels pending debounce', () => {
    const { store, save } = makeHarness()
    store.create('A')
    store.flush()
    expect(save).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('round-trips: a fresh store loads what was flushed', () => {
    const { store, saved } = makeHarness()
    store.create('# Hello')
    store.flush()
    const reloaded = new NoteStore({ load: () => saved(), save: () => {} })
    reloaded.load()
    expect(reloaded.toDto()).toEqual(store.toDto())
  })

  it('drops structurally broken notes and re-derives stale titles', () => {
    let saved: NoteIndex = {
      version: 1,
      notes: [
        { id: 'ok', title: 'stale', content: '# Fresh', createdAt: 1, updatedAt: 1, pinned: false, folded: false },
        { id: '', title: 'x', content: 'no id', createdAt: 1, updatedAt: 1, pinned: false, folded: false },
        { id: 'nocontent', title: 'x', content: 42, createdAt: 1, updatedAt: 1, pinned: false, folded: false },
        { id: 'junk', title: 'x', content: 'ok', createdAt: 'nope', updatedAt: 1, pinned: false, folded: false },
        null
      ]
    }
    const store = new NoteStore({ load: () => saved, save: () => {} })
    vi.setSystemTime(5000)
    store.load()
    const notes = store.toDto()
    expect(notes).toHaveLength(2)
    expect(notes.find((n) => n.id === 'ok')!.title).toBe('Fresh')
    expect(notes.find((n) => n.id === 'junk')!.createdAt).toBe(5000)
  })

  it('load() tolerates a null/missing index', () => {
    const store = new NoteStore({ load: () => null, save: () => {} })
    store.load()
    expect(store.toDto()).toEqual([])
  })
})
