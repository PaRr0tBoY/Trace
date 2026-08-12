/**
 * 推荐历史与冷却 (t46, spec 实现决策 9).
 *
 * 语义指纹（语义簇 + 关键实体 + 时段）：v1 以活动签名为基础 — 指纹 = 排序应用
 * 键集合（语义簇/关键实体）+ 小时桶（时段），带 semantic@1 版本前缀。同活动
 * 重复生成同指纹（确定性）；版本前缀为将来的语义聚类指纹（semantic@2，本地
 * 模型开时）留位，两者互不冲突。实现与活动签名同居 activityLedger（避免模块
 * 环），此处 re-export。
 *
 * 分级冷却：同指纹按记录等级 L1 未采纳 24h / L2 忽略 48h / L3 同类 7 天；
 * 每条记录的冷却终点 = shownAt + 等级时长，查询取同指纹全部记录的最大剩余
 * 时间。outcome = accepted 的记录永久冷却（该时段指纹已被用户采纳，不再建议）。
 *
 * 记录与回填：record() 先找该指纹最新一条未决（noop）记录并回填 outcome /
 * actionReason（未来 runAnalysis 在展示时落 noop 行；t46 的引擎记录点在
 * accept/ignore 处直接落终态行），找不到则插入新行。回填保留原 shownAt。
 *
 * Pattern 学习（意图五档，词汇复用 memoryGraph 的 INTENT_TIERS）：
 *   - 采纳增强 → intent adopt-suggestion，权重取 max(weight, 0.7)；
 *   - 用户编辑标题（最强信号）→ intent user-edit，权重 1.0；
 *   - 忽略按 actionReason 衰减：wrong_task 0.2 < duplicate 0.4 < 不感兴趣 0.5
 *     < not_now 0.8；dismissed ×0.6；权重下限 0.05（只兜永不归零）。
 *   意图取历史中最高档（权重主导），衰减沿记录顺序累积。权重 = 该指纹模式对
 *   未来建议的可信度信号（t47 评级可消费）。
 *
 * 清理联动：cleanupBefore(ts) 删除未采纳（outcome != 'accepted'，含 NULL）
 * 且 shownAt < ts 的行；编排方（state.ts 胶水）与 traceStore.cleanupBefore
 * 用同一 cutoff 调用（spec 决策 8：未采纳 trace 随推荐历史 30 天清，
 * Settings.traceRetentionDays 可调）。
 *
 * 纯逻辑模块：零 Electron import，时钟 / id 注入，vitest 直测。
 */
import type { TraceDatabase } from './db'
import { createId } from './ids'
import { INTENT_TIER_WEIGHT, type IntentTier } from './memoryGraph'
import type {
  IgnoreReason,
  RecommendationActionReason,
  RecommendationLevel,
  RecommendationOutcome,
  RecommendationRecord
} from '../../shared/types'

export { recommendationFingerprint, FINGERPRINT_VERSION } from './activityLedger'

/** 分级冷却时长：L1 未采纳 24h / L2 忽略 48h / L3 同类 7 天（spec 决策 9）。 */
export const COOLDOWN_LEVEL_MS: Record<RecommendationLevel, number> = {
  1: 24 * 3_600_000,
  2: 48 * 3_600_000,
  3: 7 * 24 * 3_600_000
}

/** 忽略按 actionReason 衰减系数（越小 = 该模式越不该再建议）。 */
export const ACTION_REASON_DECAY: Record<string, number> = {
  wrong_task: 0.2,
  already_exists: 0.4,
  user_manually_dismissed: 0.5,
  not_now: 0.8,
  // 采纳类原因从不衰减（pattern 学习只按动作结果衰减）。
  user_confirmed: 1,
  user_edited_title: 1
}

/**
 * 衰减权重下限：防止连续负面信号把权重压到数值无意义（0.5 × 0.2^n 趋于 0）。
 * 刻意远低于意图五档的原始提取档 0.3 —— 单次 wrong_task 忽略（0.1）必须能与
 * 单次 duplicate（0.2）区分；下限只兜"永不归零"，评级侧的判断交给 t47。
 */
export const PATTERN_WEIGHT_FLOOR = 0.05
/** dismissed（无原因关闭卡片）的衰减。 */
export const DISMISS_DECAY = 0.6
/** 采纳建议档权重（INTENT_TIER_WEIGHT['adopt-suggestion']，显式引用防漂移）。 */
export const ADOPT_WEIGHT = INTENT_TIER_WEIGHT['adopt-suggestion']
/** 用户编辑标题档权重（意图五档最高档）。 */
export const USER_EDIT_WEIGHT = INTENT_TIER_WEIGHT['user-edit']
/** 无任何信号时的基准权重（系统推断档）。 */
export const BASE_WEIGHT = INTENT_TIER_WEIGHT['system-infer']

/** UI 忽略原因 → 存储的 actionReason（spec 决策 9 值域）。 */
export function ignoreReasonToActionReason(reason: IgnoreReason): RecommendationActionReason {
  switch (reason) {
    case 'not_interested':
      return 'user_manually_dismissed'
    case 'duplicate':
      return 'already_exists'
    case 'wrong_task':
      return 'wrong_task'
    case 'not_now':
      return 'not_now'
  }
}

/** 一条记录的冷却剩余毫秒：now ≥ 全部记录冷却终点则 0；accepted 永久冷却。 */
export function cooldownRemainingMs(records: readonly RecommendationRecord[], now: number): number {
  let remaining = 0
  for (const r of records) {
    if (r.outcome === 'accepted') return Infinity
    const rem = r.shownAt + COOLDOWN_LEVEL_MS[r.level] - now
    if (rem > remaining) remaining = rem
  }
  return remaining
}

/** 行级排序比较：shownAt 升序、同刻按 id 字典序（与 traceStore 同约定）。 */
function compareByShownAt(a: RecommendationRecord, b: RecommendationRecord): number {
  return a.shownAt - b.shownAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** 该指纹的 pattern 学习得分（意图五档权重，信号累积）。 */
export interface PatternScore {
  fingerprint: string
  /** 历史最强意图档（用户编辑 > 采纳建议 > 系统推断；权重主导）。 */
  intent: IntentTier
  /** [PATTERN_WEIGHT_FLOOR, 1] 的累积信号权重。 */
  weight: number
  accepts: number
  ignores: number
  /** 最近一次信号时刻（记录 shownAt 的最大值）。 */
  lastSeenAt: number
}

/** 从记录序列推导 pattern 得分：采纳增强 / 编辑最强 / 忽略按原因衰减。 */
export function derivePatternScore(fingerprint: string, records: readonly RecommendationRecord[]): PatternScore {
  let weight = BASE_WEIGHT
  let intent: IntentTier = 'system-infer'
  let accepts = 0
  let ignores = 0
  let lastSeenAt = 0
  // 意图取历史最高档（权重主导）：user-edit 1.0 > adopt-suggestion 0.7 >
  // system-infer 0.5。先编辑后普通采纳不得把意图降回 adopt-suggestion。
  const applyIntent = (candidate: IntentTier): void => {
    if (INTENT_TIER_WEIGHT[candidate] > INTENT_TIER_WEIGHT[intent]) intent = candidate
  }
  const sorted = [...records].sort(compareByShownAt)
  for (const r of sorted) {
    if (r.shownAt > lastSeenAt) lastSeenAt = r.shownAt
    if (r.outcome === 'accepted') {
      accepts++
      if (r.actionReason === 'user_edited_title') {
        weight = USER_EDIT_WEIGHT
        applyIntent('user-edit')
      } else {
        weight = Math.max(weight, ADOPT_WEIGHT)
        applyIntent('adopt-suggestion')
      }
    } else if (r.outcome === 'ignored') {
      ignores++
      const decay = r.actionReason !== undefined ? (ACTION_REASON_DECAY[r.actionReason] ?? 0.5) : 0.5
      weight *= decay
    } else if (r.outcome === 'dismissed') {
      weight *= DISMISS_DECAY
    }
    // noop / 未决：无信号，不改权重。
  }
  weight = Math.min(1, Math.max(PATTERN_WEIGHT_FLOOR, weight))
  return { fingerprint, intent, weight, accepts, ignores, lastSeenAt }
}

/** 写入侧：id 与 shownAt 由 store 落（注入时钟），调用方不伪造时间戳。 */
export interface RecommendationRecordInput {
  fingerprint: string
  level: RecommendationLevel
  outcome?: RecommendationOutcome
  actionReason?: RecommendationActionReason
}

export interface RecommendationHistory {
  /**
   * 记录或回填：该指纹存在最新未决（noop）行则回填 outcome/actionReason
   * （保留原 shownAt），否则插入新行（shownAt = 注入时钟的 now）。
   */
  record(input: RecommendationRecordInput): RecommendationRecord
  /** 该指纹的冷却剩余毫秒（注入时钟的 now；0 = 不在冷却；Infinity = 已采纳）。 */
  cooldownMs(fingerprint: string): number
  /** 该指纹的 pattern 学习得分（意图五档权重）。 */
  patternScore(fingerprint: string): PatternScore
  /** 全部记录，最新在前（测试 / 未来 UI）。 */
  list(): RecommendationRecord[]
  /** 清理：删除未采纳（outcome != 'accepted'）且 shownAt < ts 的行，返回条数。 */
  cleanupBefore(ts: number): number
  /** 当前记录数（测试 / 状态）。 */
  size(): number
}

export interface RecommendationHistoryOptions {
  /** 时钟注入（默认 Date.now；测试传假钟做冷却边界）。 */
  now?: () => number
  /** id 生成器注入（默认 ids.createId；测试可传确定性生成器）。 */
  createId?: () => string
}

/* ------------------------------------------------------------------ */
/* In-memory implementation — 测试假件与 DB 故障降级                    */
/* ------------------------------------------------------------------ */

export function createMemoryRecommendationHistory(options: RecommendationHistoryOptions = {}): RecommendationHistory {
  const now = options.now ?? Date.now
  const nextId = options.createId ?? createId
  const rows: RecommendationRecord[] = []

  function rowsFor(fingerprint: string): RecommendationRecord[] {
    return rows.filter((r) => r.fingerprint === fingerprint)
  }

  function findLatestOpen(fingerprint: string): RecommendationRecord | undefined {
    let best: RecommendationRecord | undefined
    for (const r of rows) {
      if (r.fingerprint !== fingerprint) continue
      if (r.outcome !== undefined && r.outcome !== 'noop') continue
      if (!best || compareByShownAt(best, r) < 0) best = r
    }
    return best
  }

  return {
    record(input): RecommendationRecord {
      const open = findLatestOpen(input.fingerprint)
      if (open) {
        open.outcome = input.outcome ?? 'noop'
        open.actionReason = input.actionReason
        return open
      }
      const row: RecommendationRecord = {
        id: nextId(),
        fingerprint: input.fingerprint,
        level: input.level,
        shownAt: now(),
        outcome: input.outcome ?? 'noop',
        ...(input.actionReason !== undefined ? { actionReason: input.actionReason } : {})
      }
      rows.push(row)
      return row
    },
    cooldownMs: (fingerprint) => cooldownRemainingMs(rowsFor(fingerprint), now()),
    patternScore: (fingerprint) => derivePatternScore(fingerprint, rowsFor(fingerprint)),
    list: () => [...rows].sort((a, b) => -compareByShownAt(a, b)),
    cleanupBefore: (ts) => {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].outcome !== 'accepted' && rows[i].shownAt < ts) rows.splice(i, 1)
      }
      return before - rows.length
    },
    size: () => rows.length
  }
}

/* ------------------------------------------------------------------ */
/* SQLite implementation — db.ts 的 recommendation_history 表          */
/* ------------------------------------------------------------------ */

interface RecommendationRow {
  id: string
  fingerprint: string
  level: RecommendationLevel
  shownAt: number
  outcome: RecommendationOutcome | null
  actionReason: RecommendationActionReason | null
}

const SELECT_COLUMNS = `id, fingerprint, level, shownAt, outcome, actionReason`

function toRecord(row: RecommendationRow): RecommendationRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    level: row.level,
    shownAt: row.shownAt,
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
    ...(row.actionReason !== null ? { actionReason: row.actionReason } : {})
  }
}

/** better-sqlite3 implementation over db.ts's recommendation_history table. */
export function createSqliteRecommendationHistory(
  db: TraceDatabase,
  options: RecommendationHistoryOptions = {}
): RecommendationHistory {
  const now = options.now ?? Date.now
  const nextId = options.createId ?? createId

  const insert = db.prepare(
    `INSERT INTO recommendation_history (id, fingerprint, level, shownAt, outcome, actionReason)
     VALUES (@id, @fingerprint, @level, @shownAt, @outcome, @actionReason)`
  )
  const selectByFingerprint = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM recommendation_history WHERE fingerprint = ?`
  )
  const selectLatestOpen = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM recommendation_history
     WHERE fingerprint = ? AND (outcome IS NULL OR outcome = 'noop')
     ORDER BY shownAt DESC, id DESC LIMIT 1`
  )
  const updateOutcome = db.prepare(`UPDATE recommendation_history SET outcome = ?, actionReason = ? WHERE id = ?`)
  const selectAll = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM recommendation_history ORDER BY shownAt DESC, id DESC`
  )
  const deleteUnadoptedBefore = db.prepare(
    `DELETE FROM recommendation_history WHERE outcome IS NOT 'accepted' AND shownAt < ?`
  )

  return {
    record(input): RecommendationRecord {
      const open = selectLatestOpen.get(input.fingerprint) as RecommendationRow | undefined
      if (open) {
        updateOutcome.run(input.outcome ?? 'noop', input.actionReason ?? null, open.id)
        return toRecord({ ...open, outcome: input.outcome ?? 'noop', actionReason: input.actionReason ?? null })
      }
      const row: RecommendationRow = {
        id: nextId(),
        fingerprint: input.fingerprint,
        level: input.level,
        shownAt: now(),
        // 无 outcome 时统一落 'noop'（与 memory 实现同形状，回读一致）。
        outcome: input.outcome ?? 'noop',
        actionReason: input.actionReason ?? null
      }
      insert.run(row)
      return toRecord(row)
    },
    cooldownMs: (fingerprint) => cooldownRemainingMs((selectByFingerprint.all(fingerprint) as RecommendationRow[]).map(toRecord), now()),
    patternScore: (fingerprint) =>
      derivePatternScore(fingerprint, (selectByFingerprint.all(fingerprint) as RecommendationRow[]).map(toRecord)),
    list: () => (selectAll.all() as RecommendationRow[]).map(toRecord),
    cleanupBefore: (ts) => deleteUnadoptedBefore.run(ts).changes,
    size: () => {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM recommendation_history`).get() as { n: number }
      return r.n
    }
  }
}
