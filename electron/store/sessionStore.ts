/**
 * Task session persistence (t37, spec 实现决策 4).
 *
 * Pure logic: no Electron imports. TaskStore consumes the `TaskSessionStore`
 * interface (dependency injection); this module provides the durable
 * better-sqlite3 implementation over db.ts's `task_sessions` table and an
 * in-memory implementation for tests and non-persistent harnesses.
 *
 * Conventions follow db.ts: every time column is Unix epoch ms as INTEGER;
 * `endedAt` is NULL while the session is open; `transitionReason` is written
 * when the run settles, and `confidence` — recorded at start, refreshed at
 * settle — is the task's confidence at that moment (an open row carries the
 * task's confidence at start, an empty reason and NULL endedAt).
 */
import type { TaskSession } from '../../shared/types'
import type { TraceDatabase } from './db'

/** Durable sink for task sessions. Injected into TaskStore (tests use the memory impl). */
export interface TaskSessionStore {
  /** Every persisted session (startup hydration of TaskStore). */
  loadAll(): TaskSession[]
  /** All sessions of one task, oldest first. */
  listByTaskId(taskId: string): TaskSession[]
  /** Persist a newly opened session (endedAt undefined). */
  recordSessionStart(session: TaskSession): void
  /** Settle the task's open session (no-op when it has none). */
  settleSession(taskId: string, endedAt: number, transitionReason: string, confidence: number): void
}

/** In-memory implementation — the test fake and the no-persistence default. */
export function createMemorySessionStore(): TaskSessionStore {
  const sessions: TaskSession[] = []
  return {
    loadAll: () => [...sessions],
    listByTaskId: (taskId) =>
      sessions.filter((s) => s.taskId === taskId).sort((a, b) => a.startedAt - b.startedAt),
    recordSessionStart: (session) => {
      sessions.push(session)
    },
    settleSession: (taskId, endedAt, transitionReason, confidence) => {
      const open = sessions.find((s) => s.taskId === taskId && s.endedAt === undefined)
      if (open) {
        open.endedAt = endedAt
        open.transitionReason = transitionReason
        open.confidence = confidence
      }
    }
  }
}

interface SessionRow {
  id: string
  taskId: string
  startedAt: number
  endedAt: number | null
  confidence: number
  transitionReason: string
  previousTaskId: string | null
}

function toSession(row: SessionRow): TaskSession {
  return {
    id: row.id,
    taskId: row.taskId,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
    confidence: row.confidence,
    transitionReason: row.transitionReason,
    previousTaskId: row.previousTaskId ?? undefined
  }
}

/** better-sqlite3 implementation over db.ts's task_sessions table. */
export function createSqliteSessionStore(db: TraceDatabase): TaskSessionStore {
  const insert = db.prepare(
    `INSERT INTO task_sessions (id, taskId, startedAt, endedAt, confidence, transitionReason, previousTaskId)
     VALUES (@id, @taskId, @startedAt, @endedAt, @confidence, @transitionReason, @previousTaskId)`
  )
  const settle = db.prepare(
    `UPDATE task_sessions SET endedAt = @endedAt, transitionReason = @transitionReason, confidence = @confidence
     WHERE taskId = @taskId AND endedAt IS NULL`
  )
  const selectAll = db.prepare(
    `SELECT id, taskId, startedAt, endedAt, confidence, transitionReason, previousTaskId FROM task_sessions`
  )
  const selectByTask = db.prepare(
    `SELECT id, taskId, startedAt, endedAt, confidence, transitionReason, previousTaskId FROM task_sessions WHERE taskId = ? ORDER BY startedAt`
  )

  return {
    loadAll: () => selectAll.all().map((row) => toSession(row as SessionRow)),
    listByTaskId: (taskId) => selectByTask.all(taskId).map((row) => toSession(row as SessionRow)),
    recordSessionStart: (session) => {
      // better-sqlite3 named params require explicit null for absent values.
      insert.run({
        id: session.id,
        taskId: session.taskId,
        startedAt: session.startedAt,
        endedAt: session.endedAt ?? null,
        confidence: session.confidence,
        transitionReason: session.transitionReason,
        previousTaskId: session.previousTaskId ?? null
      })
    },
    settleSession: (taskId, endedAt, transitionReason, confidence) => {
      settle.run({ taskId, endedAt, transitionReason, confidence })
    }
  }
}
