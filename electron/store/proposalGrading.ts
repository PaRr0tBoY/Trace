/**
 * Proposal grading (t47, spec 实现决策 9) — 纯逻辑模块，零 Electron import。
 *
 * 建议以精取胜：每批聚类候选按 L1 主动建议 / L2 候选区 / L3 不展示三级分级。
 * 分级只消费确定性输入（聚类证据、推荐历史、任务池），全部由调用方注入：
 *
 *   - 证据：zone / margin / marginFloor（聚类器的确定性输出）
 *   - 历史：pattern 学习得分 + 最近一条记录（recommendationHistory，按
 *     recommendationPatternKey 跨小时桶累积 —— "同类"；冷却仍按指纹逐桶生效）
 *   - 任务池：应用集覆盖率（与现有任务比对，spec 决策 9 批内去重两路的任务路）
 *
 * 分级规则（决策 9 + t47 票面）：
 *   ① 明显重复：被活跃任务覆盖（应用集覆盖率 ≥ TASK_COVERAGE_THRESHOLD 且
 *      任务 running/waiting 或 lastActiveAt 在候选开始前 1h 内）→ L3 不展示。
 *   ② 近期同类拒绝（窗口 = L3 冷却 7 天）：wrong_task / already_exists（强拒）
 *      → L3；not_now / 手动关闭（轻拒）→ L2 观察。
 *   ③ 模式权重 < L3_MAX_PATTERN_WEIGHT（单次 already_exists 0.2 之上限）→ L3。
 *   ④ 非新颖（被现有任务覆盖，含归属目标 taskId）→ L2（命中强化，不升 L1）。
 *   ⑤ L1：证据稳定（非低置信带且 margin ≥ 下限或任务池为空——无竞争退化态）
 *      + 权重 ≥ L1_MIN_PATTERN_WEIGHT（单次 not_now 0.4 档）+ 近期无同类拒绝
 *      + 新颖 + 上次级别 ∈ {L1, L2}（L1 只能从 L2 升级，禁 L3→L1 直升）。
 *   其余 → L2。
 *
 * 批内去重两路（决策 9）：本地模型开 → 语义键（优化器草稿标题归一化相等）；
 * 关/降级 → 确定性指纹（recommendationFingerprint）相等。合并保留先到者
 * （优化器重排后的首位），引擎侧吸收败者字段。
 *
 * 不变量 G：L1 数量 ≤ MAX_L1_SUGGESTIONS（复用 t54 的 MAX_LOCAL_CANDIDATES
 * 过滤上限 3，不新发明）。
 */
import { normalizeContent } from './memoryGraph'
import { MAX_LOCAL_CANDIDATES } from './localModelOptimizer'
import { normalizeAppKey } from './activityLedger'
import {
  COOLDOWN_LEVEL_MS,
  derivePatternScore,
  type PatternScore
} from './recommendationHistory'
import type { RecommendationLevel, RecommendationRecord, Task } from '../../shared/types'

/** 不变量 G：L1 主动建议上限 = 本地模型过滤上限（spec 决策 5/6/11 过滤 ≤3）。 */
export const MAX_L1_SUGGESTIONS = MAX_LOCAL_CANDIDATES

/** 近期同类拒绝窗口：L3 冷却时长 7 天（决策 9）。 */
export const RECENT_REJECTION_MS = COOLDOWN_LEVEL_MS[3]

/**
 * L1 最低模式权重：单次 not_now 轻拒后 0.5×0.8=0.4 —— 一次轻拒仍够格，
 * 两次（0.32）即不再主动打扰（以精取胜）。
 */
export const L1_MIN_PATTERN_WEIGHT = 0.4

/**
 * L3 最高模式权重：单次 already_exists 0.5×0.4=0.2 之上限 —— 一次
 * "已有任务" 拒绝对该模式即可判重（与单次 wrong_task 0.1 可区分）。
 */
export const L3_MAX_PATTERN_WEIGHT = 0.25

/** 应用集覆盖率阈值：候选应用键被任务应用键覆盖的比例 ≥ 0.6 视为同一工作
 *  （与 memoryGraph 余弦去重阈值 0.6 同档，"明显重复" 的度量）。 */
export const TASK_COVERAGE_THRESHOLD = 0.6

/** 时段重叠窗口：任务 lastActiveAt 距候选开始 1h 内视为同一时段（指纹小时桶）。 */
export const TIME_OVERLAP_WINDOW_MS = 3_600_000

/**
 * 候选应用键对任务的覆盖率：任务侧键 = 每个 app 的 name / id / exePath 归一化
 * 后集合；候选侧按 app 键逐一命中计数。空候选键集 = 0（无从判定）。
 */
export function appCoverage(candidateKeys: readonly string[], task: Task): number {
  const cand = candidateKeys.map((k) => normalizeAppKey(k)).filter((k) => k.length > 0)
  if (cand.length === 0) return 0
  const taskKeys = new Set<string>()
  for (const ref of task.apps) {
    for (const k of [ref.name, ref.id, ref.exePath ?? '']) {
      const nk = normalizeAppKey(k)
      if (nk.length > 0) taskKeys.add(nk)
    }
  }
  let hits = 0
  for (const k of cand) if (taskKeys.has(k)) hits++
  return hits / cand.length
}

/** 无历史时的默认模式得分（同 derivePatternScore 空序列 —— BASE_WEIGHT 0.5）。 */
export function defaultPatternScore(patternKey: string): PatternScore {
  return derivePatternScore(patternKey, [])
}

/** 评级输入：全部确定性，调用方（engine/state）负责组装。 */
export interface GradeInput {
  /** 聚类证据带（'high' | 'low' | 'new'）。 */
  zone: 'high' | 'low' | 'new'
  /** 最佳聚类边距（best − second）。 */
  margin: number
  /** 边距下限 = θ_high − θ_low（DEFAULT_SETTINGS 0.7 − 0.45）。 */
  marginFloor: number
  /** 任务池大小（0 = 新工作无竞争，退化态视为证据稳定）。 */
  taskPoolSize: number
  /** 提案新颖：被现有任务应用集覆盖 = false。 */
  coveredByTask: boolean
  /** 明显重复：被活跃任务覆盖（时段重叠 + 任务活跃）→ L3。 */
  coveredByActiveTask: boolean
  /** 模式学习得分（跨小时桶同类累积；无历史用 defaultPatternScore）。 */
  pattern: PatternScore
  /** 该模式最近一条记录（无 = 从未展示/无同类历史）。 */
  lastRecord?: RecommendationRecord
  now: number
}

/**
 * 单候选分级（决策 9 规则表）。纯函数：同输入必同输出。
 *
 * 拒绝语义：ignored/dismissed = 用户明确拒绝（noop/accepted 不算）；其中
 * wrong_task / already_exists 为强拒（建议本身不对/已存在）→ L3，not_now /
 * 手动关闭为轻拒（时机不对，模式可信）→ L2。
 */
export function gradeProposal(input: GradeInput): RecommendationLevel {
  const { coveredByActiveTask, coveredByTask, lastRecord, pattern, now } = input

  // ① 明显重复：现有活跃任务正覆盖该应用集（时段重叠）→ L3 丢弃。
  if (coveredByActiveTask) return 3

  // ② 近期同类拒绝（窗口 = L3 冷却 7 天）：强拒 → L3；轻拒 → L2 观察。
  const rejected = lastRecord !== undefined && (lastRecord.outcome === 'ignored' || lastRecord.outcome === 'dismissed')
  if (rejected && now - lastRecord.shownAt <= RECENT_REJECTION_MS) {
    return lastRecord.actionReason === 'wrong_task' || lastRecord.actionReason === 'already_exists' ? 3 : 2
  }

  // ③ 强拒历史（累积权重低于单次 already_exists 档之上限）→ L3 静默。
  if (pattern.weight < L3_MAX_PATTERN_WEIGHT) return 3

  // ④ 非新颖：被现有任务覆盖（含归属目标）→ L2（命中强化，保留候选区）。
  if (coveredByTask) return 2

  // ⑤ L1 门槛：证据稳定 + 权重足够 + 无近期同类拒绝（②已排除）+ 只能从 L2 升级。
  const evidenceStable =
    input.zone !== 'low' && (input.zone === 'high' || input.margin >= input.marginFloor || input.taskPoolSize === 0)
  const upgradeOk = lastRecord !== undefined && (lastRecord.level === 1 || lastRecord.level === 2)
  if (evidenceStable && pattern.weight >= L1_MIN_PATTERN_WEIGHT && upgradeOk) return 1

  return 2
}

/** 批内去重输入：指纹为确定性兜底键；semanticLabel 仅本地模型路径携带。 */
export interface DedupEntry {
  id: string
  fingerprint: string
  /** 本地模型草稿标题（语义键）；缺省 = 该条目走确定性指纹键。 */
  semanticLabel?: string
}

/**
 * 批内去重（决策 9 两路）：返回 败者 id → 胜者 id 的归并表；先到者胜
 * （本地模型开时先到者 = 优化器重排后的首位）。semantic=true → 草稿标题
 * 归一化相等合并（与 memoryGraph 事实去重同规：trim + 小写 + 折叠空白），
 * 无草稿条目回落指纹键；false → 纯指纹相等。
 */
export function dedupBatch(entries: readonly DedupEntry[], opts: { semantic: boolean }): Map<string, string[]> {
  const merges = new Map<string, string[]>()
  const winnerByKey = new Map<string, string>()
  for (const e of entries) {
    let key = e.fingerprint
    if (opts.semantic && e.semanticLabel !== undefined) {
      const normalized = normalizeContent(e.semanticLabel)
      if (normalized.length > 0) key = normalized
    }
    const winner = winnerByKey.get(key)
    if (winner === undefined) {
      winnerByKey.set(key, e.id)
      continue
    }
    const losers = merges.get(winner) ?? []
    losers.push(e.id)
    merges.set(winner, losers)
  }
  return merges
}

/** 参与 L1 上限裁剪的条目（engine 把幸存者直接传入，就地降级）。 */
export interface RankedEntry {
  id: string
  level: RecommendationLevel
  confidence: number
  segmentStartTs: number
}

/**
 * 不变量 G：L1 数量 ≤ maxL1（缺省 3）。超出时按置信度降序保留（并列取更早
 * 段），其余就地降为 L2 —— 不丢弃，退回候选区。
 */
export function capL1(entries: RankedEntry[], maxL1 = MAX_L1_SUGGESTIONS): void {
  const l1 = entries.filter((e) => e.level === 1)
  if (l1.length <= maxL1) return
  const keep = new Set(
    [...l1]
      .sort((a, b) => b.confidence - a.confidence || a.segmentStartTs - b.segmentStartTs)
      .slice(0, maxL1)
      .map((e) => e.id)
  )
  for (const e of entries) if (e.level === 1 && !keep.has(e.id)) e.level = 2
}
