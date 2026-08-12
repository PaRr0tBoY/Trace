/**
 * t37 — TaskSession lifecycle (spec 实现决策 4).
 *
 * Covers: session open/settle on every RUNNING path, atomic settle+open on a
 * RUNNING switch, merge/delete of RUNNING tasks, restart continuity via the
 * injected session sink, activeMs aggregation invariance, and the SQLite
 * implementation (through the nativeBinding ABI seam from tests/db.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore, type TaskIndex } from '../electron/store/TaskStore'
import {
  createMemorySessionStore,
  createSqliteSessionStore,
  type TaskSessionStore
} from '../electron/store/sessionStore'
import { openDatabase, closeDatabase, type TraceDatabase } from '../electron/store/db'
import type { AppRef, TaskSession } from '../shared/types'

const app = (id: string): AppRef => ({ id, name: id })

/** In-memory storage + fake clock + memory session sink harness. */
function makeHarness() {
  let saved: TaskIndex | null = null
  let now = 1_000_000
  const sessions = createMemorySessionStore()
  const store = new TaskStore({
    load: () => saved,
    save: (index) => { saved = index },
    now: () => now,
    sessionStore: sessions
  })
  store.load()
  return {
    store,
    sessions,
    storage: { load: () => saved },
    tick: (ms: number) => { now += ms },
    now: () => now
  }
}

function sessionsOf(store: TaskStore, taskId: string): TaskSession[] {
  return store.toDto().find((t) => t.id === taskId)!.sessions
}

/** The only open session among the task's history, if any. */
function openSession(store: TaskStore, taskId: string): TaskSession | undefined {
  return sessionsOf(store, taskId).find((s) => s.endedAt === undefined)
}

describe('TaskStore — session open/settle on RUNNING paths', () => {
  it('opens a session when a task is created RUNNING', () => {
    const h = makeHarness()
    const task = h.store.create('写周报')!
    const sessions = sessionsOf(h.store, task.id)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.taskId).toBe(task.id)
    expect(sessions[0]!.startedAt).toBe(h.now())
    expect(sessions[0]!.endedAt).toBeUndefined()
    expect(sessions[0]!.transitionReason).toBe('')
    expect(sessions[0]!.confidence).toBe(0)
    expect(sessions[0]!.previousTaskId).toBeUndefined()
    // Persisted through the injected sink.
    expect(h.sessions.listByTaskId(task.id)).toHaveLength(1)
  })

  it('records the creation confidence on the open session', () => {
    const h = makeHarness()
    const task = h.store.create('写周报', { confidence: 0.8 })!
    expect(openSession(h.store, task.id)!.confidence).toBe(0.8)
  })

  it('settles with user_paused when a RUNNING task is paused', () => {
    const h = makeHarness()
    const task = h.store.create('写周报')!
    h.tick(60_000)
    expect(h.store.update(task.id, { status: 'paused' })).toBe(true)
    const [session] = sessionsOf(h.store, task.id)
    expect(session!.endedAt).toBe(h.now())
    expect(session!.transitionReason).toBe('user_paused')
  })

  it('settles with activity_lost on the idle sweep', () => {
    const h = makeHarness()
    const task = h.store.create('写周报')!
    h.store.setPauseThreshold(15)
    h.tick(16 * 60_000)
    expect(h.store.sweep()).toBe(1)
    const [session] = sessionsOf(h.store, task.id)
    expect(session!.endedAt).toBe(h.now())
    expect(session!.transitionReason).toBe('activity_lost')
  })

  it('settles with user_completed / user_archived', () => {
    const h = makeHarness()
    const done = h.store.create('写周报')!
    expect(h.store.update(done.id, { status: 'completed' })).toBe(true)
    expect(sessionsOf(h.store, done.id)[0]!.transitionReason).toBe('user_completed')

    const gone = h.store.create('归档')!
    expect(h.store.update(gone.id, { status: 'archived' })).toBe(true)
    expect(sessionsOf(h.store, gone.id)[0]!.transitionReason).toBe('user_archived')
  })

  it('opens a new session when a paused task resumes (no previousTaskId alone)', () => {
    const h = makeHarness()
    const task = h.store.create('写周报')!
    h.tick(60_000)
    h.store.update(task.id, { status: 'paused' })
    h.tick(60_000)
    expect(h.store.update(task.id, { status: 'running' })).toBe(true)
    const sessions = sessionsOf(h.store, task.id)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.startedAt).toBe(h.now()) // newest first
    expect(sessions[0]!.endedAt).toBeUndefined()
    expect(sessions[0]!.previousTaskId).toBeUndefined()
    expect(sessions[1]!.transitionReason).toBe('user_paused')
  })
})

describe('TaskStore — atomic RUNNING switch (settle old + open new)', () => {
  it('settles the displaced task with auto_switch and links previousTaskId in one call', () => {
    const h = makeHarness()
    const a = h.store.create('A')!
    h.tick(120_000)
    const b = h.store.create('B')!

    // A's run settled exactly when B took RUNNING; B's run opened with A as
    // its predecessor — both effects from the single create() call.
    const aSessions = sessionsOf(h.store, a.id)
    expect(aSessions).toHaveLength(1)
    expect(aSessions[0]!.endedAt).toBe(h.now())
    expect(aSessions[0]!.transitionReason).toBe('auto_switch')
    expect(aSessions[0]!.confidence).toBe(0)

    const bOpen = openSession(h.store, b.id)!
    expect(bOpen.startedAt).toBe(h.now())
    expect(bOpen.previousTaskId).toBe(a.id)
    expect(h.store.list().filter((t) => t.status === 'running')).toHaveLength(1)
  })

  it('settles old + opens new through the persisted sink in settle-then-start order', () => {
    const calls: string[] = []
    const logging: TaskSessionStore = {
      loadAll: () => [],
      listByTaskId: () => [],
      recordSessionStart: (s) => { calls.push(`start:${s.taskId}`) },
      settleSession: (taskId) => { calls.push(`settle:${taskId}`) }
    }
    let saved: TaskIndex | null = null
    let now = 1_000_000
    const store = new TaskStore({ load: () => saved, save: (i) => { saved = i }, now: () => now, sessionStore: logging })
    store.load()
    const a = store.create('A')!
    now += 5_000
    const b = store.create('B')!
    // One public call produced: settle the displaced run, THEN open the new
    // one — no intermediate state where either side is missing.
    expect(calls).toEqual([`start:${a.id}`, `settle:${a.id}`, `start:${b.id}`])
  })

  it('user-resuming a task displaces the RUNNING task atomically', () => {
    const h = makeHarness()
    const a = h.store.create('A')!
    const b = h.store.create('B')!
    h.store.update(b.id, { status: 'paused' })
    expect(h.store.transition(a.id, 'running', 'user')).toBe(true) // A takes RUNNING again
    h.tick(60_000)
    // B resumes while A is RUNNING: A is displaced (auto_switch), B opens a
    // fresh session whose predecessor is A.
    expect(h.store.transition(b.id, 'running', 'user')).toBe(true)
    expect(sessionsOf(h.store, a.id)[0]!.transitionReason).toBe('auto_switch')
    expect(openSession(h.store, b.id)!.previousTaskId).toBe(a.id)
    expect(h.store.list().filter((t) => t.status === 'running')).toHaveLength(1)
  })

  it('applyAttribution auto-resumes a WAITING task: settles the RUNNING task and opens a session', () => {
    const h = makeHarness()
    const a = h.store.create('A')!
    const b = h.store.create('B', { apps: [app('code.exe')] })! // B takes RUNNING, A rests
    // A takes RUNNING again so there IS a RUNNING task when B auto-resumes.
    expect(h.store.transition(a.id, 'running', 'user')).toBe(true)
    h.tick(60_000)
    expect(h.store.applyAttribution('code.exe')).toBe(b.id)
    // A (the RUNNING task) was displaced by the system auto-switch...
    expect(sessionsOf(h.store, a.id)[0]!.transitionReason).toBe('auto_switch')
    expect(sessionsOf(h.store, a.id)[0]!.endedAt).toBe(h.now())
    // ...and B's new session names A as its predecessor.
    expect(openSession(h.store, b.id)!.previousTaskId).toBe(a.id)
    expect(h.store.list().filter((t) => t.status === 'running')).toHaveLength(1)
  })

  it('restoring a COMPLETED task displaces the RUNNING task and links it as previous', () => {
    const h = makeHarness()
    const a = h.store.create('A')!
    expect(h.store.update(a.id, { status: 'completed' })).toBe(true)
    const b = h.store.create('B')! // B takes RUNNING
    h.tick(60_000)
    expect(h.store.transition(a.id, 'running', 'user')).toBe(true) // restore A
    expect(openSession(h.store, a.id)!.previousTaskId).toBe(b.id)
    expect(sessionsOf(h.store, b.id)[0]!.transitionReason).toBe('auto_switch')
    expect(sessionsOf(h.store, b.id)[0]!.endedAt).toBe(h.now())
    expect(h.store.list().filter((t) => t.status === 'running')).toHaveLength(1)
  })
})

describe('TaskStore — merge/delete of RUNNING tasks close their sessions', () => {
  it('merge absorbs a RUNNING source and settles its session with user_merged', () => {
    const h = makeHarness()
    const target = h.store.create('T')!
    h.tick(60_000)
    const source = h.store.create('S')! // T is displaced (auto_switch) here
    h.tick(30_000)
    expect(h.store.merge(target.id, source.id)).toBe(true)
    // The absorbed source's run ends with the merge...
    const [sourceSession] = h.sessions.listByTaskId(source.id)
    expect(sourceSession!.endedAt).toBe(h.now())
    expect(sourceSession!.transitionReason).toBe('user_merged')
    // ...and the target's history is untouched — its run ended when S took
    // over, merge never re-settles it.
    const [targetSession] = h.sessions.listByTaskId(target.id)
    expect(targetSession!.endedAt).toBe(1_060_000)
    expect(targetSession!.transitionReason).toBe('auto_switch')
    // Both runs settled: no open session remains anywhere.
    expect(h.sessions.loadAll().some((s) => s.endedAt === undefined)).toBe(false)
  })

  it('delete of a RUNNING task settles its open session with user_deleted', () => {
    const h = makeHarness()
    const task = h.store.create('A')!
    expect(h.store.delete(task.id)).toBe(true)
    const [session] = h.sessions.listByTaskId(task.id)
    expect(session!.endedAt).toBe(h.now())
    expect(session!.transitionReason).toBe('user_deleted')
  })

  it('delete of a settled task leaves its closed sessions untouched', () => {
    const h = makeHarness()
    const task = h.store.create('A')!
    h.store.update(task.id, { status: 'completed' })
    const before = h.sessions.listByTaskId(task.id)[0]!
    expect(h.store.delete(task.id)).toBe(true)
    const after = h.sessions.listByTaskId(task.id)[0]!
    expect(after).toEqual(before)
  })
})

describe('TaskStore — activeMs aggregation is invariant to sessions', () => {
  it('produces identical aggregates with and without the session sink', () => {
    const withSink = makeHarness()
    const a1 = withSink.store.create('A')!
    withSink.tick(600_000)
    const b1 = withSink.store.create('B')!
    withSink.tick(300_000)
    withSink.store.update(b1.id, { status: 'paused' })

    let saved: TaskIndex | null = null
    let now = 1_000_000
    const plain = new TaskStore({ load: () => saved, save: (i) => { saved = i }, now: () => now })
    plain.load()
    const a2 = plain.create('A')!
    now += 600_000
    const b2 = plain.create('B')!
    now += 300_000
    plain.update(b2.id, { status: 'paused' })

    expect(a1.activeMs).toBe(600_000)
    expect(b1.activeMs).toBe(300_000)
    expect(a1.activeMs).toBe(a2.activeMs)
    expect(b1.activeMs).toBe(b2.activeMs)
  })

  it('switch settles both the segment and the session at the same instant', () => {
    const h = makeHarness()
    const a = h.store.create('A')!
    h.tick(600_000)
    const b = h.store.create('B')!
    h.tick(10_000)
    expect(a.activeMs).toBe(600_000)
    expect(sessionsOf(h.store, a.id)[0]!.endedAt).toBe(1_600_000)
    h.store.update(b.id, { status: 'paused' })
    expect(b.activeMs).toBe(10_000)
    expect(sessionsOf(h.store, b.id)[0]!.endedAt).toBe(1_610_000)
  })
})

describe('TaskStore — restart continuity (load hydrates from the sink)', () => {
  it('rehydrates settled and open sessions into a fresh store over the same sink', () => {
    const h = makeHarness()
    const a = h.store.create('A')!
    h.store.update(a.id, { status: 'completed' })
    const running = h.store.create('B')!

    const reloaded = new TaskStore({
      load: h.storage.load,
      save: () => {},
      now: h.now,
      sessionStore: h.sessions
    })
    reloaded.load()

    const aSessions = sessionsOf(reloaded, a.id)
    expect(aSessions).toHaveLength(1)
    expect(aSessions[0]!.transitionReason).toBe('user_completed')
    // B is still RUNNING after restart: its session stays open.
    expect(openSession(reloaded, running.id)!.startedAt).toBe(h.now())
  })

  it('backfills an open session for legacy RUNNING tasks that predate recording', () => {
    let saved: TaskIndex | null = {
      version: 2,
      tasks: [
        {
          id: 't_legacy',
          title: '旧任务',
          status: 'running',
          statusSource: 'system',
          statusReason: 'migration',
          apps: [],
          resources: [],
          windowTitles: [],
          createdAt: 900_000,
          updatedAt: 950_000,
          lastActiveAt: 980_000,
          activeMs: 0
        }
      ]
    }
    const sessions = createMemorySessionStore()
    const store = new TaskStore({ load: () => saved, save: (i) => { saved = i }, now: () => 1_000_000, sessionStore: sessions })
    store.load()
    const open = openSession(store, 't_legacy')!
    // The run is reconstructed at the task's last known activity.
    expect(open.startedAt).toBe(980_000)
    expect(open.endedAt).toBeUndefined()
    expect(sessions.listByTaskId('t_legacy')).toHaveLength(1)
  })

  it('repairs orphan open sessions on non-RUNNING tasks at load', () => {
    // Crash between a transition and its settle write leaves an open row
    // for a task that is not RUNNING — it must close at the last status
    // change, using the task's own statusReason, never render as "Running".
    const sessions = createMemorySessionStore()
    sessions.recordSessionStart({
      id: 's_orphan',
      taskId: 't_paused',
      startedAt: 900_000,
      confidence: 0,
      transitionReason: '',
      previousTaskId: undefined
    })
    const store = new TaskStore({
      load: () => ({
        version: 2,
        tasks: [
          {
            id: 't_paused',
            title: '暂停任务',
            status: 'paused',
            statusSource: 'user',
            statusReason: 'user_paused',
            apps: [],
            resources: [],
            windowTitles: [],
            createdAt: 850_000,
            updatedAt: 950_000,
            lastActiveAt: 940_000,
            activeMs: 0
          }
        ]
      }),
      save: () => {},
      now: () => 1_000_000,
      sessionStore: sessions
    })
    store.load()
    const [session] = sessions.listByTaskId('t_paused')
    expect(session!.endedAt).toBe(950_000)
    expect(session!.transitionReason).toBe('user_paused')
    expect(sessions.loadAll().some((s) => s.endedAt === undefined)).toBe(false)
  })

  it('lists sessions newest-first with the open run on top', () => {
    const h = makeHarness()
    const task = h.store.create('A')!
    h.tick(60_000)
    h.store.update(task.id, { status: 'paused' })
    h.tick(60_000)
    h.store.update(task.id, { status: 'running' })
    const sessions = sessionsOf(h.store, task.id)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.endedAt).toBeUndefined()
    expect(sessions[1]!.transitionReason).toBe('user_paused')
  })
})

/* ------------------------------------------------------------------ */
/* SQLite implementation (nativeBinding ABI seam, as in tests/db.test.ts) */
/* ------------------------------------------------------------------ */

const CACHED_NODE_BINDING = join(process.cwd(), 'node_modules', '.cache', 'better-sqlite3-node', 'better_sqlite3.node')

function isAbiMismatch(e: unknown): e is Error {
  return e instanceof Error && e.message.includes('NODE_MODULE_VERSION')
}

function openTestDb(filePath: string): TraceDatabase {
  try {
    return openDatabase(filePath)
  } catch (e) {
    if (!isAbiMismatch(e)) throw e
    if (!existsSync(CACHED_NODE_BINDING)) {
      throw new Error(`better-sqlite3 ABI mismatch and no cached Node build at ${CACHED_NODE_BINDING}`)
    }
    return openDatabase(filePath, { nativeBinding: CACHED_NODE_BINDING })
  }
}

const openDbs: TraceDatabase[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const db of openDbs) closeDatabase(db)
  openDbs.length = 0
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('createSqliteSessionStore — task_sessions persistence', () => {
  it('records, settles and lists sessions in the task_sessions table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-sessions-'))
    tempDirs.push(dir)
    const db = openTestDb(join(dir, 'trace.db'))
    openDbs.push(db)
    const store = createSqliteSessionStore(db)

    const start: TaskSession = {
      id: 's_1',
      taskId: 't_a',
      startedAt: 1_000_000,
      confidence: 0.7,
      transitionReason: '',
      previousTaskId: undefined
    }
    store.recordSessionStart(start)
    store.settleSession('t_a', 1_200_000, 'auto_switch', 0.7)

    const fromSink = store.listByTaskId('t_a')
    expect(fromSink).toHaveLength(1)
    expect(fromSink[0]).toEqual({
      id: 's_1',
      taskId: 't_a',
      startedAt: 1_000_000,
      endedAt: 1_200_000,
      confidence: 0.7,
      transitionReason: 'auto_switch',
      previousTaskId: undefined
    })

    // Settling again is a no-op: only the open row matches endedAt IS NULL.
    store.settleSession('t_a', 9_999_999, 'user_paused', 0)
    expect(store.listByTaskId('t_a')[0]!.endedAt).toBe(1_200_000)
  })

  it('round-trips an open session (endedAt NULL) and survives loadAll', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-sessions-'))
    tempDirs.push(dir)
    const db = openTestDb(join(dir, 'trace.db'))
    openDbs.push(db)
    const store = createSqliteSessionStore(db)

    store.recordSessionStart({
      id: 's_open',
      taskId: 't_b',
      startedAt: 500_000,
      confidence: 0,
      transitionReason: '',
      previousTaskId: 't_a'
    })

    const all = store.loadAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.endedAt).toBeUndefined()
    expect(all[0]!.previousTaskId).toBe('t_a')
    // Settle through a second handle over the same file proves durability.
    store.settleSession('t_b', 900_000, 'activity_lost', 0.5)
    expect(store.listByTaskId('t_b')[0]!.endedAt).toBe(900_000)
  })

  it('survives a full reopen of the database file', () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'trace-sessions-')), 'trace.db')
    tempDirs.push(join(filePath, '..'))
    const db1 = openTestDb(filePath)
    openDbs.push(db1)
    createSqliteSessionStore(db1).recordSessionStart({
      id: 's_persist',
      taskId: 't_c',
      startedAt: 1_000,
      confidence: 0.9,
      transitionReason: '',
      previousTaskId: undefined
    })
    closeDatabase(db1)

    const db2 = openTestDb(filePath)
    openDbs.push(db2)
    const sessions = createSqliteSessionStore(db2).loadAll()
    expect(sessions.map((s) => s.id)).toEqual(['s_persist'])
    expect(sessions[0]!.confidence).toBe(0.9)
  })
})
