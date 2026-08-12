/**
 * t41 — AI 依据数据层 traceStore (spec 实现决策 8).
 *
 * Covers: five-kind write/read round-trips with every field (payload +
 * agentVersion/policyVersion/classifierVersion/promptVersion), decisionId
 * chain ordering, taskId linkage, time-window boundaries, retention cleanup
 * (unadopted purged strictly before the cutoff, adopted rows live with the
 * task), and the SQLite implementation through the nativeBinding ABI seam
 * from tests/db.test.ts — including that version columns land in separate
 * columns and payload lands as a JSON string.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMemoryTraceStore,
  createSqliteTraceStore,
  type TraceDecisionPayload,
  type TraceInput,
  type TraceObservedPayload,
  type TracePrivacyPayload,
  type TraceRecallPayload,
  type TraceResultPayload
} from '../electron/store/traceStore'
import { openDatabase, closeDatabase, type TraceDatabase } from '../electron/store/db'
import { clampSettings } from '../electron/store/settingsClamp'
import { DEFAULT_SETTINGS } from '../shared/types'

const MS_DAY = 86_400_000
/** 固定基准时刻：2026-01-01 12:00 local。 */
const T0 = new Date(2026, 0, 1, 12, 0, 0, 0).getTime()

const VERSIONS = {
  agentVersion: 'agent-1.0.0',
  policyVersion: 'policy-2',
  classifierVersion: 'cls-3.1',
  promptVersion: 'prompt-4'
}

/** 五类 kind 各一条满字段记录，共享同一个 decisionId（一条决策链）。 */
function fullChain(decisionId: string): TraceInput[] {
  const observed: TraceObservedPayload = { summary: 'activity digest', activityId: 'act-1' }
  const recall: TraceRecallPayload = {
    tool: 'search_clipboard',
    query: 'invoice',
    count: 3,
    preview: 'inv_2026.pdf',
    hitPath: ['clipboard#a1', 'entity#acme'],
    hops: 1
  }
  const decision: TraceDecisionPayload = {
    action: 'new',
    title: 'Invoicing',
    reason: 'user has been invoicing for 40 minutes',
    rating: 'good',
    confidence: 0.82
  }
  const result: TraceResultPayload = { outcome: 'accepted', proposalId: 'prop-1', taskId: 'task-1', actionReason: 'user_confirmed' }
  const privacy: TracePrivacyPayload = { reason: 'denied by content-type policy', access: 'clipboard', contentType: 'image' }
  const kinds: TraceInput[] = [
    { kind: 'observed', payload: observed },
    { kind: 'recall', payload: recall },
    { kind: 'decision', payload: decision },
    { kind: 'privacy', payload: privacy },
    { kind: 'result', payload: result }
  ]
  return kinds.map((k) => ({ decisionId, ...k, ...VERSIONS }))
}

/* ------------------------------------------------------------------ */
/* In-memory implementation                                            */
/* ------------------------------------------------------------------ */

describe('traceStore — memory impl', () => {
  it('五类 kind 全字段可写可查（含版本信息），按 id 回读 round-trip', () => {
    const store = createMemoryTraceStore({
      now: () => T0,
      createId: (() => { let n = 0; return () => `id-${n++}` })()
    })
    for (const input of fullChain('d1')) {
      store.append(input)
    }
    const rows = ['observed', 'recall', 'decision', 'privacy', 'result'].map((k) =>
      store.listByDecisionId('d1').find((r) => r.kind === k)!
    )
    for (const [i, row] of rows.entries()) {
      expect(row.id).toBe(`id-${i}`)
      expect(row.createdAt).toBe(T0)
      expect(row.decisionId).toBe('d1')
      expect(row.agentVersion).toBe(VERSIONS.agentVersion)
      expect(row.policyVersion).toBe(VERSIONS.policyVersion)
      expect(row.classifierVersion).toBe(VERSIONS.classifierVersion)
      expect(row.promptVersion).toBe(VERSIONS.promptVersion)
      expect(store.getById(row.id)).toEqual(row)
      expect(row.payload).toEqual(fullChain('d1')[i].payload)
    }
  })

  it('decisionId 链按 createdAt 升序（同刻按 id 字典序）', () => {
    let now = T0
    const store = createMemoryTraceStore({
      now: () => now,
      createId: (() => { let n = 0; return () => `id-${n++}` })()
    })
    store.append({ decisionId: 'd', kind: 'decision', payload: { action: 'continue', reason: 'r', confidence: 0.5 } })
    now += 500
    store.append({ decisionId: 'd', kind: 'result', payload: { outcome: 'ignored' } })
    now -= 500
    store.append({ decisionId: 'd', kind: 'observed', payload: { summary: 's' } })
    const chain = store.listByDecisionId('d')
    // 同刻 (T0) 按 id 字典序：decision(id-0) 先于 observed(id-2)；result 在 T0+500。
    expect(chain.map((r) => r.kind)).toEqual(['decision', 'observed', 'result'])
  })

  it('listByTaskId 只返回该任务的已采纳 trace', () => {
    const store = createMemoryTraceStore({ now: () => T0, createId: () => 'id' })
    store.append({ decisionId: 'd1', kind: 'result', payload: { outcome: 'accepted', taskId: 'task-1' }, taskId: 'task-1' })
    store.append({ decisionId: 'd2', kind: 'result', payload: { outcome: 'accepted', taskId: 'task-2' }, taskId: 'task-2' })
    store.append({ decisionId: 'd3', kind: 'decision', payload: { action: 'ignore', reason: 'r', confidence: 0.2 } })
    const task1 = store.listByTaskId('task-1')
    expect(task1).toHaveLength(1)
    expect(task1[0].decisionId).toBe('d1')
  })

  it('listInWindow 边界：用可调时钟覆盖 from/to 两侧', () => {
    let now = T0
    const store = createMemoryTraceStore({ now: () => now, createId: () => 'id' })
    store.append({ decisionId: 'before', kind: 'observed', payload: { summary: 's' } })
    now = T0 + 1000
    store.append({ decisionId: 'at-from', kind: 'observed', payload: { summary: 's' } })
    now = T0 + 2000
    store.append({ decisionId: 'inside', kind: 'observed', payload: { summary: 's' } })
    now = T0 + 3000
    store.append({ decisionId: 'at-to', kind: 'observed', payload: { summary: 's' } })
    const rows = store.listInWindow(T0 + 1000, T0 + 3000)
    expect(rows.map((r) => r.decisionId)).toEqual(['at-from', 'inside'])
  })

  it('cleanupBefore：未采纳且 createdAt < ts 删除（严格小于），返回删除条数', () => {
    let now = T0
    const store = createMemoryTraceStore({ now: () => now, createId: () => 'id' })
    store.append({ decisionId: 'old', kind: 'decision', payload: { action: 'ignore', reason: 'r', confidence: 0.1 } })
    now = T0 + 1000
    store.append({ decisionId: 'exact', kind: 'decision', payload: { action: 'ignore', reason: 'r', confidence: 0.1 } })
    store.append({ decisionId: 'fresh', kind: 'decision', payload: { action: 'ignore', reason: 'r', confidence: 0.1 } })
    const deleted = store.cleanupBefore(T0 + 1000)
    expect(deleted).toBe(1)
    expect(store.listByDecisionId('old')).toHaveLength(0)
    expect(store.listByDecisionId('exact')).toHaveLength(1)
    expect(store.listByDecisionId('fresh')).toHaveLength(1)
  })

  it('cleanupBefore 不碰已采纳（taskId 非空）记录，无论多老', () => {
    const store = createMemoryTraceStore({ now: () => T0, createId: () => 'id' })
    store.append({ decisionId: 'adopted', kind: 'result', payload: { outcome: 'accepted' }, taskId: 'task-1' })
    store.append({ decisionId: 'unadopted', kind: 'decision', payload: { action: 'ignore', reason: 'r', confidence: 0.1 } })
    expect(store.cleanupBefore(T0 + 1)).toBe(1)
    expect(store.listByTaskId('task-1')).toHaveLength(1)
    expect(store.listByDecisionId('unadopted')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* SQLite implementation (nativeBinding ABI seam, as in tests/db.test.ts) */
/* ------------------------------------------------------------------ */

const CACHED_NODE_BINDING = join(process.cwd(), 'node_modules', '.cache', 'better-sqlite3-node', 'better_sqlite3.node')

/** 递增 id 生成器：避免 UNIQUE 约束且断言顺序确定。 */
function counterId(): () => string {
  let n = 0
  return () => `id-${n++}`
}

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

describe('createSqliteTraceStore — trace table persistence', () => {
  it('五类链落库并跨实例回读；payload 为 JSON 字符串列、版本信息独立列入库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-store-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'trace.db')

    const db1 = openTestDb(filePath)
    openDbs.push(db1)
    const store1 = createSqliteTraceStore(db1, { now: () => T0, createId: counterId() })
    for (const input of fullChain('d1')) {
      store1.append(input)
    }
    // 直接查表：payload 是 JSON 字符串，版本列与 payload 分列存放。
    const row = db1
      .prepare('SELECT payload, agentVersion, policyVersion, classifierVersion, promptVersion, createdAt FROM trace WHERE kind = ?')
      .get('recall') as Record<string, unknown>
    expect(typeof row.payload).toBe('string')
    expect(JSON.parse(row.payload as string)).toEqual(fullChain('d1')[1].payload)
    expect(row.agentVersion).toBe(VERSIONS.agentVersion)
    expect(row.policyVersion).toBe(VERSIONS.policyVersion)
    expect(row.classifierVersion).toBe(VERSIONS.classifierVersion)
    expect(row.promptVersion).toBe(VERSIONS.promptVersion)
    expect(row.createdAt).toBe(T0)

    // 新 store 实例（同一 DB）读回完整链。
    const store2 = createSqliteTraceStore(db1)
    const chain = store2.listByDecisionId('d1')
    expect(chain.map((r) => r.kind)).toEqual(['observed', 'recall', 'decision', 'privacy', 'result'])
    expect(chain.map((r) => r.payload)).toEqual(fullChain('d1').map((i) => i.payload))
    expect(store2.getById('id-0')?.agentVersion).toBe(VERSIONS.agentVersion)
  })

  it('时间窗与任务关联查询与 memory 实现一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-store-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'trace.db')
    const db = openTestDb(filePath)
    openDbs.push(db)
    const store = createSqliteTraceStore(db, { now: () => T0, createId: counterId() })
    store.append({ decisionId: 'd1', kind: 'result', payload: { outcome: 'accepted' }, taskId: 'task-1' })
    store.append({ decisionId: 'd2', kind: 'result', payload: { outcome: 'accepted' }, taskId: 'task-2' })
    store.append({ decisionId: 'd3', kind: 'decision', payload: { action: 'ignore', reason: 'r', confidence: 0.2 } })

    expect(store.listByTaskId('task-1').map((r) => r.decisionId)).toEqual(['d1'])
    expect(store.listInWindow(T0, T0 + 1).map((r) => r.decisionId)).toEqual(['d1', 'd2', 'd3'])
    expect(store.listInWindow(T0 + 1, T0 + 2)).toHaveLength(0)
  })

  it('cleanupBefore 物理删除未采纳行，已采纳行保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-store-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'trace.db')
    const db = openTestDb(filePath)
    openDbs.push(db)
    let now = T0
    const store = createSqliteTraceStore(db, { now: () => now, createId: counterId() })
    store.append({ decisionId: 'adopted-old', kind: 'result', payload: { outcome: 'accepted' }, taskId: 'task-1' })
    now = T0 + 1000
    store.append({ decisionId: 'unadopted-old', kind: 'decision', payload: { action: 'ignore', reason: 'r', confidence: 0.1 } })
    now = T0 + 2000
    store.append({ decisionId: 'unadopted-fresh', kind: 'decision', payload: { action: 'ignore', reason: 'r', confidence: 0.1 } })

    expect(store.cleanupBefore(T0 + 1500)).toBe(1)
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM trace').get() as { n: number }
    expect(remaining.n).toBe(2)
    expect(store.listByDecisionId('adopted-old')).toHaveLength(1)
    expect(store.listByDecisionId('unadopted-fresh')).toHaveLength(1)
    expect(store.listByDecisionId('unadopted-old')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* Settings registration (spec 决策 8: 保留期 30 天可调)                */
/* ------------------------------------------------------------------ */

describe('trace retention setting', () => {
  it('默认 30 天', () => {
    expect(DEFAULT_SETTINGS.traceRetentionDays).toBe(30)
  })

  it('clamp 到 1-365 天，垃圾值回退 30', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS, traceRetentionDays: 0 }).traceRetentionDays).toBe(1)
    expect(clampSettings({ ...DEFAULT_SETTINGS, traceRetentionDays: 9999 }).traceRetentionDays).toBe(365)
    expect(clampSettings({ ...DEFAULT_SETTINGS, traceRetentionDays: 15.6 }).traceRetentionDays).toBe(16)
    expect(clampSettings({ ...DEFAULT_SETTINGS, traceRetentionDays: NaN }).traceRetentionDays).toBe(30)
  })
})
