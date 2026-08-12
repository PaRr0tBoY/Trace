/**
 * Episode consolidator (t49, spec 实现决策 10) — 自动提炼事实的整理流程。
 *
 * 新活动原始落库为 episode（免费，无 LLM）→ 三种触发（会话结束 / 时段边界
 * 早 6-12 中 12-18 晚 18-6 / 6h 兜底）→ 整批 combined extraction（节点边提取
 * 一次 + 批量时间戳一次，≤2 次 LLM 调用）→ 经 memoryGraph 的确定性去重 / 矛盾
 * 消解入库（addFact 复用 t48 的合并/失效语义）→ markEpisodeConsolidated 标记
 * 完成。提取失败静默降级：不抛、不阻塞、无部分写入（episode 保持 pending，
 * 下一触发自然重试）。
 *
 * Pure logic: no Electron imports（硬约束）。时钟、图、会话来源、任务标题、
 * 证据材料与提取器全部注入，vitest 直测。ChatFn 适配器（createChatEpisode
 * Extractor）只做类型引用 provider.ts（该模块同样零 Electron），运行时无依赖。
 *
 * Episode = 一个已闭合的原始材料窗口：会话结束时按 [段起点, endedAt] 创建；
 * 时段边界把进行中的会话切成 [段起点, 边界]；6h 兜底切成 [段起点, 起点+6h]。
 * 进行中会话的当前段起点在进程内跟踪（segments），重启后降级为整段（最后
 * episode 的 endedAt 续段），不会重复建段。
 *
 * 触发语义（run() 每次调用重新判定，无触发则不花任何 LLM 调用）：
 *   - session-end：本轮同步出新的已结束会话 episode，或本轮切出新 chunk；
 *   - boundary：本地时段键变化（跨过 6/12/18 整点）；
 *   - fallback：某开段运行满 6h。
 */
import type { ChatRequest, ChatResult, JsonSchemaObject } from '../main/provider'
import type { EpisodeRecord, FactInput, FactType, MemoryGraphStore } from './memoryGraph'
import type { TaskSession } from '../../shared/types'

/** 时段边界小时（本地时区）：早 6-12 / 中 12-18 / 晚 18-6。 */
export const PERIOD_BOUNDARIES = [6, 12, 18] as const
/** 6h 兜底：开段运行满 6 小时即切段整理（覆盖 18:00→06:00 的长夜窗口）。 */
export const FALLBACK_MS = 6 * 60 * 60 * 1000

/** 证据时间线的最小切片（state.ts 胶水把 EvidenceEvent 投影成这个）。 */
export interface EvidenceMaterial {
  source: string
  windowTitle?: string
}

/** 一次 combined extraction 的批内事实（节点/边提取的输出，契约）。 */
export interface ExtractedFact {
  /** 批内稳定 id：时间戳回填的匹配键（不是 DB 行 id）。 */
  id: string
  /** 来源 episode id（必须在批次中）——来源链 episode → fact 的锚点。 */
  episodeId: string
  type: FactType
  content: string
  /** 实体节点（graph.ensureEntity 自动按 (name, type) 建/复用）。 */
  entities?: Array<{ name: string; type: string }>
}

/** 批量时间戳一次的输出（第二次调用）：按批内 fact id 回填时间窗口。 */
export interface FactTimestamp {
  factId: string
  validAt: number | null
  expiredAt: number | null
}

/** 提取器契约（可注入计数断言；null = AI 不可用 → 整批跳过）。 */
export interface EpisodeExtractor {
  /** 第 1 次调用：整批节点与边提取。抛出 / 非 ok → 整理跳过（无写入）。 */
  extractNodesAndEdges(episodes: EpisodeRecord[]): Promise<{ facts: ExtractedFact[] }>
  /** 第 2 次调用：整批时间戳。抛出 → 已提取的事实仍不落库（无部分写入）。 */
  extractTimestamps(facts: ExtractedFact[]): Promise<FactTimestamp[]>
}

/** 整理批次结果。 */
export interface ConsolidationResult {
  /** 本轮新增 episode（已结束会话的原始落库 + 切段）。 */
  synced: number
  /** 命中的触发（session-end / boundary / fallback，可多个；空 = 无事可做）。 */
  triggers: string[]
  /** 本批 episode 数。 */
  batch: number
  /** 去重/矛盾消解后实际入库的事实数。 */
  factsWritten: number
  /** 提取失败：无任何写入，episode 保持 pending（下轮触发重试）。 */
  failed: boolean
}

export interface EpisodeConsolidatorOptions {
  now: () => number
  graph: Pick<
    MemoryGraphStore,
    'addEpisode' | 'addFact' | 'listEpisodes' | 'markEpisodeConsolidated' | 'withTransaction'
  >
  /** 会话持久来源（state.ts 接线：taskStore DTO 的 sessions 扁平化）。 */
  readSessions: () => TaskSession[]
  /** 任务标题解析（episode 原始材料的一部分）。 */
  taskTitle: (taskId: string) => string
  /** 证据时间线读取（L0 元数据：应用/窗口，无剪贴板正文）。可选。 */
  readEvidence?: (from: number, to: number) => EvidenceMaterial[]
  /** 提取器工厂：每次 run 时求值（AI 开关运行时变化；null = 跳过提取）。 */
  getExtractor: () => EpisodeExtractor | null
  /** 可观测性（ai-log.jsonl）。 */
  log?: (entry: Record<string, unknown>) => void
}

export interface EpisodeConsolidator {
  /** 周期入口：同步已结束会话 → 三触发判定 → 整批整理（无触发零 LLM 调用）。 */
  run(): Promise<ConsolidationResult>
}

/** 本地时区时段键：key 唯一标识当前时段（下一边界）；at 是该边界时刻（切段用）。 */
function periodKey(t: number): { key: string; at: number } {
  const d = new Date(t)
  const h = d.getHours()
  const y = d.getFullYear()
  const m = d.getMonth()
  const day = d.getDate()
  const next = PERIOD_BOUNDARIES.find((b) => h < b)
  if (next !== undefined) {
    return { key: `${next}:${new Date(y, m, day).getTime()}`, at: new Date(y, m, day, next).getTime() }
  }
  // h >= 18：晚时段（18:00 → 次日 6:00）。
  return { key: `6:${new Date(y, m, day + 1).getTime()}`, at: new Date(y, m, day + 1, 6).getTime() }
}

export function createEpisodeConsolidator(options: EpisodeConsolidatorOptions): EpisodeConsolidator {
  const { now, graph, readSessions, taskTitle, getExtractor } = options
  const readEvidence = options.readEvidence ?? (() => [])
  const log = options.log ?? (() => {})

  /** 进行中会话的当前开段起点（sessionId → 段起点）。进程内跟踪。 */
  const segments = new Map<string, number>()
  /** 上一轮时段键（null = 本轮首次运行：不做边界切分）。 */
  let lastPeriod: { key: string; at: number } | null = null

  /** L0 证据材料 → 去重后的"使用 app（窗口）× N"行（有界）。 */
  function evidenceLines(from: number, to: number): string[] {
    const counts = new Map<string, { source: string; window: string; n: number }>()
    for (const ev of readEvidence(from, to)) {
      const key = `${ev.source}\u0000${ev.windowTitle ?? ''}`
      const cur = counts.get(key)
      if (cur) cur.n++
      else counts.set(key, { source: ev.source, window: ev.windowTitle ?? '', n: 1 })
    }
    return [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 20)
      .map((c) => (c.window ? `使用 ${c.source}（${c.window}）× ${c.n}` : `使用 ${c.source} × ${c.n}`))
  }

  /** episode 原始材料（确定性拼接，无 LLM）。 */
  function composeContent(session: TaskSession, from: number, to: number): string {
    const parts: string[] = []
    const title = taskTitle(session.taskId)
    parts.push(`任务：${title || '（未命名任务）'}`)
    parts.push(`时间：${new Date(from).toISOString()} 至 ${new Date(to).toISOString()}`)
    if (session.transitionReason) parts.push(`结束原因：${session.transitionReason}`)
    if (session.previousTaskId) {
      const prev = taskTitle(session.previousTaskId)
      if (prev) parts.push(`前一任务：${prev}`)
    }
    if (session.confidence > 0 && session.confidence <= 1) parts.push(`置信度：${session.confidence}`)
    const ev = evidenceLines(from, to)
    if (ev.length > 0) parts.push(...ev)
    return parts.join('\n')
  }

  function addChunk(session: TaskSession, from: number, to: number): void {
    if (to - from <= 0) return
    graph.addEpisode({ sessionId: session.id, startedAt: from, endedAt: to, content: composeContent(session, from, to) })
  }

  /**
   * 同步：已结束会话 → 闭合 episode（免费）。会话已全覆盖（最后 episode 的
   * endedAt ≥ 会话结束）则跳过——重启续跑不重复建段。返回新建数。
   */
  function syncEpisodes(): number {
    const all = graph.listEpisodes()
    const lastEndOf = new Map<string, number>()
    for (const ep of all) {
      if (!ep.sessionId) continue
      const end = ep.endedAt ?? ep.startedAt
      lastEndOf.set(ep.sessionId, Math.max(lastEndOf.get(ep.sessionId) ?? 0, end))
    }
    let created = 0
    for (const s of readSessions()) {
      if (s.endedAt === undefined) continue
      const covered = (lastEndOf.get(s.id) ?? -1) >= s.endedAt
      if (covered) {
        segments.delete(s.id)
        continue
      }
      const start = Math.max(segments.get(s.id) ?? (lastEndOf.get(s.id) ?? -1), s.startedAt)
      segments.delete(s.id)
      if (start < s.endedAt) {
        addChunk(s, start, s.endedAt)
        created++
      }
    }
    return created
  }

  /** 进行中会话的开段起点（进程内跟踪；重启后从最后 episode 的 endedAt 续段）。 */
  function seedOpenSegments(): void {
    const all = graph.listEpisodes()
    const lastEndOf = new Map<string, number>()
    for (const ep of all) {
      if (!ep.sessionId) continue
      lastEndOf.set(ep.sessionId, Math.max(lastEndOf.get(ep.sessionId) ?? 0, ep.endedAt ?? ep.startedAt))
    }
    for (const s of readSessions()) {
      if (s.endedAt !== undefined || segments.has(s.id)) continue
      segments.set(s.id, Math.max(lastEndOf.get(s.id) ?? s.startedAt, s.startedAt))
    }
  }

  /** 切段：把会话 s 的 [from, to] 落为闭合 episode，段起点推进到 to。 */
  function closeChunk(s: TaskSession, from: number, to: number): void {
    if (to - from <= 0) return
    addChunk(s, from, to)
    segments.set(s.id, to)
  }

  /**
   * 整批 combined extraction → 去重/矛盾消解入库 → 标记完成。
   * 提取任一步失败：不写任何事实、不标记 episode（pending 保持，静默降级，
   * 下一触发自然重试）。空提取（extractor 返回空数组）= 正常零产出：标记
   * 完成——prompt 明示空批次返回空数组，不标记会让每次触发重复花费 2 次
   * LLM 调用；"空"与"失败"刻意区分，失败才保留 pending 可重试。
   * 时间戳契约：extractor 未回填的窗口省略键（不传 null）——addFact 的
   * carriesWindow 恒 true 会把已合并旧事实的窗口清成 null（时间有效性放宽
   * 为恒成立）；省略键走保留旧窗口路径，矛盾消解只在带窗口主张时触发。
   */
  async function consolidate(pending: EpisodeRecord[], triggers: string[]): Promise<ConsolidationResult> {
    const extractor = getExtractor()
    if (extractor === null) {
      log({ kind: 'episode.consolidate', action: 'skip', reason: 'no extractor (AI unavailable)', pending: pending.length })
      return { synced: 0, triggers, batch: pending.length, factsWritten: 0, failed: false }
    }
    const batchIds = new Set(pending.map((e) => e.id))
    try {
      const { facts } = await extractor.extractNodesAndEdges(pending)
      if (facts.length === 0) {
        // 空提取：标记完成，不花第二次调用。
        for (const ep of pending) graph.markEpisodeConsolidated(ep.id, '无事实')
        log({ kind: 'episode.consolidate', action: 'done-empty', episodes: pending.length, triggers })
        return { synced: 0, triggers, batch: pending.length, factsWritten: 0, failed: false }
      }
      const timestamps = await extractor.extractTimestamps(facts)
      const tsById = new Map(timestamps.map((t) => [t.factId, t]))
      let factsWritten = 0
      let dropped = 0
      graph.withTransaction(() => {
        for (const f of facts) {
          // 来源链完整性：episodeId 必须在批次内，否则丢弃（不虚构来源）。
          if (!batchIds.has(f.episodeId)) {
            dropped++
            continue
          }
          const ts = tsById.get(f.id)
          const input: FactInput = {
            type: f.type,
            content: f.content,
            source: 'inferred',
            intent: 'raw-extract',
            episodeId: f.episodeId,
            entities: f.entities
          }
          if (ts !== undefined) {
            if (ts.validAt !== null) input.validAt = ts.validAt
            if (ts.expiredAt !== null) input.expiredAt = ts.expiredAt
          }
          const ok = graph.addFact(input)
          if (ok) factsWritten++
        }
        if (facts.length > 0 && factsWritten === 0) {
          throw new Error('all extracted facts dropped (no valid episodeId)')
        }
        const summary = `提取 ${facts.length} 条事实`
        for (const ep of pending) graph.markEpisodeConsolidated(ep.id, summary)
      })
      log({
        kind: 'episode.consolidate',
        action: 'done',
        episodes: pending.length,
        extracted: facts.length,
        written: factsWritten,
        dropped,
        triggers
      })
      return { synced: 0, triggers, batch: pending.length, factsWritten, failed: false }
    } catch (err) {
      // 静默降级：不阻塞调用方；episode 保持 pending，下一触发重试。
      log({
        kind: 'episode.consolidate',
        action: 'failed',
        error: err instanceof Error ? err.message : String(err),
        pending: pending.length
      })
      return { synced: 0, triggers, batch: pending.length, factsWritten: 0, failed: true }
    }
  }

  /**
   * 周期入口（t49）。in-flight 保护：提取可能慢（provider 重试/网络），并发
   * 调用共享同一轮 run——绝不双倍 LLM 花费或对同批重复 addFact（hitCount
   * 虚增）。意外错误（DB 层等）也被捕获为失败结果，不抛进定时器。
   */
  let inflight: Promise<ConsolidationResult> | null = null
  function run(): Promise<ConsolidationResult> {
    if (inflight !== null) return inflight
    const p = (async (): Promise<ConsolidationResult> => {
      try {
        const synced = syncEpisodes()
        seedOpenSegments()
        const t = now()
        const triggers: string[] = []
        let chunksClosed = 0

        // 6h 兜底：长开段先切（边界未到也切）。
        for (const [sid, start] of segments) {
          if (t - start >= FALLBACK_MS) {
            const session = readSessions().find((s) => s.id === sid)
            if (session) closeChunk(session, start, start + FALLBACK_MS)
            else segments.delete(sid)
            chunksClosed++
            if (!triggers.includes('fallback')) triggers.push('fallback')
          }
        }

        // 时段边界：时段键变化 → 在上一边界时刻切所有更早的开段。
        const period = periodKey(t)
        if (lastPeriod !== null && period.key !== lastPeriod.key) {
          const boundary = lastPeriod.at
          for (const [sid, start] of segments) {
            if (start < boundary) {
              const session = readSessions().find((s) => s.id === sid)
              if (session) closeChunk(session, start, boundary)
              else segments.delete(sid)
              chunksClosed++
            }
          }
          if (!triggers.includes('boundary')) triggers.push('boundary')
        }
        lastPeriod = period

        // 会话结束：本轮新建了 episode（含切段）即触发。
        if (synced > 0 || chunksClosed > 0) {
          if (!triggers.includes('session-end')) triggers.push('session-end')
        }

        if (triggers.length === 0) {
          return { synced, triggers, batch: 0, factsWritten: 0, failed: false }
        }
        const pending = graph.listEpisodes({ pendingOnly: true })
        if (pending.length === 0) {
          return { synced, triggers, batch: 0, factsWritten: 0, failed: false }
        }
        const result = await consolidate(pending, triggers)
        return { ...result, synced }
      } catch (err) {
        log({
          kind: 'episode.consolidate',
          action: 'failed',
          error: err instanceof Error ? err.message : String(err)
        })
        return { synced: 0, triggers: [], batch: 0, factsWritten: 0, failed: true }
      }
    })()
    inflight = p
    p.finally(() => {
      if (inflight === p) inflight = null
    }).catch(() => {})
    return p
  }

  return { run }
}

/* ------------------------------------------------------------------ */
/* ChatFn 适配器：provider 链 → EpisodeExtractor（结构化输出两连调）      */
/* ------------------------------------------------------------------ */

/**
 * provider 链返回的 parsed 已在链内按对应 schema（NODES_EDGES_SCHEMA /
 * TIMESTAMPS_SCHEMA）校验通过（validateJsonSchema），此处只做契约型断言，
 * 不再重复运行时校验。
 */
interface NodesAndEdgesReply {
  facts: ExtractedFact[]
}

interface TimestampsReply {
  facts: Array<{ factId: string; validAt?: number; expiredAt?: number }>
}

const NODES_EDGES_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          episodeId: { type: 'string' },
          // 限定 8 个已知字面量：LLM 幻觉类型绝不落库（自由扩展留给非 LLM 路径）。
          type: {
            type: 'string',
            enum: ['identity', 'tool', 'project', 'workflow', 'profile', 'pattern', 'task', 'preference']
          },
          content: { type: 'string' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' }
              },
              required: ['name', 'type']
            }
          }
        },
        required: ['id', 'episodeId', 'type', 'content']
      }
    }
  },
  required: ['facts']
}

const TIMESTAMPS_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factId: { type: 'string' },
          validAt: { type: 'number' },
          expiredAt: { type: 'number' }
        },
        required: ['factId']
      }
    }
  },
  required: ['facts']
}

const NODES_EDGES_PROMPT = `你是 Trace 的长期记忆整理器。给定一批"时段"原始材料（每条是某段时间内一个任务会话的应用/窗口使用摘要），提炼可持续成立的事实（facts），供记忆图入库。

规则：
- 每条 fact 必须直接由某条 episode 的材料支持：episodeId 必须取批次里出现的 episode id。
- type 用：profile（画像/习惯）、pattern（工作模式）、task（任务相关）、preference（偏好）、project（项目状态）、tool（工具用法）。拿不准用 pattern。
- content 是完整、独立、可读的中文陈述句（主语 + 谓语），不要用 JSON 转义、不要缩写。
- 只提炼稳定、有长期价值的事实；时间点、时长、次数等临时信息不提炼。
- id 是批内唯一短标识（如 "f1"、"f2"），保持稳定。
- entities 列出事实涉及的人/应用/项目节点（name + type: person/app/project/tool）。没有可不给。
- 事实宁缺毋滥：空批次返回空数组。`

const TIMESTAMPS_PROMPT = `你是 Trace 的长期记忆整理器。上一步已从一批时段材料中提炼出事实。现在为每条事实判定时间有效性窗口（该事实在什么时间范围内成立）。

- 输入是事实列表（id + content + 来源 episode 的起止时间，随附于 content 或按 episode 推断）。
- 输出按批内事实 id 回填：validAt = 事实开始成立的时刻，expiredAt = 事实不再成立的时刻；两者都是 Unix 毫秒时间戳（数字）。
- 无法判定窗口的（长期成立，如身份/偏好/工作模式）→ 不输出该事实或两者都省略。
- 同一事实在两段时间都成立 → 输出最宽窗口。
- 只对输入里出现的 factId 回填，不要新增。`

/** provider 链（ChatFn）→ 提取器。每次 run 重建（无状态，纯闭包）。 */
export function createChatEpisodeExtractor(chat: (req: ChatRequest) => Promise<ChatResult>): EpisodeExtractor {
  return {
    async extractNodesAndEdges(episodes) {
      const result = await chat({
        messages: [
          { role: 'system', content: NODES_EDGES_PROMPT },
          {
            role: 'user',
            content: JSON.stringify(
              episodes.map((e) => ({ id: e.id, startedAt: e.startedAt, endedAt: e.endedAt, content: e.content }))
            )
          }
        ],
        schema: NODES_EDGES_SCHEMA,
        maxTokens: 2_000,
        timeoutMs: 30_000
      })
      if (!result.ok) throw new Error(result.error)
      return { facts: (result.parsed as NodesAndEdgesReply).facts }
    },
    async extractTimestamps(facts) {
      const result = await chat({
        messages: [
          { role: 'system', content: TIMESTAMPS_PROMPT },
          {
            role: 'user',
            content: JSON.stringify(facts.map((f) => ({ id: f.id, episodeId: f.episodeId, type: f.type, content: f.content })))
          }
        ],
        schema: TIMESTAMPS_SCHEMA,
        maxTokens: 1_000,
        timeoutMs: 30_000
      })
      if (!result.ok) throw new Error(result.error)
      return (result.parsed as TimestampsReply).facts.map((t) => ({
        factId: t.factId,
        validAt: t.validAt ?? null,
        expiredAt: t.expiredAt ?? null
      }))
    }
  }
}
