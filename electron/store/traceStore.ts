/**
 * AI 依据数据层 (t41, spec 实现决策 8).
 *
 * trace 表为 canonical：观察到 / 召回 / 决策 / 结果 / 隐私拦截 五类记录全字段
 * 可写可查，按 decisionId 聚成一条决策链（observed → … → result），版本信息
 * （agentVersion / policyVersion / classifierVersion / promptVersion）随每条
 * 记录落库。ai-log.jsonl 降级为 crash-safe append / 诊断 / 导出输入，不再是
 * 查询事实源（本模块不读它；导出脚本 scripts/export-golden-seed.cjs 继续消费
 * ai-log.jsonl，不受影响）。
 *
 * Pure logic: no Electron imports（硬约束）。时钟与 id 生成器注入（默认
 * Date.now / ids.createId），vitest 直测。保留规则：已采纳（taskId 非空）的
 * trace 随任务活；未采纳的由调用方按 `cleanupBefore(now - retentionDays ×
 * 86400000)` 清理（30 天保留期见 Settings.traceRetentionDays，联动编排在
 * t46 推荐历史模块；本模块只提供清理接口与实现）。
 *
 * 约定与 db.ts 一致：时间列一律 Unix epoch ms INTEGER；payload 以 JSON 字符串
 * 落库、读出时解析；查询按 (createdAt, id) 升序保证稳定顺序。
 */
import { createId } from './ids'
import type { TraceDatabase } from './db'

export const TRACE_KINDS = ['observed', 'recall', 'decision', 'result', 'privacy'] as const
export type TraceKind = (typeof TRACE_KINDS)[number]

/* ------------------------------------------------------------------ */
/* Kind payload contracts (spec 决策 8 字段清单；写侧按 Record 透传，   */
/* 未来票 (38/44/45) 的 recorder 按此契约组包，额外字段亦允许)          */
/* ------------------------------------------------------------------ */

/** observed — 观察到：活动摘要（决策链起点）。 */
export interface TraceObservedPayload {
  /** 活动摘要。 */
  summary: string
  /** 来源活动 id（activityLedger 产物，可选）。 */
  activityId?: string
}

/** recall — 召回了：各工具调用（工具/查询/条数/预览 ≤200 字符）。 */
export interface TraceRecallPayload {
  /** 工具名：search_tasks | search_activities | search_clipboard | search_memories | … */
  tool: string
  query?: string
  /** 命中条数。 */
  count: number
  /** 预览，≤200 字符（spec 决策 8）。 */
  preview?: string
  /** 检索命中路径（story 28：默认 1-hop / 上限 2-hop）。 */
  hitPath?: string[]
  hops?: number
}

/** decision — 决策了：理由全文 + 评级 + 置信度。 */
export interface TraceDecisionPayload {
  /** 任务决策动作（CONTEXT.md 词汇表：continue/switch/new/merge/ignore）。 */
  action: 'continue' | 'switch' | 'new' | 'merge' | 'ignore'
  targetTaskId?: string
  title?: string
  /** 理由全文。 */
  reason: string
  /** 评级（决策者自定义，可选）。 */
  rating?: string
  /** 置信度。 */
  confidence: number
}

/** result — 结果：采纳/忽略回填（决策链终点）。 */
export interface TraceResultPayload {
  /** 采纳/忽略回填。 */
  outcome: 'accepted' | 'merged' | 'ignored' | 'dismissed'
  proposalId?: string
  /** 采纳后的目标任务（与行级 taskId 一致，采纳即回填）。 */
  taskId?: string
  actionReason?: string
}

/** privacy — 隐私拦截（privacyGate 的 denial reason，如"已被隐私政策过滤"）。 */
export interface TracePrivacyPayload {
  /** 拦截原因。 */
  reason: string
  access?: string
  appExePath?: string
  contentType?: string
}

/* ------------------------------------------------------------------ */
/* Store contract                                                      */
/* ------------------------------------------------------------------ */

/** 写入侧：id 与 createdAt 由 store 落（注入时钟），调用方不伪造时间戳。 */
export interface TraceInput {
  /** 决策链分组 id：一条 observed → … → result 链共享同一个 decisionId。 */
  decisionId: string
  kind: TraceKind
  /** Kind 专属 JSON 体（按上方 payload contract 组包）。 */
  payload: Record<string, unknown>
  /** 已采纳提案关联任务：非空即"随任务活"，保留清理不碰。 */
  taskId?: string
  agentVersion?: string
  policyVersion?: string
  classifierVersion?: string
  promptVersion?: string
}

export interface TraceRecord extends TraceInput {
  id: string
  /** Unix epoch ms（store 以注入时钟落）。 */
  createdAt: number
}

export interface TraceStore {
  /** 追加一条 trace 记录。 */
  append(record: TraceInput): TraceRecord
  /** 按 id 查。 */
  getById(id: string): TraceRecord | undefined
  /** 一条决策链的完整记录，按 (createdAt, id) 升序。 */
  listByDecisionId(decisionId: string): TraceRecord[]
  /** 已采纳提案关联任务的全部 trace（含回填后的行级 taskId），按 (createdAt, id) 升序。 */
  listByTaskId(taskId: string): TraceRecord[]
  /** 时间窗 [from, to)（epoch ms，含 from 不含 to），按 (createdAt, id) 升序。 */
  listInWindow(from: number, to: number): TraceRecord[]
  /**
   * 保留清理：删除未采纳（taskId IS NULL）且 createdAt < ts 的记录，返回删除
   * 条数。已采纳（taskId 非空）随任务活，本接口不碰（任务删除时的连带清理属
   * 任务生命周期，t42 在此实现）。t46 联动调用方式：
   *   cleanupBefore(now - settings.traceRetentionDays * 86400000)
   */
  cleanupBefore(ts: number): number
  /**
   * 任务生命周期连带清理（t42）：任务硬删除时删掉它的已采纳 trace，返回删除
   * 条数。spec 决策 8：已采纳 trace 随任务活，任务没了它也没了。
   */
  deleteByTaskId(taskId: string): number
  /**
   * 任务合并连带迁移（t42）：source 任务并入 target 后，把挂在 source 下的已
   * 采纳 trace 改挂 target（决策链对幸存任务仍然有效），返回迁移条数。避免
   * taskId 指向已删除任务的孤儿行（既不显示也永远清不掉）。
   */
  reassignTaskId(fromTaskId: string, toTaskId: string): number
}

/**
 * 任务合并连带迁移的调用方组合缝（t42）：IPC 层把 TaskStore.merge 的结果
 * 传进来，只有合并成功才迁移 trace 行——merge 失败（如 target === source）
 * 时绝不挪数据。独立成纯函数以便 vitest 直测该分支（IPC 层无法单测）。
 */
export function rehomeTraceAfterMerge(
  trace: TraceStore | null,
  merged: boolean,
  fromTaskId: string,
  toTaskId: string
): number {
  if (!merged || !trace) return 0
  return trace.reassignTaskId(fromTaskId, toTaskId)
}

export interface TraceStoreOptions {
  /** 时钟注入（默认 Date.now；测试传假钟做保留边界）。 */
  now?: () => number
  /** id 生成器注入（默认 ids.createId；测试可传确定性生成器）。 */
  createId?: () => string
}

/** 行级排序比较：createdAt 升序、同刻按 id 字典序（两种实现一致）。 */
function compare(a: TraceRecord, b: TraceRecord): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/* ------------------------------------------------------------------ */
/* In-memory implementation — 测试假件与无持久化环境                    */
/* ------------------------------------------------------------------ */

export function createMemoryTraceStore(options: TraceStoreOptions = {}): TraceStore {
  const now = options.now ?? Date.now
  const nextId = options.createId ?? createId
  const rows: TraceRecord[] = []

  function append(record: TraceInput): TraceRecord {
    const row: TraceRecord = { ...record, id: nextId(), createdAt: now() }
    rows.push(row)
    return row
  }

  function listByDecisionId(decisionId: string): TraceRecord[] {
    return rows.filter((r) => r.decisionId === decisionId).sort(compare)
  }

  function listByTaskId(taskId: string): TraceRecord[] {
    return rows.filter((r) => r.taskId === taskId).sort(compare)
  }

  function listInWindow(from: number, to: number): TraceRecord[] {
    return rows.filter((r) => r.createdAt >= from && r.createdAt < to).sort(compare)
  }

  return {
    append,
    getById: (id) => rows.find((r) => r.id === id),
    listByDecisionId,
    listByTaskId,
    listInWindow,
    cleanupBefore: (ts) => {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].taskId === undefined && rows[i].createdAt < ts) rows.splice(i, 1)
      }
      return before - rows.length
    },
    deleteByTaskId: (taskId) => {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].taskId === taskId) rows.splice(i, 1)
      }
      return before - rows.length
    },
    reassignTaskId: (fromTaskId, toTaskId) => {
      let moved = 0
      for (const row of rows) {
        if (row.taskId === fromTaskId) {
          row.taskId = toTaskId
          moved++
        }
      }
      return moved
    }
  }
}

/* ------------------------------------------------------------------ */
/* SQLite implementation — db.ts 的 trace 表                           */
/* ------------------------------------------------------------------ */

interface TraceRow {
  id: string
  decisionId: string
  kind: TraceKind
  payload: string
  taskId: string | null
  agentVersion: string | null
  policyVersion: string | null
  classifierVersion: string | null
  promptVersion: string | null
  createdAt: number
}

/** payload 是自家写入的 JSON；异常行兜底保留原文，不让一条坏数据炸掉查询。 */
function parsePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { raw }
  }
}

function toRecord(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    decisionId: row.decisionId,
    kind: row.kind,
    payload: parsePayload(row.payload),
    taskId: row.taskId ?? undefined,
    agentVersion: row.agentVersion ?? undefined,
    policyVersion: row.policyVersion ?? undefined,
    classifierVersion: row.classifierVersion ?? undefined,
    promptVersion: row.promptVersion ?? undefined,
    createdAt: row.createdAt
  }
}

const SELECT_COLUMNS = `id, decisionId, kind, payload, taskId, agentVersion, policyVersion, classifierVersion, promptVersion, createdAt`

/** better-sqlite3 implementation over db.ts's trace table. */
export function createSqliteTraceStore(db: TraceDatabase, options: TraceStoreOptions = {}): TraceStore {
  const now = options.now ?? Date.now
  const nextId = options.createId ?? createId

  const insert = db.prepare(
    `INSERT INTO trace (id, decisionId, kind, payload, taskId, agentVersion, policyVersion, classifierVersion, promptVersion, createdAt)
     VALUES (@id, @decisionId, @kind, @payload, @taskId, @agentVersion, @policyVersion, @classifierVersion, @promptVersion, @createdAt)`
  )
  const selectById = db.prepare(`SELECT ${SELECT_COLUMNS} FROM trace WHERE id = ?`)
  const selectByDecisionId = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM trace WHERE decisionId = ? ORDER BY createdAt, id`
  )
  const selectByTaskId = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM trace WHERE taskId = ? ORDER BY createdAt, id`
  )
  const selectInWindow = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM trace WHERE createdAt >= ? AND createdAt < ? ORDER BY createdAt, id`
  )
  const deleteUnadoptedBefore = db.prepare(`DELETE FROM trace WHERE taskId IS NULL AND createdAt < ?`)
  const deleteByTask = db.prepare(`DELETE FROM trace WHERE taskId = ?`)
  const reassign = db.prepare(`UPDATE trace SET taskId = ? WHERE taskId = ?`)

  return {
    append: (record) => {
      const row: TraceRow = {
        id: nextId(),
        decisionId: record.decisionId,
        kind: record.kind,
        payload: JSON.stringify(record.payload),
        // better-sqlite3 named params require explicit null for absent values.
        taskId: record.taskId ?? null,
        agentVersion: record.agentVersion ?? null,
        policyVersion: record.policyVersion ?? null,
        classifierVersion: record.classifierVersion ?? null,
        promptVersion: record.promptVersion ?? null,
        createdAt: now()
      }
      insert.run(row)
      return toRecord(row)
    },
    getById: (id) => {
      const row = selectById.get(id) as TraceRow | undefined
      return row ? toRecord(row) : undefined
    },
    listByDecisionId: (decisionId) =>
      (selectByDecisionId.all(decisionId) as TraceRow[]).map(toRecord),
    listByTaskId: (taskId) => (selectByTaskId.all(taskId) as TraceRow[]).map(toRecord),
    listInWindow: (from, to) => (selectInWindow.all(from, to) as TraceRow[]).map(toRecord),
    cleanupBefore: (ts) => deleteUnadoptedBefore.run(ts).changes,
    deleteByTaskId: (taskId) => deleteByTask.run(taskId).changes,
    reassignTaskId: (fromTaskId, toTaskId) => reassign.run(toTaskId, fromTaskId).changes
  }
}
