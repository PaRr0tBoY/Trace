/**
 * 决策者实现（t55，spec 实现决策 5/6）—— 同一接口（TaskDecisionProvider）
 * 的三个实现，控制器不感知谁在做；外层可替换。
 *
 *   algorithm  纯算法（确定性、零 LLM）：归属候选 → switch / continue；
 *              新语义簇 → new 提案。无 AI 配置 / 失败时的兜底（不变量：
 *              AI 是增强不是依赖）。
 *   agent      最小一次性决策（spec 决策 6 雏形）：最小预填 → ChatFn →
 *              JSON schema 校验 → TaskDecision；失败降级算法决策。预填
 *              隐私门 / 工具升级路径（≤3 次工具调用）属 t56 扩展。
 *   local-model  本地模型决策包装：先经 CandidateActivity 优化器（过滤
 *              ≤3 / 标题草稿 / 排序），再交内层决策者；优化器失败或关闭
 *              → 算法候选原样传递（不变量 H：绝不污染决策数据）。
 *
 * 纯逻辑：零 Electron import；chat / optimizer 注入，vitest 直测。
 */
import type { ChatRequest, ChatResult, JsonSchemaObject } from '../main/provider'
import type { CandidateOptimizer } from './localModelOptimizer'
import type { CandidateActivity } from '../../shared/types'
import type { DecisionContext, TaskCandidate, TaskDecision, TaskDecisionProvider } from './currentTaskController'
import { algorithmicTitle } from '../../shared/titles'

/** 决策请求的 JSON schema（与 TaskDecision 判别联合同构，spec 决策 6）。 */
export const DECISION_REPLY_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['continue', 'switch', 'new', 'merge', 'ignore'] },
    taskId: { type: 'string' },
    fromTaskId: { type: 'string' },
    toTaskId: { type: 'string' },
    title: { type: 'string' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    apps: { type: 'array', items: { type: 'string' } }
  },
  required: ['action']
}

function sanitizeString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function sanitizeNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined
}

function sanitizeStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * 客户端校验：模型回复 → TaskDecision（判别联合字段齐全才接受；否则 null
 * 由调用方降级）。struct 校验失败绝不让坏数据流进状态机。
 */
export function parseTaskDecision(parsed: unknown): TaskDecision | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  const action = sanitizeString(raw.action)
  const reason = sanitizeString(raw.reason) || 'algorithm decision'
  const confidence = sanitizeNumber(raw.confidence)
  switch (action) {
    case 'continue': {
      const taskId = sanitizeString(raw.taskId)
      if (!taskId || confidence === undefined) return null
      return { action, taskId, confidence, reason }
    }
    case 'switch': {
      const toTaskId = sanitizeString(raw.toTaskId)
      if (!toTaskId || confidence === undefined) return null
      return {
        action,
        fromTaskId: sanitizeString(raw.fromTaskId),
        toTaskId,
        confidence,
        reason,
        evidence: sanitizeStringList(raw.evidence)
      }
    }
    case 'new': {
      const title = sanitizeString(raw.title)
      if (!title || confidence === undefined) return null
      return { action, title, confidence, reason, apps: sanitizeStringList(raw.apps), evidence: sanitizeStringList(raw.evidence) }
    }
    case 'merge': {
      const toTaskId = sanitizeString(raw.toTaskId)
      if (!toTaskId || confidence === undefined) return null
      return { action, fromTaskId: sanitizeString(raw.fromTaskId), toTaskId, confidence, reason }
    }
    case 'ignore':
      return { action, reason }
    default:
      return null
  }
}

/** 纯算法决策者：确定性规则，零 LLM（无 AI 配置时的兜底路径）。 */
export function createAlgorithmDecisionProvider(): TaskDecisionProvider {
  return {
    id: 'algorithm',
    async evaluateTaskContext(ctx: DecisionContext): Promise<TaskDecision> {
      const best = ctx.candidates[0]
      if (!best) {
        // 新语义簇：无归属候选 → new 提案（标题走算法兜底，归因全由算法）。
        const apps = ctx.activity.apps.map((a) => a.name)
        return {
          action: 'new',
          title: algorithmicTitle(apps),
          confidence: ctx.detail.confidence,
          reason: 'new semantic cluster with no attributed task',
          apps,
          evidence: [...ctx.detail.windowTitles.slice(0, 3), ctx.detail.evidence.appCombination],
          decidedBy: 'algorithm'
        }
      }
      if (ctx.currentTask && best.taskId === ctx.currentTask.id) {
        return {
          action: 'continue',
          taskId: best.taskId,
          confidence: best.confidence,
          reason: 'attribution unchanged',
          decidedBy: 'algorithm'
        }
      }
      return {
        action: 'switch',
        fromTaskId: ctx.currentTask?.id ?? '',
        toTaskId: best.taskId,
        confidence: best.confidence,
        reason: 'candidate ahead of current task',
        evidence: best.evidence,
        decidedBy: 'algorithm'
      }
    }
  }
}

export interface AgentDecisionProviderOptions {
  /**
   * Provider 链聊天入口（惰性取值：main 的 setSuggestionChat 可能在控制器
   * 首次构造后才注入；调用时取，null = 无 AI，走算法兜底）。
   */
  getChat: () => ((req: ChatRequest) => Promise<ChatResult>) | null
  /** 失败 / 未配置时的兜底决策者（缺省 = 算法）。 */
  fallback?: TaskDecisionProvider
  /** 决策请求超时（ms）。 */
  timeoutMs?: number
}

function buildDecisionRequest(ctx: DecisionContext, timeoutMs: number): ChatRequest {
  const running = ctx.currentTask
  const candidateLine = ctx.candidates
    .map((c, i) => `${i + 1}. task "${c.title}" (id ${c.taskId}), confidence ${c.confidence.toFixed(2)}, zone ${c.zone}`)
    .join('\n')
  const memoryLine = ctx.matchedMemories
    .map((m) => `- "${m.content}" (${m.reasons.join(', ')}, ${m.hops} hop(s))`)
    .join('\n')
  const system =
    'You decide which task the user is currently working on. ' +
    'Reply with a single JSON object matching one of: ' +
    '{"action":"continue","taskId":string,"confidence":0-1,"reason":string}, ' +
    '{"action":"switch","fromTaskId":string,"toTaskId":string,"confidence":0-1,"reason":string,"evidence":string[]}, ' +
    '{"action":"new","title":string,"confidence":0-1,"reason":string,"apps":string[],"evidence":string[]}, ' +
    '{"action":"merge","fromTaskId":string,"toTaskId":string,"confidence":0-1,"reason":string}, ' +
    '{"action":"ignore","reason":string}. ' +
    'Prefer continue when the evidence is consistent with the current task.'
  const user = [
    `Now: ${ctx.now}`,
    `Current task: ${running ? `"${running.title}" (id ${running.id}, status ${running.status})` : 'none'}`,
    `Current session: ${ctx.currentSession ? `started ${ctx.currentSession.startedAt}` : 'none'}`,
    `Activity: apps ${ctx.activity.apps.map((a) => `${a.name}(${a.durationMs}ms)`).join(', ')}, ` +
      `titles ${ctx.detail.windowTitles.slice(0, 3).join(' | ') || '—'}, confidence ${ctx.detail.confidence.toFixed(2)}, zone ${ctx.detail.zone}`,
    `Candidates:\n${candidateLine || 'none'}`,
    `Matched memories:\n${memoryLine || 'none'}`,
    `Profile: ${ctx.profile.occupation ?? ''} ${ctx.profile.bio ?? ''}`.trim() || 'none'
  ].join('\n')
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    schema: DECISION_REPLY_SCHEMA,
    maxTokens: 300,
    timeoutMs
  }
}

/**
 * 最小 Agent 决策者（spec 决策 6 主路径雏形）：最小预填 → 一次 JSON 决策；
 * 失败 / 未配置 / 校验不过 → 算法兜底（不变量：AI 是增强不是依赖）。
 * t56 在此之上扩展预填隐私门与工具升级路径。
 */
export function createAgentDecisionProvider(options: AgentDecisionProviderOptions): TaskDecisionProvider {
  const fallback = options.fallback ?? createAlgorithmDecisionProvider()
  const timeoutMs = options.timeoutMs ?? 20_000
  return {
    id: 'agent',
    async evaluateTaskContext(ctx: DecisionContext): Promise<TaskDecision> {
      const chat = options.getChat()
      if (!chat) return fallback.evaluateTaskContext(ctx)
      try {
        const result = await chat(buildDecisionRequest(ctx, timeoutMs))
        if (!result.ok || result.parsed === undefined) return fallback.evaluateTaskContext(ctx)
        const decision = parseTaskDecision(result.parsed)
        // LLM 实际裁决 → 盖章 agent；解析失败走兜底（兜底自带 decidedBy）。
        return decision ? { ...decision, decidedBy: 'agent' } : fallback.evaluateTaskContext(ctx)
      } catch {
        return fallback.evaluateTaskContext(ctx)
      }
    }
  }
}

export interface LocalModelDecisionProviderOptions {
  /** 内层决策者（生产 = agent 或算法）。 */
  inner: TaskDecisionProvider
  /** CandidateActivity 优化器（t54）；null = 本地模型关闭，纯内层路径。 */
  optimizer: CandidateOptimizer | null
}

/** 把候选从 DecisionContext 映射为 CandidateActivity（优化器输入形状）。 */
export function toCandidateActivities(candidates: readonly TaskCandidate[]): CandidateActivity[] {
  return candidates.map((c) => ({
    activityId: c.taskId,
    candidateTaskId: c.taskId,
    semanticLabel: c.title,
    score: c.confidence,
    evidenceRefs: c.evidence
  }))
}

/**
 * 本地模型决策包装：候选先经优化器（过滤 ≤3 / 标题草稿 / 排序），再交内层
 * 决策者；优化器返回 null（关闭 / 失败 / 空回复）→ 算法候选原样传递（不变
 * 量 H：功能等价，绝不污染决策数据）。
 */
export function createLocalModelDecisionProvider(options: LocalModelDecisionProviderOptions): TaskDecisionProvider {
  return {
    id: 'local-model',
    async evaluateTaskContext(ctx: DecisionContext): Promise<TaskDecision> {
      if (!options.optimizer) return options.inner.evaluateTaskContext(ctx)
      const original = ctx.candidates
      try {
        const optimized = await options.optimizer.optimize(toCandidateActivities(original))
        if (optimized === null || optimized.length === 0) {
          // 降级：算法候选原样（不变量 H）。
          return options.inner.evaluateTaskContext(ctx)
        }
        // 按优化器回复顺序回填（rerank 信号）——绝不能丢排序只保子集。
        const origById = new Map(original.map((c) => [c.taskId, c]))
        const next: TaskCandidate[] = optimized
          .map((o) => {
            const c = origById.get(o.activityId)
            if (!c) return null
            return {
              ...c,
              title: o.semanticLabel && o.semanticLabel.trim().length > 0 ? o.semanticLabel.trim() : c.title,
              evidence: o.evidenceRefs.length > 0 ? o.evidenceRefs : c.evidence
            }
          })
          .filter((c): c is TaskCandidate => c !== null)
        if (next.length === 0) {
          // 优化器把候选全部过滤掉 → 与空回复同义：算法候选原样（不变量 H）。
          return options.inner.evaluateTaskContext(ctx)
        }
        const innerDecision = await options.inner.evaluateTaskContext({ ...ctx, candidates: next })
        // 优化器实际介入（过滤/标题/排序）→ 盖章本地模型；否则透传内层 id。
        return { ...innerDecision, decidedBy: 'local-model' }
      } catch {
        return options.inner.evaluateTaskContext(ctx)
      }
    }
  }
}
