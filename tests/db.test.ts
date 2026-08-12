import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import {
  closeDatabase,
  openDatabase,
  runMigrations,
  SCHEMA_VERSION,
  type Migration,
  type TraceDatabase
} from '../electron/store/db'

/**
 * The installed better-sqlite3 addon may target a different runtime ABI than
 * the test runner's Node (the repo keeps the Electron-ABI build for packaging).
 * Fall back to a cached Node-ABI prebuild through the official `nativeBinding`
 * injection seam; plain production call sites are unaffected.
 */
const CACHED_NODE_BINDING = join(process.cwd(), 'node_modules', '.cache', 'better-sqlite3-node', 'better_sqlite3.node')

function isAbiMismatch(e: unknown): e is Error {
  return e instanceof Error && e.message.includes('NODE_MODULE_VERSION')
}

function newRawDatabase(filePath: string): TraceDatabase {
  try {
    return new Database(filePath)
  } catch (e) {
    if (!isAbiMismatch(e)) throw e
    if (!existsSync(CACHED_NODE_BINDING)) {
      throw new Error(`better-sqlite3 ABI mismatch and no cached Node build at ${CACHED_NODE_BINDING}`)
    }
    return new Database(filePath, { nativeBinding: CACHED_NODE_BINDING })
  }
}

/** Creation order of the seven core tables (must match the first migration). */
const CORE_TABLES = [
  'events',
  'episodes',
  'entities',
  'facts',
  'task_sessions',
  'trace',
  'recommendation_history'
]
const FTS_TABLES = ['events_fts', 'episodes_fts', 'facts_fts']

/** Temp-file + in-memory harness with afterEach cleanup. */
const open: TraceDatabase[] = []
const tempDirs: string[] = []

function newDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trace-db-'))
  tempDirs.push(dir)
  return join(dir, 'trace.db')
}

function openTemp(): { db: TraceDatabase; filePath: string } {
  const filePath = newDbPath()
  const db = openForTest(filePath)
  open.push(db)
  return { db, filePath }
}

/** openDatabase with an ABI fallback to the cached Node-ABI prebuild. */
function openForTest(filePath: string): TraceDatabase {
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

/**
 * Run a query and narrow the single result row to a plain object.
 * Validated at the boundary — every read afterward goes through `Record`.
 */
function row(db: TraceDatabase, sql: string, ...params: unknown[]): Record<string, unknown> {
  const value = db.prepare(sql).get(...params)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected one object row from: ${sql}`)
  }
  return value as Record<string, unknown>
}

function tableNames(db: TraceDatabase): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
    .all()
  if (!Array.isArray(rows)) throw new Error('expected sqlite_master rows')
  return rows.map((r) => {
    if (r === null || typeof r !== 'object' || !('name' in r) || typeof r.name !== 'string') {
      throw new Error('expected a { name: string } sqlite_master row')
    }
    return r.name
  })
}

function userVersion(db: TraceDatabase): number {
  const v = db.pragma('user_version', { simple: true })
  if (typeof v !== 'number') throw new Error(`PRAGMA user_version returned ${String(v)}`)
  return v
}

afterEach(() => {
  for (const db of open) closeDatabase(db)
  open.length = 0
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('openDatabase — fresh build', () => {
  it('creates all 7 tables in order plus FTS5, WAL on, version at head', () => {
    const { db } = openTemp()
    const names = tableNames(db)
    // FTS virtual tables come after the core tables; core order must match the migration.
    expect(names.filter((n) => CORE_TABLES.includes(n))).toEqual(CORE_TABLES)
    expect(names).toEqual(expect.arrayContaining([...CORE_TABLES, ...FTS_TABLES]))
    expect(userVersion(db)).toBe(SCHEMA_VERSION)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    // 3 FTS tables x 3 sync triggers each.
    expect(row(db, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'`).n).toBe(9)
  })

  it('builds the same schema from an in-memory database', () => {
    const db = openForTest(':memory:')
    open.push(db)
    const names = tableNames(db)
    expect(names).toEqual(expect.arrayContaining([...CORE_TABLES, ...FTS_TABLES]))
    expect(userVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('stores every time column as INTEGER epoch ms (spec convention)', () => {
    const { db } = openTemp()
    const integerCols = (table: string): Record<string, string> => {
      const rows = db.pragma(`table_info(${table})`)
      if (!Array.isArray(rows)) throw new Error(`expected table_info rows for ${table}`)
      const out: Record<string, string> = {}
      for (const r of rows) {
        if (r === null || typeof r !== 'object' || !('name' in r) || !('type' in r)) {
          throw new Error(`expected a { name, type } table_info row for ${table}`)
        }
        if (typeof r.name !== 'string' || typeof r.type !== 'string') {
          throw new Error(`expected string name/type in table_info row for ${table}`)
        }
        out[r.name] = r.type
      }
      return out
    }
    expect(integerCols('events').capturedAt).toBe('INTEGER')
    expect(integerCols('episodes').startedAt).toBe('INTEGER')
    expect(integerCols('episodes').endedAt).toBe('INTEGER')
    expect(integerCols('entities').createdAt).toBe('INTEGER')
    expect(integerCols('facts').valid_at).toBe('INTEGER')
    expect(integerCols('facts').invalid_at).toBe('INTEGER')
    expect(integerCols('facts').expired_at).toBe('INTEGER')
    expect(integerCols('task_sessions').startedAt).toBe('INTEGER')
    expect(integerCols('task_sessions').endedAt).toBe('INTEGER')
    expect(integerCols('trace').createdAt).toBe('INTEGER')
    expect(integerCols('recommendation_history').shownAt).toBe('INTEGER')
  })
})

describe('openDatabase — idempotence', () => {
  it('reopen runs no migrations and preserves rows', () => {
    const { db, filePath } = openTemp()
    db.prepare(
      `INSERT INTO events (id, kind, capturedAt, source, windowTitle, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('e1', 'app-switch', 1_000, 'code.exe', 'main.ts', '{"pid":42}')
    db.prepare(
      `INSERT INTO facts (id, type, content, source, userState, valid_at, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('f1', 'preference', 'likes the Rust type system', 'user', 'confirmed', 1_000, 1_000, 1_000)
    closeDatabase(db)

    const reopened = openForTest(filePath)
    open.push(reopened)
    expect(userVersion(reopened)).toBe(SCHEMA_VERSION)
    expect(row(reopened, `SELECT count(*) AS n FROM events`).n).toBe(1)
    expect(row(reopened, `SELECT userState FROM facts WHERE id = ?`, 'f1').userState).toBe('confirmed')
  })
})

describe('runMigrations — sequential version advancement', () => {
  const twoStep = (): Migration[] => [
    { version: 1, name: 'v1', up: (d) => d.exec(`CREATE TABLE legacy_a (x INTEGER)`) },
    { version: 2, name: 'v2', up: (d) => d.exec(`CREATE TABLE legacy_b (y TEXT)`) }
  ]

  it('applies pending steps in order and stops at the head version', () => {
    const db = newRawDatabase(newDbPath())
    open.push(db)
    runMigrations(db, twoStep())
    expect(userVersion(db)).toBe(2)
    expect(tableNames(db)).toEqual(expect.arrayContaining(['legacy_a', 'legacy_b']))
    // Re-running the same array is a no-op.
    runMigrations(db, twoStep())
    expect(userVersion(db)).toBe(2)
  })

  it('skips already-applied versions and advances only the pending tail', () => {
    const filePath = newDbPath()
    const first = newRawDatabase(filePath)
    open.push(first)
    runMigrations(first, [twoStep()[0]]) // older install at version 1
    expect(userVersion(first)).toBe(1)
    closeDatabase(first)

    const second = newRawDatabase(filePath)
    open.push(second)
    runMigrations(second, twoStep()) // v1 must not re-run (would fail on CREATE TABLE)
    expect(userVersion(second)).toBe(2)
    expect(row(second, `SELECT count(*) AS n FROM legacy_a`).n).toBe(0)
    expect(row(second, `SELECT count(*) AS n FROM legacy_b`).n).toBe(0)
  })
})

describe('FTS5 — trigger-synced search', () => {
  it('events_fts matches inserted events and drops deleted ones', () => {
    const { db } = openTemp()
    db.prepare(
      `INSERT INTO events (id, kind, capturedAt, source, windowTitle, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('e1', 'app-switch', 1_000, 'code.exe', 'writing rust code', '{"note":"hello world"}')
    expect(db.prepare(`SELECT id FROM events_fts WHERE events_fts MATCH 'rust'`).all()).toEqual([{ id: 'e1' }])
    db.prepare(`DELETE FROM events WHERE id = ?`).run('e1')
    expect(db.prepare(`SELECT id FROM events_fts WHERE events_fts MATCH 'rust'`).all()).toEqual([])
  })

  it('facts_fts syncs on insert and update', () => {
    const { db } = openTemp()
    db.prepare(
      `INSERT INTO facts (id, type, content, source, userState, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('f1', 'preference', 'likes the rust type system', 'user', 'confirmed', 1_000, 1_000)
    expect(db.prepare(`SELECT id FROM facts_fts WHERE facts_fts MATCH 'rust'`).all()).toEqual([{ id: 'f1' }])
    db.prepare(`UPDATE facts SET content = ?, updatedAt = ? WHERE id = ?`).run('prefers go generics', 2_000, 'f1')
    expect(db.prepare(`SELECT id FROM facts_fts WHERE facts_fts MATCH 'rust'`).all()).toEqual([])
    expect(db.prepare(`SELECT id FROM facts_fts WHERE facts_fts MATCH 'generics'`).all()).toEqual([{ id: 'f1' }])
  })
})

describe('column contracts', () => {
  it('every remaining table accepts a canonical row and reads it back', () => {
    const { db } = openTemp()
    db.prepare(
      `INSERT INTO episodes (id, sessionId, startedAt, endedAt, summary, content, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('ep1', 's1', 1_000, 2_000, 'wrote the schema', '{"raw":true}', 1_000)
    db.prepare(`INSERT INTO entities (id, name, type, createdAt) VALUES (?, ?, ?, ?)`).run('ent1', 'Rust', 'language', 1_000)
    db.prepare(
      `INSERT INTO task_sessions (id, taskId, startedAt, endedAt, confidence, transitionReason, previousTaskId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('s1', 't_1', 1_000, 2_000, 0.9, 'auto_switch', null)
    db.prepare(
      `INSERT INTO trace (id, decisionId, kind, payload, agentVersion, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('tr1', 'd1', 'decision', '{"reason":"clear focus"}', '0.1.0', 1_000)
    db.prepare(
      `INSERT INTO recommendation_history (id, fingerprint, level, shownAt, outcome, actionReason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('r1', 'fp-1', 2, 1_000, 'ignored', 'not_now')

    expect(row(db, `SELECT summary FROM episodes WHERE id = ?`, 'ep1').summary).toBe('wrote the schema')
    expect(row(db, `SELECT name FROM entities WHERE id = ?`, 'ent1').name).toBe('Rust')
    expect(row(db, `SELECT confidence FROM task_sessions WHERE id = ?`, 's1').confidence).toBe(0.9)
    expect(row(db, `SELECT kind FROM trace WHERE id = ?`, 'tr1').kind).toBe('decision')
    expect(row(db, `SELECT level FROM recommendation_history WHERE id = ?`, 'r1').level).toBe(2)
  })

  it('enforces the recommendation level domain (1..3)', () => {
    const { db } = openTemp()
    expect(() =>
      db.prepare(`INSERT INTO recommendation_history (id, fingerprint, level, shownAt) VALUES (?, ?, ?, ?)`).run('bad', 'fp', 4, 1_000)
    ).toThrow()
  })
})
