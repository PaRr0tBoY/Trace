/**
 * Memory graph (t48, spec 实现决策 10) — 记忆从单表 JSON 迁到三表事实图。
 *
 * episodes / entities / facts 三表 + FTS5；Profile / Pattern / Task 记忆 /
 * Preference 一律是 fact 的 type / source 字段，不建独立表（UI 分组 = 按 type
 * 过滤的视图）。事实带时间有效性（valid_at / invalid_at / expired_at）、来源链
 * （episodeId）、用户状态（confirmed / suggested / ignored / banned）。
 *
 * Pure logic: no Electron imports（硬约束）。db（better-sqlite3 句柄）、时钟、
 * id 生成器、衰减 λ 与日志注入，vitest 直测；main 胶水层（state.ts）负责打开
 * trace.db、memories.json 一次性迁移与把 MemoryStore 的持久化适配器换到本表。
 *
 * 权重（spec 决策 10）：
 *   weight = 意图五档 × 现有衰减 × 时段字段
 *   - 意图五档（用户编辑 1.0 > 用户创建 0.9 > 采纳建议 0.7 > 系统推断 0.5 >
 *     原始提取 0.3）：spec 命名前四档，"五档"的第五档 = 原始提取兜底档；
 *   - 现有衰减 = MemoryStore 的指数时间衰减 exp(-λ·周数)（同一 λ 周尺度、
 *     同一 [0.01,1] 钳制，从 MemoryStore 导出共享）。sat(hitCount) 饱和项是
 *     MemoryStore 的命中强化层，事实图不采用：新建事实 hitCount=0 会被
 *     sat(0)=0 清零，故只复用指数项；命中强化以 hitCount/lastSeenAt 落列；
 *   - 时段字段 = 时间有效性窗口（valid_at / invalid_at / expired_at，schema
 *     中唯一的时间字段）：窗口内 1.0；未开始/已过期 0.5；已失效 0。
 *
 * 去重与矛盾（确定性，spec 决策 10）：
 *   - 归一化键 = (type, 归一化 content)：trim + 小写 + 折叠空白。同键且未失效
 *     → 合并强化（hitCount+1、lastSeenAt/updatedAt 刷新、取更高意图档的内容、
 *     保留更早 createdAt 与 id），不新增行；
 *   - 余弦 ≥0.6：同 type 未失效事实按 token 频次向量（CJK 二元字组 + ASCII
 *     词）算余弦，≥0.6 视为语义重复 → 同样合并（按 createdAt 序取首个）。
 *     同主语键但内容不同的对子（矛盾候补）不并入合并——否则"北京/上海"这类
 *     同主语异取值对（余弦常 ≥0.6）会被吞进合并，矛盾消解永不触发；
 *   - 矛盾：入站事实带时间窗口（validAt/expiredAt）时，若同 (type, 主语键)
 *     存在未失效旧事实且旧事实在入站窗口起点仍有效（旧事实 valid_at 空视为
 *     恒有效 -∞，expired_at 空视为 +∞），旧事实写 invalid_at = 入站 validAt
 *     （无则 now）、权重置 0，入站作为新行插入——不覆盖、不删除，历史保留供
 *     面板裁决（spec: 画像矛盾 → Conflict 状态，t51 面板呈现）。主语键 =
 *     归一化 content 按首个停顿标点截断；无标点时取末位系词（是/为）之前的
 *     前导子句。无时间窗口的入站事实（legacy 面板记忆，恒有效主张）不触发
 *     矛盾消解（没有"时间有效性冲突"可言），只参与去重。
 *
 * 面板适配器 createMemoryIndexAdapter（spec: MemoryStore 保持纯逻辑核心 +
 * 持久化适配器换 SQLite）：legacy 四型（identity/tool/project/workflow）保留
 * 给记忆面板的 MemoryStore，图侧新事实用 profile/pattern/task/preference。
 * 适配器 load 全量镜像、save 按 id 差异同步（putFact 覆盖 + 只删除 m_ 前缀
 * 孤儿行），不触碰图侧事实。
 */
import { createId } from './ids'
import { DEFAULT_LAMBDA, MAX_LAMBDA, MIN_LAMBDA, STORAGE_VERSION, expDecay, saturation, type MemoryIndex } from './MemoryStore'
import type { TraceDatabase } from './db'
import type { TraceRecord, TraceStore } from './traceStore'
import type { Memory, MemoryType, MemoryUserState } from '../../shared/types'

/** 面板 legacy 四型——保留给 MemoryStore 适配器。 */
export const LEGACY_MEMORY_TYPES: readonly MemoryType[] = ['identity', 'tool', 'project', 'workflow']

/** 事实类型：spec 四型 + legacy 面板四型 + 自由扩展（schema 注释"…"允许）。 */
export type FactType = 'identity' | 'tool' | 'project' | 'workflow' | 'profile' | 'pattern' | 'task' | 'preference' | (string & {})

export type FactSource = 'ai-suggest' | 'task-feedback' | 'user' | 'inferred'
export type FactUserState = MemoryUserState

/** 意图五档（spec 决策 10 命名前四档；第五档 = 原始提取兜底）。 */
export const INTENT_TIERS = ['user-edit', 'user-create', 'adopt-suggestion', 'system-infer', 'raw-extract'] as const
export type IntentTier = (typeof INTENT_TIERS)[number]

/** 意图五档权重：用户编辑 > 用户创建 > 采纳建议 > 系统推断 > 原始提取。 */
export const INTENT_TIER_WEIGHT: Record<IntentTier, number> = {
  'user-edit': 1,
  'user-create': 0.9,
  'adopt-suggestion': 0.7,
  'system-infer': 0.5,
  'raw-extract': 0.3
}

/** 余弦去重阈值（spec 决策 10 已确认）：同型事实 content 余弦 ≥ 0.6 合并。 */
export const DEDUP_COSINE_THRESHOLD = 0.6

export interface FactRecord {
  id: string
  type: string
  content: string
  source: FactSource
  userState: FactUserState
  /** 意图档位，写时随权重落库。 */
  intent: IntentTier
  /** weight = 意图五档 × 现有衰减 × 时段字段（写入/强化时快照，t50 检索读）。 */
  weight: number
  /** 来源链：起源 episode（可为空）。 */
  episodeId: string | null
  /** 关系扩散边：实体 id 数组（JSON 落库），v1 无独立边表。 */
  entityIds: string[] | null
  validAt: number | null
  invalidAt: number | null
  expiredAt: number | null
  /** 冲突裁决时刻（t51）：用户裁决后落库；NULL = 未被裁决（含待审冲突）。 */
  resolvedAt: number | null
  createdAt: number
  updatedAt: number
  hitCount: number
  lastSeenAt: number
}

export interface EpisodeRecord {
  id: string
  sessionId: string | null
  startedAt: number
  endedAt: number | null
  summary: string | null
  content: string
  createdAt: number
}

export interface EntityRecord {
  id: string
  name: string
  type: string
  createdAt: number
}

export interface FactInput {
  type: FactType
  content: string
  source: FactSource
  userState?: FactUserState
  /** 显式意图档（默认 defaultIntentFor(source, userState)）。 */
  intent?: IntentTier
  episodeId?: string | null
  entityIds?: string[] | null
  /** 便捷：按 (name, type) 自动 ensure 实体并挂 entityIds。 */
  entities?: Array<{ name: string; type: string }>
  validAt?: number | null
  invalidAt?: number | null
  expiredAt?: number | null
  /** putFact 专用：显式 resolvedAt（迁移/适配器保留原值）。addFact 忽略（新行恒未裁决）。 */
  resolvedAt?: number | null
  hitCount?: number
  lastSeenAt?: number
  /** putFact 专用：显式 id（迁移/适配器必须保留原 id）。addFact 忽略（自分配）。 */
  id?: string
  /** putFact 专用：显式 createdAt（迁移保留原时间）。addFact 忽略。 */
  createdAt?: number
}

export interface FactQuery {
  /** 按 type 过滤（UI 分组基础）。 */
  types?: readonly string[]
  userStates?: readonly FactUserState[]
  /** 默认只查未失效（invalid_at IS NULL）；true 时含历史失效行。 */
  includeInvalidated?: boolean
  /** 只查当前时间有效：valid_at ≤ now 且 (expired_at 空或 > now)。 */
  validNow?: boolean
  episodeId?: string
  limit?: number
}

/* ------------------------------------------------------------------ */
/* 面板裁决（t51，spec 决策 10：Conflict 不自动覆盖，用户显式裁决）      */
/* ------------------------------------------------------------------ */

/** 冲突裁决三选：保留当前有效方 / 复活被失效方并弃当前方 / 都不保留。 */
export type ConflictResolution = 'keep-active' | 'keep-invalidated' | 'keep-none'

/** 冲突对：同 (type, 主语键) 的当前有效方 + 被自动失效方（invalid_at 非空、未裁决）。 */
export interface ConflictPair {
  active: FactRecord
  invalidated: FactRecord
}

/* ------------------------------------------------------------------ */
/* 检索 API（t50，spec 决策 10 / 用户故事 27、28）                      */
/* 确定性预筛四要素（活动 / 时间窗 / 实体 / 相关性命中），非 Top-K、    */
/* 无 embedding（本地模型 ≠ 嵌入模型）：matchedMemories = 预筛结果。    */
/* 活动匹配用归一化子串（CJK 安全，unicode61 FTS 不切中文，v1 不用      */
/* FTS 做预筛）；扩散沿实体边 / 同 episode 边，默认 1-hop、上限 2-hop。 */
/* ------------------------------------------------------------------ */

/** 确定性预筛四要素（规范顺序）。 */
export const HIT_REASONS = ['activity', 'time-window', 'entity', 'related'] as const
export type HitReason = (typeof HIT_REASONS)[number]

/** 扩散 hop 上限（用户故事 28）：默认 1、强制上限 2。 */
export const DEFAULT_MAX_HOPS = 1
export const MAX_HOPS_CAP = 2

/** 预筛默认用户状态：confirmed + suggested；banned/ignored 不进预填（调用方可显式覆盖）。 */
export const DEFAULT_RETRIEVAL_USER_STATES: readonly FactUserState[] = ['confirmed', 'suggested']

/** 检索入参：当前活动上下文（预填组装方 t55/56 从 activityLedger / 会话状态取）。 */
export interface MemoryRetrievalQuery {
  /** 活动匹配：app 名 / 窗口标题 / 内容键（归一化后子串命中 fact content 或所挂实体名）。 */
  activityKeys?: string[]
  /**
   * 时间窗匹配：当前时段 [windowStart, windowEnd] 与事实窗口 [valid_at, expired_at] 重叠。
   * 只匹配带时间窗口（valid_at / expired_at 非空）的事实——恒有效事实由其他路由覆盖。
   * null = 该侧无界；缺省（undefined）= 路由关闭。
   */
  windowStart?: number | null
  windowEnd?: number | null
  /** 实体命中：预解析的实体 id（主语/宾语）。 */
  entityIds?: string[]
  /** 实体命中：按名解析（entities.name 归一化全等，任 type）。 */
  entityNames?: string[]
  /** 来源相关：当前会话 episode 的姊妹事实。 */
  episodeId?: string | null
  /** 扩散 hop 上限：默认 1，超过 2 强制截断到 2。 */
  maxHops?: number
  /** 事实类型过滤（缺省全部）。 */
  types?: readonly string[]
  /** 用户状态过滤（缺省 confirmed + suggested；空数组视为缺省）。 */
  userStates?: readonly FactUserState[]
}

/** 单条命中：事实 + 四要素原因 + 扩散路径 + 排序分。 */
export interface MemoryHit {
  fact: FactRecord
  /** 种子 = 四要素直接命中原因（规范顺序）；扩散命中为空数组。 */
  reasons: HitReason[]
  /** 命中路径：种子 → … → 本事实的 fact id 链（种子 = [自身 id]）。 */
  path: string[]
  /** 扩散 hop 数：种子 0；沿一条关系边扩散 +1。 */
  hops: number
  /** 排序分 = 权重 × 时间有效性（48 公式，检索时按当前时钟重算）。 */
  score: number
}

export interface MemoryRetrievalResult {
  /** 排序后命中（权重降序，同分按 createdAt 新优先）。 */
  hits: MemoryHit[]
  /** 实际生效的 hop 上限（入参被钳制后的值）。 */
  maxHops: number
  /** 种子（四要素直接命中）数量。 */
  seedCount: number
}

/** hop 上限钳制：默认 1、超过 2 截断到 2（非有限值 / 小于 1 回默认）。 */
export function clampMaxHops(maxHops: number | undefined): number {
  if (maxHops === undefined || !Number.isFinite(maxHops)) return DEFAULT_MAX_HOPS
  return Math.min(MAX_HOPS_CAP, Math.max(DEFAULT_MAX_HOPS, Math.floor(maxHops)))
}

/** 区间重叠判定：事实窗口 [validAt, expiredAt] 与查询时段 [windowStart, windowEnd]（null = 无界）。 */
export function windowsOverlap(
  factValidAt: number | null,
  factExpiredAt: number | null,
  windowStart: number | null,
  windowEnd: number | null
): boolean {
  const factLeft = factValidAt ?? -Infinity
  const factRight = factExpiredAt ?? Infinity
  const queryLeft = windowStart ?? -Infinity
  const queryRight = windowEnd ?? Infinity
  return factLeft <= queryRight && queryLeft <= factRight
}

/** 种子匹配上下文：由 retrieveMemories 组装（纯函数不触 DB）。 */
export interface SeedMatchContext {
  /** 活动键（**已归一化**；组装方归一化一次，长度 < 2 的键不参与匹配）。 */
  activityKeys: readonly string[]
  /** 已解析的实体 id 集合。 */
  entityIds: ReadonlySet<string>
  /** 实体 id → 名称（活动键对实体名做双向包含匹配）。 */
  entityNameById: ReadonlyMap<string, string>
  windowStart: number | null
  windowEnd: number | null
  episodeId: string | null
}

/** 确定性预筛：四要素逐一判定，返回命中原因（规范顺序；无命中 = 空数组）。 */
export function seedReasonsFor(fact: FactRecord, ctx: SeedMatchContext): HitReason[] {
  const reasons: HitReason[] = []
  const keys = ctx.activityKeys.filter((k) => k.length >= 2)
  if (keys.length > 0) {
    const content = normalizeContent(fact.content)
    const names = (fact.entityIds ?? [])
      .map((id) => ctx.entityNameById.get(id))
      .filter((n): n is string => n !== undefined)
      .map(normalizeContent)
    // 键命中 content（子串）或所挂实体名（双向包含；单字符名只做正向包含，
    // 避免 "excel" ⊇ "x" 这类 ASCII 假阳性）。
    const hit = keys.some((k) => content.includes(k) || names.some((n) => n.includes(k) || (n.length >= 2 && k.includes(n))))
    if (hit) reasons.push('activity')
  }
  // 时间窗路由只匹配带窗口的事实：恒有效事实的"窗口"是整个时间轴，重叠无区分度。
  if (
    (ctx.windowStart !== null || ctx.windowEnd !== null) &&
    (fact.validAt !== null || fact.expiredAt !== null) &&
    windowsOverlap(fact.validAt, fact.expiredAt, ctx.windowStart, ctx.windowEnd)
  ) {
    reasons.push('time-window')
  }
  if (ctx.entityIds.size > 0 && (fact.entityIds ?? []).some((id) => ctx.entityIds.has(id))) {
    reasons.push('entity')
  }
  if (ctx.episodeId !== null && fact.episodeId === ctx.episodeId) {
    reasons.push('related')
  }
  return reasons
}

/** 关系扩散：从种子沿实体边 / 同 episode 边 BFS，≤ maxHops；命中路径与 hop 数随命中返回。 */
export function diffuseHits(
  facts: readonly FactRecord[],
  seeds: ReadonlyArray<{ fact: FactRecord; reasons: HitReason[] }>,
  maxHops: number
): MemoryHit[] {
  // 上限 2 强制（用户故事 28）：直调本函数也不绕过钳制。
  const hopsCap = clampMaxHops(maxHops)
  const byEntity = new Map<string, FactRecord[]>()
  const byEpisode = new Map<string, FactRecord[]>()
  for (const f of facts) {
    for (const eid of f.entityIds ?? []) {
      const list = byEntity.get(eid)
      if (list) list.push(f)
      else byEntity.set(eid, [f])
    }
    if (f.episodeId !== null) {
      const list = byEpisode.get(f.episodeId)
      if (list) list.push(f)
      else byEpisode.set(f.episodeId, [f])
    }
  }
  const visited = new Map<string, MemoryHit>()
  let frontier: FactRecord[] = []
  for (const seed of seeds) {
    if (visited.has(seed.fact.id)) continue
    visited.set(seed.fact.id, { fact: seed.fact, reasons: seed.reasons, path: [seed.fact.id], hops: 0, score: 0 })
    frontier.push(seed.fact)
  }
  for (let hop = 1; hop <= hopsCap; hop++) {
    const next: FactRecord[] = []
    for (const f of frontier) {
      const neighbors = new Set<FactRecord>()
      for (const eid of f.entityIds ?? []) {
        for (const n of byEntity.get(eid) ?? []) neighbors.add(n)
      }
      if (f.episodeId !== null) {
        for (const n of byEpisode.get(f.episodeId) ?? []) neighbors.add(n)
      }
      for (const n of neighbors) {
        if (visited.has(n.id)) continue
        const parent = visited.get(f.id)!
        visited.set(n.id, { fact: n, reasons: [], path: [...parent.path, n.id], hops: hop, score: 0 })
        next.push(n)
      }
    }
    frontier = next
  }
  return [...visited.values()]
}

/** 排序分 = 权重 × 时间有效性（48 公式：意图五档 × exp(-λ·周) × 时段字段），检索时重算。不修改入参命中对象（浅拷贝后写 score）。 */
export function rankHits(hits: readonly MemoryHit[], now: number, lambda: number): MemoryHit[] {
  return [...hits]
    .map((h) => ({
      ...h,
      score: computeWeight({
        intent: h.fact.intent,
        lambda,
        lastSeenAt: h.fact.lastSeenAt,
        now,
        validAt: h.fact.validAt,
        invalidAt: h.fact.invalidAt,
        expiredAt: h.fact.expiredAt
      })
    }))
    .sort(
      (a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt || (a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0)
    )
}

/**
 * trace 记录（kind='recall'，spec 决策 8）：工具 search_memories + 查询 + 条数 +
 * 路径 + hop + 原因 + 预览 ≤200。
 * 审计语义：传入完整检索结果（retrieveMemories 不内置截断），reasons / hops 取自
 * 全量命中——消费端 slice 取用 top-N 不影响 trace 召回原因的完整性。
 */
export function recordMemoryRecall(
  trace: TraceStore,
  decisionId: string,
  input: { query: string; result: MemoryRetrievalResult; preview?: string }
): TraceRecord {
  // TraceRecallPayload 契约字段 + 额外 reasons / maxHops（spec 决策 8："额外字段亦允许"）。
  // 字面量类型自带隐式索引签名，可直接作 Record<string, unknown> payload 落库。
  const payload = {
    tool: 'search_memories',
    query: input.query,
    count: input.result.hits.length,
    preview: (input.preview ?? input.result.hits[0]?.fact.content ?? '').slice(0, 200),
    hitPath: [...new Set(input.result.hits.flatMap((h) => h.path))],
    hops: input.result.hits.reduce((m, h) => Math.max(m, h.hops), 0),
    reasons: HIT_REASONS.filter((r) => input.result.hits.some((h) => h.reasons.includes(r))),
    maxHops: input.result.maxHops
  }
  return trace.append({ decisionId, kind: 'recall', payload })
}

export interface MemoryGraphStore {
  /* episodes */
  addEpisode(input: { sessionId?: string | null; startedAt?: number; endedAt?: number | null; summary?: string | null; content: string }): EpisodeRecord
  closeEpisode(id: string, endedAt?: number): boolean
  /** 全部 episode（可过滤 sessionId / 仅待整理 summary IS NULL），startedAt 升序。t49 时段整理用。 */
  listEpisodes(query?: { sessionId?: string; pendingOnly?: boolean }): EpisodeRecord[]
  /** 整理完成标记：写入提取摘要（非空）→ 不再 pending。返回是否命中（重复标记返回 false）。 */
  markEpisodeConsolidated(id: string, summary: string): boolean
  /** 事务内执行 fn：整体提交或整体回滚。t49 整理批次用它保证无部分写入。 */
  withTransaction<T>(fn: () => T): T
  /* entities */
  ensureEntity(name: string, type: string): string
  /* facts */
  addFact(input: FactInput): FactRecord | null
  /** 显式 id 全字段写（迁移/面板适配器路径）：不走去重合并，同 id 覆盖更新。 */
  putFact(input: FactInput): FactRecord | null
  /** 用户状态转换（转换规则与 MemoryStore 一致），confirm 顺带强化。 */
  updateFactState(id: string, userState: FactUserState): boolean
  /**
   * t51 面板冲突对（spec 决策 10）：同 (type, 主语键) 且被自动失效方
   * （invalid_at 非空、resolved_at 空 = 待裁决）与当前有效方的对子。
   */
  listConflicts(): ConflictPair[]
  /**
   * t51 用户裁决（spec 决策 10：不自动覆盖，只落用户决定）：
   * - keep-active → 保留当前有效方（弃方维持失效）；
   * - keep-invalidated → 复活被失效方（清 invalid_at、重算权重）并失效当前方；
   * - keep-none → 双方失效。
   * 命中该 (active, invalidated) 对即裁决成立，双方写 resolved_at（待审冲突
   * 退出面板）；不存在的对 / 形状不符返回 false。
   */
  adjudicateConflict(activeId: string, invalidatedId: string, resolution: ConflictResolution): boolean
  /** 命中强化：仅 confirmed 事实，hitCount+1、lastSeenAt 刷新、权重重算。 */
  reinforceFact(id: string): boolean
  deleteFact(id: string): boolean
  getFact(id: string): FactRecord | undefined
  listFacts(query?: FactQuery): FactRecord[]
  /** FTS5 全文检索（content），可按 type/userState 过滤。 */
  searchFacts(query: string, opts?: FactQuery): FactRecord[]
  countFacts(query?: FactQuery): number
  /**
   * t50 确定性检索（spec 决策 10）：候选 = validNow 未失效事实（默认
   * confirmed+suggested）→ 四要素预筛种子（活动 / 时间窗 / 实体 / 相关）→
   * 关系扩散（默认 1-hop、上限 2）→ 权重 × 时间有效性排序。
   */
  retrieveMemories(query?: MemoryRetrievalQuery): MemoryRetrievalResult
  /** memories.json 一次性迁移：每记忆一条事实（id/source/userState/计数保留），返回写入条数。 */
  ingestLegacyMemories(memories: readonly Memory[]): number
  /** 运行时同步衰减 λ（memoryLambda 设置变更时调用；钳制与 MemoryStore 同界）。 */
  setLambda(lambda: number): void
}

export interface MemoryGraphOptions {
  now?: () => number
  createId?: () => string
  /** 衰减 λ（每周），钳制 [0.01, 1]，默认 0.25（与 DEFAULT_SETTINGS.memoryLambda 同源）。 */
  lambda?: number
  /** 可观测性（ai-log.jsonl）：图侧新增/合并/失效/状态变更各一条。 */
  log?: (entry: Record<string, unknown>) => void
}

/** 面板持久化适配器：MemoryIndex ↔ legacy facts 行。 */
export interface MemoryIndexAdapter {
  load(): MemoryIndex | null
  save(index: MemoryIndex): void
}

/* ------------------------------------------------------------------ */
/* 纯函数：归一化 / 去重 / 余弦 / 权重                                  */
/* ------------------------------------------------------------------ */

/** λ 钳制，与 MemoryStore.setDecay 同界。 */
export function clampLambda(lambda: number): number {
  const n = Number(lambda)
  return Math.min(MAX_LAMBDA, Math.max(MIN_LAMBDA, Number.isFinite(n) ? n : DEFAULT_LAMBDA))
}

/** 归一化 content：trim + 小写 + 折叠空白（去重键与主语键共用）。 */
export function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** 确定性去重的归一化键：type + 归一化 content。 */
export function dedupKey(type: string, content: string): string {
  return `${type}\u0000${normalizeContent(content)}`
}

/**
 * 主语键：前导子句（首个停顿标点前）；无标点时取末位系词（是/为）之前
 * （"X 是 Y"断言 → 主语 X）。同一主语的不同取值（北京 vs 上海）因此同键，
 * 供矛盾消解判定；不同主语（不同句子）异键。
 */
export function subjectKey(content: string): string {
  const normalized = normalizeContent(content)
  const punct = normalized.search(/[，。；：？！、,;:?！]/)
  if (punct >= 0) return normalized.slice(0, punct)
  const copula = Math.max(normalized.lastIndexOf('是'), normalized.lastIndexOf('为'))
  if (copula > 0) return normalized.slice(0, copula)
  return normalized
}

/** token 化：ASCII 词 + CJK 二元字组（中文无分词词典时的确定性近似）。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(m[0])
  const chars = lower.replace(/[^\u4e00-\u9fff]/g, '').split('')
  for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]! + chars[i + 1]!)
  return tokens
}

/** 余弦相似度（token 频次向量）。 */
export function cosineSimilarity(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const counts = new Map<string, number>()
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1)
  let dot = 0
  for (const t of tb) {
    const c = counts.get(t)
    if (c !== undefined) dot += c
  }
  const normA = Math.sqrt(ta.length)
  const normB = Math.sqrt(tb.length)
  if (normA === 0 || normB === 0) return 0
  return dot / (normA * normB)
}

/** 时段字段因子：窗口内 1.0；未开始/已过期 0.5；已失效 0。 */
export function timeWindowFactor(validAt: number | null, invalidAt: number | null, expiredAt: number | null, now: number): number {
  if (invalidAt !== null && invalidAt <= now) return 0
  if (validAt !== null && now < validAt) return 0.5
  if (expiredAt !== null && now > expiredAt) return 0.5
  return 1
}

/** 权重 = 意图五档 × 现有衰减（exp(-λ·周)，MemoryStore 共享） × 时段字段。 */
export function computeWeight(input: {
  intent: IntentTier
  lambda: number
  lastSeenAt: number
  now: number
  validAt: number | null
  invalidAt: number | null
  expiredAt: number | null
}): number {
  return (
    INTENT_TIER_WEIGHT[input.intent] *
    expDecay(input.lastSeenAt, input.now, clampLambda(input.lambda)) *
    timeWindowFactor(input.validAt, input.invalidAt, input.expiredAt, input.now)
  )
}

/** 默认意图档（未显式指定时）：confirmed+user → 用户创建；confirmed+其他 → 采纳建议；其余 → 系统推断。 */
export function defaultIntentFor(source: FactSource, userState: FactUserState | undefined): IntentTier {
  if (userState === 'confirmed') return source === 'user' ? 'user-create' : 'adopt-suggestion'
  return 'system-infer'
}

/**
 * FTS5 MATCH 串：token 逐个加引号 AND 连接（引号内无操作符，防注入）。
 * 注意：SQLite 默认 unicode61 分词不切中文（整串 CJK 为一个 token），CJK
 * 短语检索在 v1 依赖整串/实体命中（t50 检索按 FTS+实体+时间组合），trigram
 * 分词留待需要时单独引入。
 */
export function toFtsQuery(q: string): string {
  const tokens = q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0 && t.replace(/"/g, '').trim().length > 0)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')
}

/* ------------------------------------------------------------------ */
/* SQLite implementation over db.ts's episodes / entities / facts       */
/* ------------------------------------------------------------------ */

interface FactRow {
  id: string
  type: string
  content: string
  source: FactSource
  userState: FactUserState
  intent: IntentTier
  weight: number
  episodeId: string | null
  entityIds: string | null
  valid_at: number | null
  invalid_at: number | null
  expired_at: number | null
  resolvedAt: number | null
  createdAt: number
  updatedAt: number
  hitCount: number
  lastSeenAt: number | null
}

function toFact(row: FactRow): FactRecord {
  let entityIds: string[] | null = null
  if (row.entityIds) {
    try {
      entityIds = JSON.parse(row.entityIds) as string[]
    } catch {
      entityIds = null
    }
  }
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    source: row.source,
    userState: row.userState,
    intent: row.intent,
    weight: row.weight,
    episodeId: row.episodeId,
    entityIds,
    validAt: row.valid_at,
    invalidAt: row.invalid_at,
    expiredAt: row.expired_at,
    resolvedAt: row.resolvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hitCount: row.hitCount,
    lastSeenAt: row.lastSeenAt ?? row.createdAt
  }
}

interface EpisodeRow {
  id: string
  sessionId: string | null
  startedAt: number
  endedAt: number | null
  summary: string | null
  content: string
  createdAt: number
}

interface EntityRow {
  id: string
  name: string
  type: string
  createdAt: number
}

const FACT_COLUMNS = `id, type, content, source, userState, intent, weight, episodeId, entityIds, valid_at, invalid_at, expired_at, resolvedAt, createdAt, updatedAt, hitCount, lastSeenAt`

/** better-sqlite3 implementation over db.ts's three memory-graph tables. */
export function createSqliteMemoryGraph(db: TraceDatabase, options: MemoryGraphOptions = {}): MemoryGraphStore {
  const now = options.now ?? Date.now
  const nextId = options.createId ?? createId
  // 可变：运行时设置变更（memoryLambda）经 setLambda 同步；未同步前沿用启动快照。
  let lambdaValue = clampLambda(options.lambda ?? DEFAULT_LAMBDA)
  const log = options.log ?? (() => {})

  const insertEpisode = db.prepare(
    `INSERT INTO episodes (id, sessionId, startedAt, endedAt, summary, content, createdAt)
     VALUES (@id, @sessionId, @startedAt, @endedAt, @summary, @content, @createdAt)`
  )
  const updateEpisodeEnded = db.prepare(`UPDATE episodes SET endedAt = ? WHERE id = ?`)
  const selectEpisodes = db.prepare(
    `SELECT id, sessionId, startedAt, endedAt, summary, content, createdAt FROM episodes`
  )
  const selectEpisodesBySession = db.prepare(
    `SELECT id, sessionId, startedAt, endedAt, summary, content, createdAt FROM episodes WHERE sessionId = ?`
  )
  const selectPendingEpisodes = db.prepare(
    `SELECT id, sessionId, startedAt, endedAt, summary, content, createdAt FROM episodes WHERE summary IS NULL ORDER BY startedAt, createdAt`
  )
  const updateEpisodeSummary = db.prepare(`UPDATE episodes SET summary = ? WHERE id = ? AND summary IS NULL`)
  const insertEntity = db.prepare(
    `INSERT OR IGNORE INTO entities (id, name, type, createdAt) VALUES (@id, @name, @type, @createdAt)`
  )
  const selectEntityByNameType = db.prepare(`SELECT id, name, type, createdAt FROM entities WHERE name = ? AND type = ?`)
  const selectAllEntities = db.prepare(`SELECT id, name, type, createdAt FROM entities`)
  const selectFactById = db.prepare(`SELECT ${FACT_COLUMNS} FROM facts WHERE id = ?`)
  const selectActiveByType = db.prepare(
    `SELECT ${FACT_COLUMNS} FROM facts WHERE type = ? AND invalid_at IS NULL ORDER BY createdAt, id`
  )
  const insertFact = db.prepare(
    `INSERT INTO facts (${FACT_COLUMNS})
     VALUES (@id, @type, @content, @source, @userState, @intent, @weight, @episodeId, @entityIds, @valid_at, @invalid_at, @expired_at, @resolvedAt, @createdAt, @updatedAt, @hitCount, @lastSeenAt)`
  )
  const upsertFact = db.prepare(
    `INSERT INTO facts (${FACT_COLUMNS})
     VALUES (@id, @type, @content, @source, @userState, @intent, @weight, @episodeId, @entityIds, @valid_at, @invalid_at, @expired_at, @resolvedAt, @createdAt, @updatedAt, @hitCount, @lastSeenAt)
     ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, content = excluded.content, source = excluded.source,
      userState = excluded.userState, intent = excluded.intent, weight = excluded.weight,
      episodeId = excluded.episodeId, entityIds = excluded.entityIds,
      valid_at = excluded.valid_at, invalid_at = excluded.invalid_at, expired_at = excluded.expired_at,
      resolvedAt = excluded.resolvedAt,
      updatedAt = excluded.updatedAt, hitCount = excluded.hitCount, lastSeenAt = excluded.lastSeenAt`
  )
  const updateFactMerge = db.prepare(
    `UPDATE facts SET content = @content, source = @source, userState = @userState,
       intent = @intent, hitCount = @hitCount, lastSeenAt = @lastSeenAt,
       valid_at = @valid_at, expired_at = @expired_at,
       weight = @weight, updatedAt = @updatedAt
     WHERE id = @id`
  )
  const updateFactStateStmt = db.prepare(
    `UPDATE facts SET userState = @userState, intent = @intent, hitCount = @hitCount,
       lastSeenAt = @lastSeenAt, weight = @weight, updatedAt = @updatedAt
     WHERE id = @id`
  )
  const updateFactReinforce = db.prepare(
    `UPDATE facts SET hitCount = @hitCount, lastSeenAt = @lastSeenAt, weight = @weight, updatedAt = @updatedAt WHERE id = @id`
  )
  /** 失效（自动矛盾消解 / 裁决弃方共用）：resolvedAt 一并清空——裁决路径紧跟着写回 */
  const updateFactInvalidate = db.prepare(
    `UPDATE facts SET invalid_at = @invalid_at, weight = @weight, resolvedAt = NULL, updatedAt = @updatedAt WHERE id = @id`
  )
  /** t51 裁决复活：清 invalid_at、重算权重；resolved_at 一并清（复活方重新待审）。 */
  const updateFactRestore = db.prepare(
    `UPDATE facts SET invalid_at = NULL, weight = @weight, resolvedAt = NULL, updatedAt = @updatedAt WHERE id = @id`
  )
  /** t51 裁决标记：双方写裁决时刻，待审冲突退出面板。 */
  const updateFactResolve = db.prepare(
    `UPDATE facts SET resolvedAt = @resolvedAt, updatedAt = @updatedAt WHERE id = @id`
  )
  const deleteFactStmt = db.prepare(`DELETE FROM facts WHERE id = ?`)

  /** 取更高意图档；同档取现有（内容不被降级覆盖）。 */

  function weightFor(f: { intent: IntentTier; hitCount: number; lastSeenAt: number; validAt: number | null; invalidAt: number | null; expiredAt: number | null }): number {
    return computeWeight({
      intent: f.intent,
      lambda: lambdaValue,
      lastSeenAt: f.lastSeenAt,
      now: now(),
      validAt: f.validAt,
      invalidAt: f.invalidAt,
      expiredAt: f.expiredAt
    })
  }

  function ensureEntity(name: string, type: string): string {
    const cleanName = name.trim()
    const cleanType = type.trim()
    if (!cleanName || !cleanType) return ''
    const existing = selectEntityByNameType.get(cleanName, cleanType) as EntityRow | undefined
    if (existing) return existing.id
    const id = `ent_${nextId()}`
    insertEntity.run({ id, name: cleanName, type: cleanType, createdAt: now() })
    return (selectEntityByNameType.get(cleanName, cleanType) as EntityRow | undefined)?.id ?? id
  }

  /**
   * 显式 id 全字段写（迁移/面板适配器路径）：不走去重合并，同 id 覆盖更新。
   * 权重按 (intent, hitCount, lastSeenAt, 时段字段) 计算；createdAt 保留。
   */
  function putFact(input: FactInput): FactRecord | null {
    const content = input.content.trim()
    const type = input.type.trim()
    if (!content || !type) return null
    const t = now()
    const source = input.source
    const userState = input.userState ?? 'suggested'
    const intent = input.intent ?? defaultIntentFor(source, userState)
    const hitCount = Math.max(0, Math.floor(input.hitCount ?? 0))
    const lastSeenAt = input.lastSeenAt ?? t
    const validAt = input.validAt ?? null
    const invalidAt = input.invalidAt ?? null
    const expiredAt = input.expiredAt ?? null
    const resolvedAt = input.resolvedAt ?? null
    const row: FactRow = {
      id: input.id ?? `f_${nextId()}`,
      type,
      content,
      source,
      userState,
      intent,
      weight: computeWeight({ intent, lambda: lambdaValue, lastSeenAt, now: t, validAt, invalidAt, expiredAt }),
      episodeId: input.episodeId ?? null,
      entityIds: input.entityIds ? JSON.stringify(input.entityIds) : null,
      valid_at: validAt,
      invalid_at: invalidAt,
      expired_at: expiredAt,
      resolvedAt,
      createdAt: input.createdAt ?? t,
      updatedAt: t,
      hitCount,
      lastSeenAt
    }
    upsertFact.run(row)
    return toFact(row)
  }

  /**
   * 合并强化：保留原行（id/createdAt），强化计数、取更高意图档内容。
   * 时间窗口：入站带窗口时整体覆盖旧窗口（新观察推进窗口；已过期事实由此
   * 复活）；入站无窗口时保留旧窗口。invalid_at 冲突仍走矛盾消解路径，不在
   * 合并里处理（selectActiveByType 已排除失效行）。
   */
  function mergeInto(existing: FactRow, input: FactInput, incomingIntent: IntentTier, t: number): FactRecord {
    const incomingWins = INTENT_TIER_WEIGHT[incomingIntent] > INTENT_TIER_WEIGHT[existing.intent]
    const content = incomingWins ? input.content.trim() : existing.content
    const source = incomingWins ? input.source : existing.source
    const intent = incomingWins ? incomingIntent : existing.intent
    const userState =
      existing.userState === 'banned'
        ? 'banned'
        : existing.userState === 'suggested' && (input.userState ?? 'suggested') === 'confirmed'
          ? 'confirmed'
          : existing.userState
    const carriesWindow = input.validAt !== undefined || input.expiredAt !== undefined
    const validAt = carriesWindow ? (input.validAt ?? null) : existing.valid_at
    const expiredAt = carriesWindow ? (input.expiredAt ?? null) : existing.expired_at
    const hitCount = existing.hitCount + 1
    const lastSeenAt = t
    updateFactMerge.run({
      id: existing.id,
      content,
      source,
      userState,
      intent,
      hitCount,
      lastSeenAt,
      valid_at: validAt,
      expired_at: expiredAt,
      weight: weightFor({ intent, hitCount, lastSeenAt, validAt, invalidAt: existing.invalid_at, expiredAt }),
      updatedAt: t
    })
    log({ kind: 'memory-graph', action: 'merge', factId: existing.id, content, hitCount })
    return toFact(selectFactById.get(existing.id) as FactRow)
  }

  function addFact(input: FactInput): FactRecord | null {
    const content = input.content.trim()
    const type = input.type.trim()
    if (!content || !type) return null
    const t = now()
    const source = input.source
    const userState = input.userState ?? 'suggested'
    const intent = input.intent ?? defaultIntentFor(source, userState)
    const active = selectActiveByType.all(type) as FactRow[]
    const normalized = normalizeContent(content)
    const sk = subjectKey(content)

    // ① 归一化键去重：同 (type, 归一化 content) 且未失效 → 合并强化。
    const exact = active.find((f) => normalizeContent(f.content) === normalized)
    if (exact) return mergeInto(exact, input, intent, t)

    // ② 余弦 ≥0.6 语义去重：同主语键但内容不同的对子（矛盾候补）不并入合并。
    const near = active.find((f) => {
      if (subjectKey(f.content) === sk && normalizeContent(f.content) !== normalized) return false
      return cosineSimilarity(f.content, content) >= DEDUP_COSINE_THRESHOLD
    })
    if (near) return mergeInto(near, input, intent, t)

    // ③ 矛盾消解：入站带时间窗口（无窗口的入站没有时间有效性主张，不触发）
    //    + 同 (type, 主语键) 未失效旧事实（旧事实在入站窗口起点仍有效；旧事实
    //    valid_at 空视为恒有效 -∞）→ 旧事实写 invalid_at，绝不覆盖/删除。
    const hasWindow = input.validAt !== undefined || input.expiredAt !== undefined
    if (hasWindow) {
      const windowStart = input.validAt ?? t
      const conflicted = active.find(
        (f) =>
          f.content !== content &&
          subjectKey(f.content) === sk &&
          (f.valid_at === null || f.valid_at <= windowStart) &&
          (f.expired_at === null || f.expired_at > windowStart)
      )
      if (conflicted) {
        updateFactInvalidate.run({ invalid_at: windowStart, weight: 0, updatedAt: t, id: conflicted.id })
        log({ kind: 'memory-graph', action: 'invalidate', factId: conflicted.id, at: windowStart })
      }
    }

    // ④ 新行插入（f_ 前缀，与面板 legacy 的 m_ 前缀区分）。
    const hitCount = Math.max(0, Math.floor(input.hitCount ?? 0))
    const lastSeenAt = input.lastSeenAt ?? t
    const validAt = input.validAt ?? null
    const invalidAt = input.invalidAt ?? null
    const expiredAt = input.expiredAt ?? null
    const row: FactRow = {
      id: `f_${nextId()}`,
      type,
      content,
      source,
      userState,
      intent,
      weight: computeWeight({ intent, lambda: lambdaValue, lastSeenAt, now: t, validAt, invalidAt, expiredAt }),
      episodeId: input.episodeId ?? null,
      entityIds: input.entities
        ? JSON.stringify(input.entities.map((e) => ensureEntity(e.name, e.type)).filter(Boolean))
        : input.entityIds
          ? JSON.stringify(input.entityIds)
          : null,
      valid_at: validAt,
      invalid_at: invalidAt,
      expired_at: expiredAt,
      resolvedAt: null,
      createdAt: t,
      updatedAt: t,
      hitCount,
      lastSeenAt
    }
    insertFact.run(row)
    log({ kind: 'memory-graph', action: 'add', factId: row.id, type, content, source, userState, intent, weight: row.weight })
    return toFact(row)
  }

  /** 用户状态转换（与 MemoryStore 规则一致）；confirm 顺带强化并升意图档。 */
  function updateFactState(id: string, userState: FactUserState): boolean {
    const row = selectFactById.get(id) as FactRow | undefined
    if (!row) return false
    const valid =
      (userState === 'confirmed' && row.userState === 'suggested') ||
      (userState === 'ignored' && (row.userState === 'suggested' || row.userState === 'banned')) ||
      (userState === 'banned' && row.userState !== 'banned')
    if (!valid) return false
    const t = now()
    const confirming = userState === 'confirmed'
    const intent = confirming
      ? INTENT_TIER_WEIGHT[row.intent] >= INTENT_TIER_WEIGHT[defaultIntentFor(row.source, 'confirmed')]
        ? row.intent
        : defaultIntentFor(row.source, 'confirmed')
      : row.intent
    const hitCount = confirming ? row.hitCount + 1 : row.hitCount
    const lastSeenAt = confirming ? t : row.lastSeenAt ?? row.createdAt
    updateFactStateStmt.run({
      id,
      userState,
      intent,
      hitCount,
      lastSeenAt,
      weight: weightFor({ intent, hitCount, lastSeenAt, validAt: row.valid_at, invalidAt: row.invalid_at, expiredAt: row.expired_at }),
      updatedAt: t
    })
    log({ kind: 'memory-graph', action: 'state', factId: id, userState })
    return true
  }

  /**
   * t51 面板冲突对：同 (type, 主语键) 的 (有效方, 被自动失效方) 对。只挑
   * 未裁决的被失效方（resolved_at 空 = 待面板裁决）；每侧按时间排序，
   * 每个被失效方对最早的有效方（自动消解时新行即替换者，v1 一主语一有效）。
   */
  function listConflicts(): ConflictPair[] {
    const all = listFacts({ includeInvalidated: true })
    const activeBySubject = new Map<string, FactRecord[]>()
    const invalidatedBySubject = new Map<string, FactRecord[]>()
    for (const f of all) {
      const key = `${f.type}\u0000${subjectKey(f.content)}`
      const bucket = f.invalidAt === null ? activeBySubject : invalidatedBySubject
      const list = bucket.get(key) ?? []
      list.push(f)
      bucket.set(key, list)
    }
    const pairs: ConflictPair[] = []
    for (const [key, invalidated] of invalidatedBySubject) {
      const active = (activeBySubject.get(key) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt)
      if (active.length === 0) continue
      const pending = invalidated
        .filter((f) => f.resolvedAt === null)
        .sort((a, b) => (a.invalidAt ?? 0) - (b.invalidAt ?? 0))
      for (const f of pending) pairs.push({ active: active[0]!, invalidated: f })
    }
    return pairs.sort((a, b) => (a.invalidated.invalidAt ?? 0) - (b.invalidated.invalidAt ?? 0))
  }

  /**
   * t51 用户裁决（spec 决策 10：不自动覆盖）。事务内整体生效：
   * keep-active → 只标记裁决（弃方 invalid_at 已由自动消解落库）；
   * keep-invalidated → 复活弃方（清 invalid_at、重算权重）并失效当前方；
   * keep-none → 双方失效。双方写 resolved_at，待审冲突退出面板。
   */
  function adjudicateConflict(activeId: string, invalidatedId: string, resolution: ConflictResolution): boolean {
    // 白名单守卫：IPC 边界可传任意字符串，非法值不落任何行（含 resolved_at）
    if (resolution !== 'keep-active' && resolution !== 'keep-invalidated' && resolution !== 'keep-none') return false
    const active = selectFactById.get(activeId) as FactRow | undefined
    const invalidated = selectFactById.get(invalidatedId) as FactRow | undefined
    if (!active || !invalidated) return false
    if (active.invalid_at !== null || invalidated.invalid_at === null) return false
    if (active.type !== invalidated.type || subjectKey(active.content) !== subjectKey(invalidated.content)) return false
    const t = now()
    return db.transaction(() => {
      if (resolution === 'keep-invalidated') {
        updateFactRestore.run({
          id: invalidatedId,
          weight: weightFor({
            intent: invalidated.intent,
            hitCount: invalidated.hitCount,
            lastSeenAt: invalidated.lastSeenAt ?? invalidated.createdAt,
            validAt: invalidated.valid_at,
            invalidAt: null,
            expiredAt: invalidated.expired_at
          }),
          updatedAt: t
        })
        updateFactInvalidate.run({ invalid_at: t, weight: 0, updatedAt: t, id: activeId })
      } else if (resolution === 'keep-none') {
        updateFactInvalidate.run({ invalid_at: t, weight: 0, updatedAt: t, id: activeId })
      }
      updateFactResolve.run({ resolvedAt: t, updatedAt: t, id: activeId })
      updateFactResolve.run({ resolvedAt: t, updatedAt: t, id: invalidatedId })
      log({ kind: 'memory-graph', action: 'adjudicate', activeId, invalidatedId, resolution })
      return true
    })()
  }

  function reinforceFact(id: string): boolean {
    const row = selectFactById.get(id) as FactRow | undefined
    if (!row || row.userState !== 'confirmed') return false
    const t = now()
    const hitCount = row.hitCount + 1
    updateFactReinforce.run({
      id,
      hitCount,
      lastSeenAt: t,
      weight: weightFor({ intent: row.intent, hitCount, lastSeenAt: t, validAt: row.valid_at, invalidAt: row.invalid_at, expiredAt: row.expired_at }),
      updatedAt: t
    })
    return true
  }

  function listFacts(query: FactQuery = {}): FactRecord[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (query.types && query.types.length > 0) {
      clauses.push(`type IN (${query.types.map(() => '?').join(', ')})`)
      params.push(...query.types)
    }
    if (query.userStates && query.userStates.length > 0) {
      clauses.push(`userState IN (${query.userStates.map(() => '?').join(', ')})`)
      params.push(...query.userStates)
    }
    if (!query.includeInvalidated) clauses.push('invalid_at IS NULL')
    if (query.validNow) {
      const t = now()
      clauses.push('(valid_at IS NULL OR valid_at <= ?)')
      params.push(t)
      clauses.push('(expired_at IS NULL OR expired_at > ?)')
      params.push(t)
    }
    if (query.episodeId) {
      clauses.push('episodeId = ?')
      params.push(query.episodeId)
    }
    let sql = `SELECT ${FACT_COLUMNS} FROM facts`
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
    sql += ' ORDER BY createdAt DESC, id'
    if (query.limit !== undefined && query.limit > 0) {
      sql += ' LIMIT ?'
      params.push(query.limit)
    }
    return (db.prepare(sql).all(...params) as FactRow[]).map(toFact)
  }

  function searchFacts(query: string, opts: FactQuery = {}): FactRecord[] {
    const match = toFtsQuery(query)
    if (!match) return []
    const clauses: string[] = ['facts_fts MATCH ?']
    const params: unknown[] = [match]
    if (opts.types && opts.types.length > 0) {
      clauses.push(`f.type IN (${opts.types.map(() => '?').join(', ')})`)
      params.push(...opts.types)
    }
    if (opts.userStates && opts.userStates.length > 0) {
      clauses.push(`f.userState IN (${opts.userStates.map(() => '?').join(', ')})`)
      params.push(...opts.userStates)
    }
    if (!opts.includeInvalidated) clauses.push('f.invalid_at IS NULL')
    if (opts.validNow) {
      const t = now()
      clauses.push('(f.valid_at IS NULL OR f.valid_at <= ?)')
      params.push(t)
      clauses.push('(f.expired_at IS NULL OR f.expired_at > ?)')
      params.push(t)
    }
    if (opts.episodeId) {
      clauses.push('f.episodeId = ?')
      params.push(opts.episodeId)
    }
    let sql = `SELECT f.id, f.type, f.content, f.source, f.userState, f.intent, f.weight, f.episodeId, f.entityIds, f.valid_at, f.invalid_at, f.expired_at, f.resolvedAt, f.createdAt, f.updatedAt, f.hitCount, f.lastSeenAt
               FROM facts_fts JOIN facts f ON f.id = facts_fts.id WHERE ${clauses.join(' AND ')} ORDER BY facts_fts.rank`
    if (opts.limit !== undefined && opts.limit > 0) {
      sql += ' LIMIT ?'
      params.push(opts.limit)
    }
    return (db.prepare(sql).all(...params) as FactRow[]).map(toFact)
  }

  function countFacts(query: FactQuery = {}): number {
    const clauses: string[] = []
    const params: unknown[] = []
    if (query.types && query.types.length > 0) {
      clauses.push(`type IN (${query.types.map(() => '?').join(', ')})`)
      params.push(...query.types)
    }
    if (query.userStates && query.userStates.length > 0) {
      clauses.push(`userState IN (${query.userStates.map(() => '?').join(', ')})`)
      params.push(...query.userStates)
    }
    if (!query.includeInvalidated) clauses.push('invalid_at IS NULL')
    if (query.validNow) {
      const t = now()
      clauses.push('(valid_at IS NULL OR valid_at <= ?)')
      params.push(t)
      clauses.push('(expired_at IS NULL OR expired_at > ?)')
      params.push(t)
    }
    let sql = `SELECT count(*) AS n FROM facts`
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
    const row = db.prepare(sql).get(...params) as { n: number }
    return Number(row.n)
  }

  /** t50 确定性检索：候选（validNow）→ 四要素种子 → 扩散（钳制 hop）→ 权重 × 时间排序。 */
  function retrieveMemories(query: MemoryRetrievalQuery = {}): MemoryRetrievalResult {
    const candidates = listFacts({
      types: query.types,
      userStates: query.userStates && query.userStates.length > 0 ? query.userStates : DEFAULT_RETRIEVAL_USER_STATES,
      validNow: true
    })
    const maxHops = clampMaxHops(query.maxHops)
    const entityRows = selectAllEntities.all() as EntityRow[]
    const entityNameById = new Map(entityRows.map((e) => [e.id, e.name]))
    const entityIds = new Set<string>(query.entityIds ?? [])
    for (const raw of query.entityNames ?? []) {
      const normalized = normalizeContent(raw)
      if (!normalized) continue
      for (const row of entityRows) {
        if (normalizeContent(row.name) === normalized) entityIds.add(row.id)
      }
    }
    const ctx: SeedMatchContext = {
      // 组装处归一化一次（seedReasonsFor 信任已归一化键）。
      activityKeys: (query.activityKeys ?? []).map(normalizeContent),
      entityIds,
      entityNameById,
      windowStart: query.windowStart ?? null,
      windowEnd: query.windowEnd ?? null,
      episodeId: query.episodeId ?? null
    }
    const seeds: Array<{ fact: FactRecord; reasons: HitReason[] }> = []
    for (const fact of candidates) {
      const reasons = seedReasonsFor(fact, ctx)
      if (reasons.length > 0) seeds.push({ fact, reasons })
    }
    // 不内置截断：审计链需要全量命中（recordMemoryRecall 记完整召回原因），
    // 消费端（预填组装 t55/56）自行 slice 取用。
    const hits = rankHits(diffuseHits(candidates, seeds, maxHops), now(), lambdaValue)
    return { hits, maxHops, seedCount: seeds.length }
  }

  // 原子性：整体单事务。中途失败整体回滚（不会留下部分写入），
  // 迁移续跑以 countFacts(legacy) > 0 判定"已完成"才成立（见 state.ts）。
  const ingestTx = db.transaction((memories: readonly Memory[]): number => {
    let inserted = 0
    for (const m of memories) {
      const ok = putFact({
        id: m.id,
        type: m.type,
        content: m.content,
        source: m.source,
        userState: m.userState,
        hitCount: m.hitCount,
        lastSeenAt: m.lastSeenAt,
        createdAt: m.createdAt,
        intent: defaultIntentFor(m.source, m.userState)
      })
      if (ok) inserted++
    }
    return inserted
  })

  /** 公开 API 薄封装：迁移/续跑语义在事务上，单次调用即完整迁移。 */
  function ingestLegacyMemories(memories: readonly Memory[]): number {
    return ingestTx(memories)
  }

  /** t49 整理批次：全部 episode 查询（按需过滤），startedAt 升序、同刻按 createdAt。 */
  function listEpisodes(query: { sessionId?: string; pendingOnly?: boolean } = {}): EpisodeRecord[] {
    const rows = query.sessionId !== undefined
      ? (selectEpisodesBySession.all(query.sessionId) as EpisodeRow[])
      : query.pendingOnly
        ? (selectPendingEpisodes.all() as EpisodeRow[])
        : (selectEpisodes.all() as EpisodeRow[])
    return [...rows].sort((a, b) => a.startedAt - b.startedAt || a.createdAt - b.createdAt)
  }

  /** 整理完成标记：写入非空摘要即退出 pending（提取失败不会走到这里）。 */
  function markEpisodeConsolidated(id: string, summary: string): boolean {
    const s = summary.trim()
    if (!s) return false
    return updateEpisodeSummary.run(s, id).changes > 0
  }

  /** 事务内执行 fn（better-sqlite3 事务包装）：整体提交或整体回滚。 */
  function withTransaction<T>(fn: () => T): T {
    return db.transaction(fn)()
  }

  return {
    addEpisode: (input) => {
      const t = now()
      const row: EpisodeRow = {
        id: `ep_${nextId()}`,
        sessionId: input.sessionId ?? null,
        startedAt: input.startedAt ?? t,
        endedAt: input.endedAt ?? null,
        summary: input.summary ?? null,
        content: input.content,
        createdAt: t
      }
      insertEpisode.run(row)
      return row
    },
    closeEpisode: (id, endedAt) => updateEpisodeEnded.run(endedAt ?? now(), id).changes > 0,
    listEpisodes,
    markEpisodeConsolidated,
    withTransaction,
    ensureEntity,
    addFact,
    putFact,
    updateFactState,
    listConflicts,
    adjudicateConflict,
    reinforceFact,
    deleteFact: (id) => deleteFactStmt.run(id).changes > 0,
    getFact: (id) => {
      const row = selectFactById.get(id) as FactRow | undefined
      return row ? toFact(row) : undefined
    },
    listFacts,
    searchFacts,
    countFacts,
    retrieveMemories,
    ingestLegacyMemories,
    setLambda: (value) => {
      lambdaValue = clampLambda(value)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 面板适配器：MemoryStore 纯逻辑核心 + SQLite 持久化                   */
/* ------------------------------------------------------------------ */

/** MemoryIndex ↔ legacy facts 行（id 差异同步；只删除 m_ 前缀孤儿行）。时钟由图注入。 */
export function createMemoryIndexAdapter(graph: MemoryGraphStore): MemoryIndexAdapter {
  return {
    load(): MemoryIndex | null {
      const facts = graph.listFacts({ types: LEGACY_MEMORY_TYPES, includeInvalidated: false })
      return {
        version: STORAGE_VERSION,
        memories: facts.map((f) => ({
          id: f.id,
          type: f.type as MemoryType,
          content: f.content,
          // 落库快照语义（与 MemoryStore 持久化一致）：sat(hitCount) 为变更时刻值，
          // 读取时 MemoryStore 会用 effectiveConfidence 重新计算时间感知值。
          confidence: saturation(f.hitCount),
          hitCount: f.hitCount,
          lastSeenAt: f.lastSeenAt,
          createdAt: f.createdAt,
          source: f.source as Memory['source'],
          userState: f.userState
        }))
      }
    },
    save(index: MemoryIndex): void {
      const existing = new Map(
        graph.listFacts({ types: LEGACY_MEMORY_TYPES, includeInvalidated: true }).map((f) => [f.id, f])
      )
      const keep = new Set<string>()
      for (const m of index.memories) {
        keep.add(m.id)
        graph.putFact({
          id: m.id,
          type: m.type,
          content: m.content,
          source: m.source,
          userState: m.userState,
          hitCount: m.hitCount,
          lastSeenAt: m.lastSeenAt,
          createdAt: m.createdAt,
          intent: defaultIntentFor(m.source, m.userState)
        })
      }
      // 只清理 m_ 前缀（适配器自己写的行）；图侧事实（f_ 等）不受影响。
      for (const id of existing.keys()) {
        if (id.startsWith('m_') && !keep.has(id)) graph.deleteFact(id)
      }
    }
  }
}
