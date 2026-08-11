import { describe, expect, it } from 'vitest'

import {
  TaskStore,
  buildClipboardRef,
  STORAGE_VERSION,
  type TaskIndex,
  type TaskStoreDeps
} from '../electron/store/TaskStore'
import type { AppRef, ResourceRef, Task } from '../shared/types'

/** In-memory storage + fake clock harness. */
function makeHarness(deps?: Partial<Pick<TaskStoreDeps, 'isItemAlive'>>) {
  let saved: TaskIndex | null = null
  let now = 1_000_000
  const store = new TaskStore({
    load: () => saved,
    save: (index) => { saved = index },
    now: () => now,
    ...deps
  })
  store.load()
  return {
    store,
    storage: { load: () => saved, save: (index: TaskIndex) => { saved = index } },
    tick: (ms: number) => { now += ms },
    now: () => now
  }
}

const app = (id: string, name = id): AppRef => ({ id, name })

describe('TaskStore — create/update/delete', () => {
  it('creates a task with t_ prefix, active status and injected clock timestamps', () => {
    const { store, now } = makeHarness()
    const task = store.create('写周报')
    expect(task).not.toBeNull()
    expect(task!.id).toMatch(/^t_/)
    expect(task!.status).toBe('active')
    expect(task!.createdAt).toBe(now())
    expect(task!.updatedAt).toBe(now())
    expect(task!.lastActiveAt).toBe(now())
    expect(task!.apps).toEqual([])
    expect(task!.resources).toEqual([])
  })

  it('rejects a blank title', () => {
    const { store } = makeHarness()
    expect(store.create('   ')).toBeNull()
    expect(store.create('')).toBeNull()
  })

  it('accepts note, apps and resources at creation', () => {
    const { store } = makeHarness()
    const task = store.create('任务', {
      note: '备注',
      apps: [app('code.exe'), app('code.exe')], // duplicate id collapsed
      resources: [
        { kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'x', capturedAt: 1 } },
        { kind: 'files', paths: ['a.txt', 'a.txt'] }
      ]
    })
    expect(task!.apps).toHaveLength(1)
    expect(task!.resources).toHaveLength(2)
  })

  it('updates title/note and trims them', () => {
    const { store } = makeHarness()
    const task = store.create('标题')!
    expect(store.update(task.id, { title: '  新标题  ', note: '  n  ' })).toBe(true)
    expect(store.get(task.id)!.title).toBe('新标题')
    expect(store.get(task.id)!.note).toBe('n')
  })

  it('clears the note with an empty string', () => {
    const { store } = makeHarness()
    const task = store.create('标题', { note: 'n' })!
    expect(store.update(task.id, { note: '' })).toBe(true)
    expect(store.get(task.id)!.note).toBeUndefined()
  })

  it('rejects a blank title patch without touching the task', () => {
    const { store } = makeHarness()
    const task = store.create('标题')!
    expect(store.update(task.id, { title: ' ' })).toBe(false)
    expect(store.get(task.id)!.title).toBe('标题')
  })

  it('returns false for unknown tasks', () => {
    const { store } = makeHarness()
    expect(store.update('t_nope', { title: 'x' })).toBe(false)
    expect(store.delete('t_nope')).toBe(false)
  })

  it('hard-deletes a task', () => {
    const { store } = makeHarness()
    const task = store.create('标题')!
    expect(store.delete(task.id)).toBe(true)
    expect(store.get(task.id)).toBeUndefined()
    expect(store.list()).toHaveLength(0)
  })
})

describe('TaskStore — manual status transitions (full transition table)', () => {
  it('allows every manual transition and records resume as fresh activity', () => {
    const { store, tick } = makeHarness()
    const task = store.create('任务')!
    tick(60_000)

    expect(store.update(task.id, { status: 'paused' })).toBe(true)
    expect(store.get(task.id)!.status).toBe('paused')

    tick(60_000)
    expect(store.update(task.id, { status: 'waiting' })).toBe(true)
    expect(store.get(task.id)!.status).toBe('waiting')

    expect(store.update(task.id, { status: 'completed' })).toBe(true)
    expect(store.get(task.id)!.status).toBe('completed')

    tick(60_000)
    expect(store.update(task.id, { status: 'active' })).toBe(true)
    expect(store.get(task.id)!.status).toBe('active')
    expect(store.get(task.id)!.lastActiveAt).toBe(store.get(task.id)!.updatedAt)
  })

  it('rejects an invalid status value', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    expect(store.update(task.id, { status: 'zombie' as never })).toBe(false)
    expect(store.get(task.id)!.status).toBe('active')
  })
})

describe('TaskStore — idle timeout state machine', () => {
  it('keeps an active task active below the threshold', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(15)
    const task = store.create('任务')!
    tick(14 * 60_000)
    expect(store.sweep()).toBe(0)
    expect(store.get(task.id)!.status).toBe('active')
  })

  it('auto-pauses at the threshold boundary (>= threshold)', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(15)
    const task = store.create('任务')!
    tick(15 * 60_000)
    expect(store.sweep()).toBe(1)
    expect(store.get(task.id)!.status).toBe('paused')
  })

  it('persists the paused state when swept', () => {
    const { store, tick, storage } = makeHarness()
    store.setPauseThreshold(15)
    const task = store.create('任务')!
    tick(20 * 60_000)
    store.sweep()
    expect(storage.load()!.tasks.find((t) => t.id === task.id)!.status).toBe('paused')
  })

  it('re-evaluates the state machine at the end of every mutation', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(15)
    const idle = store.create('闲置')!
    tick(16 * 60_000)
    const other = store.create('新任务')!
    expect(store.get(idle.id)!.status).toBe('paused')
    expect(store.get(other.id)!.status).toBe('active')
  })

  it('clamps the threshold into 1-120 minutes', () => {
    const { store } = makeHarness()
    store.setPauseThreshold(0)
    expect(store.sweep()).toBe(0) // threshold floor: 1 minute, nothing idle yet
    store.setPauseThreshold(999)
    expect(store.sweep()).toBe(0)
  })

  it('paused tasks are not re-paused by the sweep', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(15)
    const task = store.create('任务')!
    tick(20 * 60_000)
    store.sweep()
    expect(store.sweep()).toBe(0)
    expect(store.get(task.id)!.status).toBe('paused')
  })
})

describe('TaskStore — attribution', () => {
  it('attribution keeps an active task active and refreshes lastActiveAt', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(15)
    const task = store.create('任务', { apps: [app('code.exe', 'Code')] })!
    tick(10 * 60_000)
    expect(store.applyAttribution('code.exe')).toBe(task.id)
    expect(store.get(task.id)!.status).toBe('active')
    expect(store.get(task.id)!.lastActiveAt).toBeGreaterThan(1_000_000)
  })

  it('auto-resumes a paused task on attribution', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(15)
    const task = store.create('任务', { apps: [app('code.exe')] })!
    tick(20 * 60_000)
    store.sweep()
    expect(store.get(task.id)!.status).toBe('paused')
    expect(store.applyAttribution('code.exe')).toBe(task.id)
    expect(store.get(task.id)!.status).toBe('active')
  })

  it('attributes to the most recently active task when several share an app', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(120)
    const older = store.create('旧任务', { apps: [app('chrome.exe')] })!
    tick(60_000)
    const newer = store.create('新任务', { apps: [app('chrome.exe')] })!
    expect(store.applyAttribution('chrome.exe')).toBe(newer.id)
    expect(store.get(older.id)!.lastActiveAt).toBe(1_000_000)
    expect(store.get(newer.id)!.lastActiveAt).toBeGreaterThan(1_000_000)
  })

  it('never attributes to waiting or completed tasks', () => {
    const { store } = makeHarness()
    const waiting = store.create('等待', { apps: [app('code.exe')] })!
    store.update(waiting.id, { status: 'waiting' })
    const done = store.create('完成', { apps: [app('code.exe')] })!
    store.update(done.id, { status: 'completed' })
    expect(store.applyAttribution('code.exe')).toBeNull()
  })

  it('returns null when no task matches the app key', () => {
    const { store } = makeHarness()
    store.create('任务', { apps: [app('code.exe')] })
    expect(store.applyAttribution('chrome.exe')).toBeNull()
  })

  it('updates the matched AppRef context and moves it to the front', () => {
    const { store } = makeHarness()
    const task = store.create('任务', { apps: [app('code.exe', 'Code'), app('chrome.exe', 'Chrome')] })!
    store.applyAttribution('code.exe', { windowTitle: 'App.tsx — Trace' })
    const apps = store.get(task.id)!.apps
    expect(apps[0].id).toBe('code.exe')
    expect(apps[0].lastContext?.windowTitle).toBe('App.tsx — Trace')
    expect(apps[1].lastContext).toBeUndefined()
  })
})

describe('TaskStore — sorting', () => {
  it('groups Active > Waiting > Paused > Completed, lastActiveAt desc within a group', () => {
    const { store, tick } = makeHarness()
    store.setPauseThreshold(120)
    store.create('A旧') // lastActiveAt = 1_000_000
    tick(10_000)
    store.create('A新')
    const waiting = store.create('W')!
    store.update(waiting.id, { status: 'waiting' })
    const paused = store.create('P')!
    store.update(paused.id, { status: 'paused' })
    const done = store.create('C')!
    store.update(done.id, { status: 'completed' })

    const order = store.toDto().map((t) => t.title)
    expect(order).toEqual(['A新', 'A旧', 'W', 'P', 'C'])
  })

  it('list() returns an array detached from the store', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    const list = store.list()
    ;(list as Task[]).push(task) // mutating the returned array must not affect the store
    expect(store.list()).toHaveLength(1)
    expect(store.get(task.id)!.title).toBe('任务')
  })
})

describe('TaskStore — merge (type-safe, same-kind only)', () => {
  function tasksWithResources() {
    const { store } = makeHarness()
    const target = store.create('目标', {
      apps: [app('code.exe', 'Code')],
      resources: [
        { kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'a', capturedAt: 1 } },
        { kind: 'files', paths: ['x.txt'] }
      ]
    })!
    const source = store.create('来源', {
      apps: [app('code.exe', 'Code'), app('chrome.exe', 'Chrome')],
      resources: [
        { kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'dup', capturedAt: 2 } },
        { kind: 'clipboard', itemId: 'i2', snapshot: { type: 'text', preview: 'b', capturedAt: 3 } },
        { kind: 'files', paths: ['x.txt', 'y.txt'] }
      ]
    })!
    return { store, target, source }
  }

  it('unions apps (target wins on shared id), merges resources kind-wise, deletes source', () => {
    const { store, target, source } = tasksWithResources()
    expect(store.merge(target.id, source.id)).toBe(true)

    const merged = store.get(target.id)!
    expect(merged.apps.map((a) => a.id)).toEqual(['code.exe', 'chrome.exe'])
    expect(merged.apps[0]!.name).toBe('Code') // target's entry kept

    const clip = merged.resources.filter((r) => r.kind === 'clipboard')
    expect(clip).toHaveLength(2) // i1 deduped
    const files = merged.resources.filter((r) => r.kind === 'files')
    expect(files.flatMap((f) => (f.kind === 'files' ? f.paths : []))).toEqual(['x.txt', 'y.txt'])

    expect(store.get(source.id)).toBeUndefined()
  })

  it('combines lastActiveAt as max and bumps updatedAt', () => {
    const { store, tick, now } = makeHarness()
    const target = store.create('目标')!
    store.update(target.id, { status: 'paused' }) // pause early so source stays fresher
    const targetActiveAt = store.get(target.id)!.lastActiveAt
    tick(60_000)
    const source = store.create('来源')!
    const sourceActiveAt = store.get(source.id)!.lastActiveAt
    store.update(source.id, { status: 'paused' })

    expect(store.merge(target.id, source.id)).toBe(true)
    expect(store.get(target.id)!.lastActiveAt).toBe(Math.max(targetActiveAt, sourceActiveAt))
    expect(store.get(target.id)!.updatedAt).toBe(now())
  })

  it('rejects self-merge and missing tasks', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    expect(store.merge(task.id, task.id)).toBe(false)
    expect(store.merge(task.id, 't_missing')).toBe(false)
    expect(store.merge('t_missing', task.id)).toBe(false)
    expect(store.list()).toHaveLength(1)
  })

  it('keeps the target status unchanged', () => {
    const { store } = makeHarness()
    const target = store.create('目标')!
    store.update(target.id, { status: 'paused' })
    const source = store.create('来源')!
    store.merge(target.id, source.id)
    expect(store.get(target.id)!.status).toBe('paused')
  })
})

describe('TaskStore — link/unlink resources', () => {
  it('links a clipboard ref and rejects duplicates', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    const ref: ResourceRef = { kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'p', capturedAt: 1 } }
    expect(store.linkItem(task.id, ref)).toBe(true)
    expect(store.linkItem(task.id, ref)).toBe(false)
    expect(store.get(task.id)!.resources).toHaveLength(1)
  })

  it('links files refs with per-path dedup and drops empty refs', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    expect(store.linkItem(task.id, { kind: 'files', paths: ['a.txt', 'b.txt'] })).toBe(true)
    expect(store.linkItem(task.id, { kind: 'files', paths: ['b.txt', 'c.txt'] })).toBe(true)
    expect(store.linkItem(task.id, { kind: 'files', paths: ['a.txt', 'b.txt', 'c.txt'] })).toBe(false)
    const files = store.get(task.id)!.resources.filter((r) => r.kind === 'files')
    expect(files.flatMap((f) => (f.kind === 'files' ? f.paths : []))).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('unlinks a clipboard ref by itemId', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    store.linkItem(task.id, { kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'p', capturedAt: 1 } })
    expect(store.unlinkItem(task.id, { kind: 'clipboard', itemId: 'i1' })).toBe(true)
    expect(store.get(task.id)!.resources).toHaveLength(0)
    expect(store.unlinkItem(task.id, { kind: 'clipboard', itemId: 'i1' })).toBe(false)
  })

  it('unlinks a files ref only by exact path list', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    store.linkItem(task.id, { kind: 'files', paths: ['a.txt', 'b.txt'] })
    expect(store.unlinkItem(task.id, { kind: 'files', paths: ['a.txt'] })).toBe(false) // partial list ≠ exact
    expect(store.unlinkItem(task.id, { kind: 'files', paths: ['b.txt', 'a.txt'] })).toBe(true) // order-insensitive
    expect(store.get(task.id)!.resources).toHaveLength(0)
  })

  it('returns false for unknown tasks', () => {
    const { store } = makeHarness()
    expect(store.linkItem('t_nope', { kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'p', capturedAt: 1 } })).toBe(false)
    expect(store.unlinkItem('t_nope', { kind: 'clipboard', itemId: 'i1' })).toBe(false)
  })
})

describe('TaskStore — snapshots and alive', () => {
  it('builds a 200-char text preview without the full body', () => {
    const ref = buildClipboardRef({ id: 'i1', capturedAt: 42, data: { kind: 'text', text: 'x'.repeat(500), isUrl: false } })
    expect(ref.kind).toBe('clipboard')
    if (ref.kind === 'clipboard') {
      expect(ref.snapshot.type).toBe('text')
      expect(ref.snapshot.preview).toHaveLength(200)
      expect(ref.snapshot.capturedAt).toBe(42)
    }
  })

  it('snapshots image identity + dimensions + bytes', () => {
    const ref = buildClipboardRef({
      id: 'i2',
      capturedAt: 7,
      data: { kind: 'image', imageId: 'img1', width: 1920, height: 1080, bytes: 2048 }
    })
    if (ref.kind === 'clipboard' && ref.snapshot.type === 'image') {
      expect(ref.snapshot.imageId).toBe('img1')
      expect(ref.snapshot.width).toBe(1920)
      expect(ref.snapshot.height).toBe(1080)
      expect(ref.snapshot.bytes).toBe(2048)
      expect(ref.snapshot.preview).toContain('1920×1080')
    } else {
      throw new Error('expected image clipboard ref')
    }
  })

  it('collapses an image collection into a count preview with summed bytes', () => {
    const ref = buildClipboardRef({
      id: 'i3',
      capturedAt: 1,
      data: {
        kind: 'image-collection',
        images: [
          { imageId: 'a', width: 10, height: 10, bytes: 100 },
          { imageId: 'b', width: 20, height: 20, bytes: 200 }
        ]
      }
    })
    if (ref.kind === 'clipboard' && ref.snapshot.type === 'image-collection') {
      expect(ref.snapshot.preview).toBe('2 images')
      expect(ref.snapshot.bytes).toBe(300)
      expect(ref.snapshot.imageId).toBe('a')
    } else {
      throw new Error('expected image-collection clipboard ref')
    }
  })

  it('turns a files item into a plain files ref', () => {
    const ref = buildClipboardRef({ id: 'i4', capturedAt: 1, data: { kind: 'files', paths: ['a.txt'] } })
    expect(ref).toEqual({ kind: 'files', paths: ['a.txt'] })
  })

  it('flags clipboard refs with ItemStore liveness; files refs are always alive', () => {
    const { store } = makeHarness({
      isItemAlive: (itemId) => itemId === 'alive-id'
    })
    const task = store.create('任务')!
    store.linkItem(task.id, { kind: 'clipboard', itemId: 'alive-id', snapshot: { type: 'text', preview: 'p', capturedAt: 1 } })
    store.linkItem(task.id, { kind: 'clipboard', itemId: 'dead-id', snapshot: { type: 'text', preview: 'p', capturedAt: 1 } })
    store.linkItem(task.id, { kind: 'files', paths: ['x.txt'] })

    const dto = store.toDto()[0]!
    const alive = dto.resources.find((r) => r.kind === 'clipboard' && r.itemId === 'alive-id')!.alive
    const dead = dto.resources.find((r) => r.kind === 'clipboard' && r.itemId === 'dead-id')!.alive
    const files = dto.resources.find((r) => r.kind === 'files')!.alive
    expect(alive).toBe(true)
    expect(dead).toBe(false)
    expect(files).toBe(true)
  })

  it('defaults to alive when no liveness probe is injected', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    store.linkItem(task.id, { kind: 'clipboard', itemId: 'x', snapshot: { type: 'text', preview: 'p', capturedAt: 1 } })
    expect(store.toDto()[0]!.resources[0]!.alive).toBe(true)
  })
})

describe('TaskStore — persistence round-trip', () => {
  it('persists with a version field and reloads identically', () => {
    const harness = makeHarness()
    const { store } = harness
    const task = store.create('任务', { note: 'n', apps: [app('code.exe', 'Code')] })!
    store.linkItem(task.id, { kind: 'clipboard', itemId: 'i1', snapshot: { type: 'text', preview: 'p', capturedAt: 1 } })
    store.update(task.id, { status: 'paused' })

    expect(harness.storage.load()!.version).toBe(STORAGE_VERSION)

    const reloaded = new TaskStore({ load: harness.storage.load, save: harness.storage.save, now: harness.now })
    reloaded.load()
    const task2 = reloaded.get(task.id)!
    expect(task2).toEqual(store.get(task.id))
  })

  it('round-trips the full task list', () => {
    const harness = makeHarness()
    const { store, tick } = harness
    const a = store.create('A')!
    tick(1000)
    const b = store.create('B')!
    store.update(b.id, { status: 'completed' })
    void a

    const reloaded = new TaskStore({ load: harness.storage.load, save: harness.storage.save, now: harness.now })
    reloaded.load()
    expect(reloaded.toDto().map((t) => [t.title, t.status])).toEqual([
      ['A', 'active'],
      ['B', 'completed']
    ])
  })

  it('salvages corrupt or missing indexes instead of crashing', () => {
    const empty = new TaskStore({ load: () => null, save: () => {} })
    empty.load()
    expect(empty.list()).toEqual([])

    const garbage = new TaskStore({ load: () => ({ version: 1, tasks: 'nope' as never }), save: () => {} })
    garbage.load()
    expect(garbage.list()).toEqual([])
  })

  it('drops structurally broken tasks, repairs weak fields, dedupes ids', () => {
    const broken = [
      null,
      { id: 't_ok', title: '好', status: 'active', createdAt: 1, updatedAt: 2, lastActiveAt: 3, apps: [], resources: [] },
      { id: 't_noTitle' },
      { id: 't_badStatus', title: '坏状态', status: 'exploding' },
      { id: 't_badStatus', title: '重复id', status: 'paused' },
      { id: 't_badNums', title: '坏数字', status: 'active', createdAt: 'x', updatedAt: NaN, lastActiveAt: 'y' },
      { id: 't_badRes', title: '坏资源', status: 'active', apps: [{ name: 'no-id' }], resources: [{ kind: 'clipboard', itemId: 5 }] }
    ]
    const store = new TaskStore({ load: () => ({ version: 1, tasks: broken as never }), save: () => {} })
    store.load()

    const byId = new Map(store.list().map((t) => [t.id, t]))
    expect(byId.size).toBe(4)
    expect(byId.get('t_ok')!.status).toBe('active')
    expect(byId.get('t_badStatus')!.status).toBe('paused') // unknown status coerced, never resurrected as active
    expect(byId.get('t_badNums')!.createdAt).toBe(0)
    expect(byId.get('t_badRes')!.apps).toEqual([])
    expect(byId.get('t_badRes')!.resources).toEqual([])
  })
})

describe('TaskStore — t27 evidence fields (windowTitles/confidence/reason)', () => {
  it('round-trips window titles, confidence and reason through persistence', () => {
    const harness = makeHarness()
    const { store } = harness
    store.create('任务', {
      windowTitles: ['App.tsx — Trace', 'docs.example.com'],
      confidence: 0.82,
      reason: 'Writing docs'
    })

    const reloaded = new TaskStore({ load: harness.storage.load, save: harness.storage.save, now: harness.now })
    reloaded.load()
    const task = reloaded.list()[0]!
    expect(task.windowTitles).toEqual(['App.tsx — Trace', 'docs.example.com'])
    expect(task.confidence).toBe(0.82)
    expect(task.reason).toBe('Writing docs')
  })

  it('tolerates legacy tasks without the t27 fields and sanitizes garbage evidence', () => {
    const legacy = [
      { id: 't_old', title: '旧任务', status: 'active', createdAt: 1, updatedAt: 2, lastActiveAt: 3, apps: [], resources: [] },
      {
        id: 't_garbage',
        title: '坏证据',
        status: 'paused',
        windowTitles: ['a', 5, '', 'a'],
        confidence: 1.5,
        reason: 42,
        createdAt: 1,
        updatedAt: 2,
        lastActiveAt: 3,
        apps: [],
        resources: []
      }
    ]
    const store = new TaskStore({ load: () => ({ version: 1, tasks: legacy as never }), save: () => {} })
    store.load()

    const old = store.get('t_old')!
    expect(old.windowTitles).toEqual([])
    expect(old.confidence).toBeUndefined()
    expect(old.reason).toBeUndefined()

    const garbage = store.get('t_garbage')!
    expect(garbage.windowTitles).toEqual(['a']) // non-strings and dupes dropped
    expect(garbage.confidence).toBeUndefined() // out of the 0-1 domain
    expect(garbage.reason).toBeUndefined() // non-string
  })

  it('sanitizes evidence fields at creation', () => {
    const { store } = makeHarness()
    const task = store.create('任务', {
      windowTitles: ['  A  ', '', 'A', 5] as unknown as string[],
      confidence: 2,
      reason: '   '
    })!
    expect(task.windowTitles).toEqual(['A'])
    expect(task.confidence).toBeUndefined()
    expect(task.reason).toBeUndefined()
  })

  it('applies evidence patches and clears reason with an empty string', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    expect(store.update(task.id, { windowTitles: ['W1', 'W1', 'W2'], confidence: 0.9, reason: '  R  ' })).toBe(true)
    expect(store.get(task.id)!.windowTitles).toEqual(['W1', 'W2'])
    expect(store.get(task.id)!.confidence).toBe(0.9)
    expect(store.get(task.id)!.reason).toBe('R')

    expect(store.update(task.id, { reason: '' })).toBe(true)
    expect(store.get(task.id)!.reason).toBeUndefined()
  })

  it('rejects invalid evidence patches without touching the task', () => {
    const { store } = makeHarness()
    const task = store.create('任务')!
    expect(store.update(task.id, { windowTitles: 'nope' as never })).toBe(false)
    expect(store.update(task.id, { confidence: 1.5 })).toBe(false)
    expect(store.update(task.id, { confidence: NaN })).toBe(false)
    expect(store.update(task.id, { reason: 7 as never })).toBe(false)
    expect(store.get(task.id)!.windowTitles).toEqual([])
    expect(store.get(task.id)!.confidence).toBeUndefined()
    expect(store.get(task.id)!.reason).toBeUndefined()
  })
})
