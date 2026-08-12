/**
 * 决策者实现（t55 + t56，spec 实现决策 5/6/7）—— 同一接口（TaskDecisionProvider）
 * 的三个实现，控制器不感知谁在做；外层可替换。
 *
 *   algorithm  纯算法（确定性、零 LLM）：归属候选 → switch / continue；
 *              新语义簇 → new 提案。无 AI 配置 / 失败时的兜底（不变量：
 *              AI 是增强不是依赖）。
 *   agent      一次性决策（spec 决策 6 主路径）：最小预填 → 预填隐私门
 *              （不变量 D：denied 应用 / 关闭开关 → AI 侧预填无该数据）→
 *              高不确定升级路径（≤3 次工具调用，四固定工具面，无
 *              getEverything 类工具；预算耗尽 / 失败 → 算法兜底）→ 一次
 *              JSON 决策。AI 总开关 / 时间窗关 → 整趟跳过 LLM 直接算法
 *              （算法层始终看完整 ctx，本地工作照常，spec story 33）。
 *   local-model  本地模型决策包装：先经 CandidateActivity 优化器（过滤
 *              ≤3 / 标题草稿 / 排序），再交内层决策者；优化器失败或关闭
 *              → 算法候选原样传递（不变量 H：绝不污染决策数据）。
 *
 * 另含（t56 迁入）：suggestTitle（ADR-0003 保存时自动标题；IPC 通道
 * task:suggest-title 与触发条件不变）+ matchMemories（上下文先验，引擎分析
 * 与标题建议共用）。
 *
 * 纯逻辑：零 Electron import；chat / 工具 / policy / trace 落点全部注入，
 * vitest 直测。
 */
import type { ChatRequest, ChatResult, JsonSchemaObject } from '../main/provider'
import type { CandidateOptimizer } from './localModelOptimizer'
import type { CandidateActivity, ContentType, ItemData, Memory } from '../../shared/types'
import type { SuggestTitleContext } from '../../shared/ipc'
import type { DecisionContext, TaskCandidate, TaskDecision, TaskDecisionProvider } from './currentTaskController'
import type { AiAccess, PrivacyPolicy } from './privacyGate'
import { aiAllowed, normalizeExePath } from './privacyGate'
import { algorithmicTitle } from '../../shared/titles'
import { createId } from './ids'

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

/* ------------------------------------------------------------------ */
/* 工具升级路径（spec 决策 6：低置信时 ≤3 次工具调用）                  */
/* ------------------------------------------------------------------ */

/** 工具面固定四个（升级路径全集）；无 getEverything 类工具（类型级约束）。 */
export const AGENT_TOOLS = ['search_tasks', 'search_memories', 'search_activities', 'search_clipboard'] as const
export type AgentToolName = (typeof AGENT_TOOLS)[number]

/** 工具调用总预算上限（spec 决策 6：≤3 次）。 */
export const TOOL_BUDGET_CAP = 3

/** 一次工具调用的产出：命中条数 + ≤200 字符预览（trace 与提示词共用）。 */
export interface AgentToolResult {
  count: number
  preview: string
}

/** 四固定工具面（生产 = state.ts 胶水组装；测试注入 fake）。 */
export interface AgentToolSet {
  searchTasks(query: string): Promise<AgentToolResult>
  searchMemories(query: string): Promise<AgentToolResult>
  searchActivities(query: string): Promise<AgentToolResult>
  searchClipboard(query: string): Promise<AgentToolResult>
}

/** 计划内的一次工具调用。 */
export interface AgentToolCall {
  tool: AgentToolName
  query: string
}

/** 进入决策提示词的工具结果行（拦截 / 失败也成行——预算照花，结果透明）。 */
export interface AgentToolLine {
  tool: AgentToolName
  query: string
  count: number
  preview: string
}

/** trace kind='recall' 落点（spec 决策 8：工具 / 查询 / 条数 / 预览 ≤200）。 */
export interface ToolRecall {
  decisionId: string
  tool: AgentToolName
  query: string
  count: number
  preview: string
}

/** trace kind='privacy' 落点（spec 决策 7：被拒数据绝不进 Agent）。 */
export interface PrefillPrivacyBlock {
  decisionId: string
  reason: string
  access: AiAccess
  appExePath?: string
}

/** 预算钳制 [0, TOOL_BUDGET_CAP]；0 = 禁用升级路径（纯预填决策，t55 行为）。 */
export function clampToolBudget(budget: number | undefined): number {
  if (budget === undefined) return TOOL_BUDGET_CAP
  return Math.max(0, Math.min(TOOL_BUDGET_CAP, Math.floor(budget)))
}

/** 活动键（app 名 + 窗口标题，去重去空）——工具查询的确定性关键词来源。 */
function activityKeys(ctx: DecisionContext): string[] {
  const keys: string[] = []
  for (const a of ctx.activity.apps) {
    keys.push(a.name)
    for (const w of a.windows) keys.push(w)
  }
  return [...new Set(keys.map((k) => k.trim()).filter((k) => k.length > 0))].slice(0, 6)
}

/**
 * 确定性工具计划（spec 决策 6 升级路径）：按场景顺序发起小查询，总调用数
 * ≤ budget（硬上限）。顺序固定（记忆最便宜优先、剪贴板最敏感最后），测试
 * 可断言。只返回四固定面内的小查询——不存在 getEverything 类工具。
 */
export function planToolCalls(ctx: DecisionContext, budget: number): AgentToolCall[] {
  const calls: AgentToolCall[] = []
  const keyword = activityKeys(ctx).slice(0, 3).join(' ')
  if (budget <= 0 || !keyword) return calls
  // 1. 记忆：预筛之外的补充检索（最便宜、最有判别力）。
  calls.push({ tool: 'search_memories', query: keyword })
  // 2. 场景分支：新主题 / 无候选 → 相似任务 + 近期活动；其余（竞争 / 常规
  //    低置信）→ 活动佐证。
  if (ctx.detail.zone === 'new' || ctx.candidates.length === 0) {
    calls.push({ tool: 'search_tasks', query: keyword })
    if (calls.length < budget) calls.push({ tool: 'search_activities', query: keyword })
  } else {
    calls.push({ tool: 'search_activities', query: keyword })
  }
  // 3. 剪贴板预览：仅当活动带剪贴板引用（按最后一条 itemId；最敏感，最后）。
  const lastClip = ctx.activity.clipboardRefs[ctx.activity.clipboardRefs.length - 1]
  if (lastClip && calls.length < budget) calls.push({ tool: 'search_clipboard', query: lastClip })
  return calls.slice(0, budget)
}

/**
 * 高不确定判定（spec 决策 6 升级路径触发）：新语义簇 / 无候选 / 置信跌破
 * 低阈值 / 多任务竞争。缺省阈值 = 设置缺省 confidenceLow（0.45）。
 */
export function shouldUpgradeToTools(ctx: DecisionContext, confidenceLow: number): boolean {
  return (
    ctx.detail.zone === 'new' ||
    ctx.candidates.length === 0 ||
    ctx.detail.confidence < confidenceLow ||
    ctx.detail.evidence.overlappingTasks.length >= 2
  )
}

async function runTool(tools: AgentToolSet, call: AgentToolCall): Promise<AgentToolResult> {
  switch (call.tool) {
    case 'search_tasks':
      return tools.searchTasks(call.query)
    case 'search_memories':
      return tools.searchMemories(call.query)
    case 'search_activities':
      return tools.searchActivities(call.query)
    case 'search_clipboard':
      return tools.searchClipboard(call.query)
  }
}

/** 工具名 → AI 权限面（静态映射；privacyGate.AiAccess 的工具面）。 */
const ACCESS_BY_TOOL: Record<AgentToolName, AiAccess> = {
  search_tasks: 'tasks',
  search_memories: 'memories',
  search_activities: 'activities',
  search_clipboard: 'clipboard'
}

/**
 * 工具级隐私门（与 privacyGate.aiAllowed 同语义：总开关 / 时间窗已由预填门
 * 过掉，此处只剩工具开关——clipboardAccess / memoryAccess）。
 */
function gateToolCall(
  policy: PrivacyPolicy | null,
  tool: AgentToolName,
  now: number
): { allowed: true } | { allowed: false; reason: string } {
  if (!policy) return { allowed: true }
  const decision = aiAllowed(policy, { access: ACCESS_BY_TOOL[tool], now })
  return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason ?? 'denied' }
}

/**
 * 剪贴板条目 → 内容类型（policy.allowedContentTypes 的键空间）。image-collection
 * 视作 image（整组是一个内容类型）。
 */
export function clipboardContentType(data: ItemData): ContentType {
  switch (data.kind) {
    case 'text':
      return 'text'
    case 'image':
    case 'image-collection':
      return 'image'
    case 'files':
      return 'files'
  }
}

/**
 * 按允许内容类型过滤剪贴板命中（search_clipboard 的结果格）：用户收窄为仅
 * text 后，文件 / 图片条目整体剔除——预览与 trace 都不进 AI（spec 决策 7）。
 * 缺省 allowed（空数组 = 无约束语义由调用方归一）时原样返回。
 */
export function filterClipboardHitsByType<T extends { data: ItemData }>(items: readonly T[], allowed: readonly ContentType[]): T[] {
  if (!allowed || allowed.length === 0) return [...items]
  return items.filter((it) => allowed.includes(clipboardContentType(it.data)))
}

/* ------------------------------------------------------------------ */
/* 预填隐私门（spec 决策 6/7，不变量 D）                               */
/* ------------------------------------------------------------------ */

export interface PrefillGateResult {
  /** 过滤后的 AI 预填（denied 应用剥离；memoryAccess 关 → 记忆清空）。 */
  context: DecisionContext
  /** 拦截块（调用方以 kind='privacy' 落 trace，共享决策链 decisionId）。 */
  blocks: Array<Omit<PrefillPrivacyBlock, 'decisionId'>>
  /** false = AI 整体不可用（aiEnabled 关 / 时间窗外）：跳过 LLM，算法兜底。 */
  allowAgent: boolean
}

/** 详情窗口标题同步剔除：只保留未被拒应用的窗口（denied 应用的窗口绝不留 AI 侧）。 */
function allowedWindowTitles(activity: DecisionContext['activity'], denied: Set<string>): string[] {
  const out: string[] = []
  for (const a of activity.apps) {
    if (!denied.has(normalizeExePath(a.id))) out.push(...a.windows)
  }
  return out
}

/**
 * 预填隐私门（不变量 D：denied 应用 / 关闭开关 → AI 侧预填无该数据）。
 * 判定顺序与 privacyGate.aiAllowed 同语义：
 *   1. aiEnabled 关 → allowAgent=false（整趟 AI 停，算法兜底；算法层始终
 *      看完整 ctx，本地工作照常，spec story 33）；
 *   2. 每日 AI 时间窗（墙钟小时 ≥ aiTimeRangeHours）→ allowAgent=false；
 *   3. 拒绝清单 → 剥离命中的应用（活动 apps / 窗口标题 / appCombination）；
 *   4. memoryAccess 关 → 预填无已匹配记忆。
 * 每条被拒数据产出一个拦截块（reason 与 aiAllowed 同文案，跨门一致），
 * 由调用方落 trace kind='privacy'（决策链共享 decisionId）。
 */
export function applyPrefillPrivacy(ctx: DecisionContext, policy: PrivacyPolicy | null): PrefillGateResult {
  if (!policy) return { context: ctx, blocks: [], allowAgent: true }
  // 1. AI 总开关（全局门）。
  if (!policy.aiEnabled) {
    return { context: ctx, blocks: [{ reason: 'ai disabled', access: 'prefill' }], allowAgent: false }
  }
  // 2. 每日 AI 时间窗（全局门；与 aiAllowed 同一判定：本地时区墙钟小时）。
  const hours = policy.aiTimeRangeHours
  if (hours !== undefined) {
    const hourOfDay = new Date(ctx.now).getHours()
    if (hourOfDay >= hours) {
      return {
        context: ctx,
        blocks: [{ reason: `outside ai time range (hour ${hourOfDay} >= ${hours})`, access: 'prefill' }],
        allowAgent: false
      }
    }
  }
  // 3. 拒绝清单（逐应用剥离）。
  const denied = new Set(policy.deniedApps.map(normalizeExePath))
  const keptApps = ctx.activity.apps.filter((a) => !denied.has(normalizeExePath(a.id)))
  // 4. memoryAccess（记忆门：预填含已匹配记忆）。
  const memoriesBlocked = !policy.memoryAccess && ctx.matchedMemories.length > 0
  if (keptApps.length === ctx.activity.apps.length && !memoriesBlocked) {
    return { context: ctx, blocks: [], allowAgent: true }
  }
  const blocks: Array<Omit<PrefillPrivacyBlock, 'decisionId'>> = []
  for (const a of ctx.activity.apps) {
    if (denied.has(normalizeExePath(a.id))) {
      blocks.push({ reason: `app on denied list: ${normalizeExePath(a.id)}`, access: 'prefill', appExePath: a.id })
    }
  }
  if (memoriesBlocked) blocks.push({ reason: 'memory access disabled', access: 'prefill' })
  const context: DecisionContext = {
    ...ctx,
    activity: { ...ctx.activity, apps: keptApps },
    detail: {
      ...ctx.detail,
      windowTitles: allowedWindowTitles(ctx.activity, denied),
      evidence: {
        ...ctx.detail.evidence,
        appCombination: keptApps.map((a) => a.name).slice(0, 5).join(', ')
      }
    },
    matchedMemories: memoriesBlocked ? [] : ctx.matchedMemories
  }
  return { context, blocks, allowAgent: true }
}

/* ------------------------------------------------------------------ */
/* 算法决策者（兜底路径）                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Agent 决策者（主路径：预填门 + 工具升级 + 一次性 JSON 决策）          */
/* ------------------------------------------------------------------ */

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
  /** 预填隐私门 policy 供应（spec 决策 6/7）；null = 未接线，不过门。 */
  getPolicy?: () => PrivacyPolicy | null
  /** 隐私拦截 trace 落点（kind='privacy'，决策链共享 decisionId）。 */
  recordPrivacy?: (block: PrefillPrivacyBlock) => void
  /** 工具召回 trace 落点（kind='recall'，spec 决策 8）。 */
  recordRecall?: (recall: ToolRecall) => void
  /** 四固定工具面（缺省 = 无工具：纯预填一次性决策，与 t55 行为一致）。 */
  tools?: AgentToolSet
  /** 工具调用预算（≤3，缺省 3；0 = 禁用升级路径）。 */
  toolBudget?: number
  /** 高不确定升级判定（缺省 = shouldUpgradeToTools + confidenceLow）。 */
  shouldUpgrade?: (ctx: DecisionContext) => boolean
  /** 缺省升级判定的低置信阈值（缺省 0.45 = 设置缺省 confidenceLow）。 */
  confidenceLow?: number
}

function buildDecisionRequest(ctx: DecisionContext, timeoutMs: number, toolLines: AgentToolLine[] = []): ChatRequest {
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
  ]
  if (toolLines.length > 0) {
    user.push(`Tool results:\n${toolLines.map((l) => `- ${l.tool}("${l.query}"): ${l.count} hit(s) — ${l.preview}`).join('\n')}`)
  }
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user.join('\n') }
    ],
    schema: DECISION_REPLY_SCHEMA,
    maxTokens: 300,
    timeoutMs
  }
}

/**
 * Agent 决策者（spec 决策 6 主路径）：最小预填 → 预填隐私门（不变量 D）→
 * 高不确定升级路径（≤3 次工具调用，预算耗尽 / 失败不追加）→ 一次 JSON
 * 决策；失败 / 未配置 / 校验不过 / AI 整体被门关 → 算法兜底（不变量：
 * AI 是增强不是依赖）。算法兜底始终看完整 ctx——算法层本地工作照常。
 */
export function createAgentDecisionProvider(options: AgentDecisionProviderOptions): TaskDecisionProvider {
  const fallback = options.fallback ?? createAlgorithmDecisionProvider()
  const timeoutMs = options.timeoutMs ?? 20_000
  const budget = clampToolBudget(options.toolBudget)
  const confidenceLow = options.confidenceLow ?? 0.45
  const upgrade = options.shouldUpgrade ?? ((ctx: DecisionContext) => shouldUpgradeToTools(ctx, confidenceLow))
  return {
    id: 'agent',
    async evaluateTaskContext(ctx: DecisionContext, decisionId?: string): Promise<TaskDecision> {
      const chainId = decisionId ?? `d_${createId()}`
      const chat = options.getChat()
      const policy = options.getPolicy?.() ?? null
      // 预填隐私门（不变量 D）：AI 侧预填过门；denied 应用 / 关闭开关 →
      // 预填无该数据。被拒数据落 trace kind='privacy'。
      const gated = applyPrefillPrivacy(ctx, policy)
      for (const b of gated.blocks) options.recordPrivacy?.({ ...b, decisionId: chainId })
      // AI 整体不可用（关 / 时间窗外 / 未接线）→ 算法兜底（完整 ctx）。
      if (!gated.allowAgent || !chat) return fallback.evaluateTaskContext(ctx)
      // 高不确定升级路径：≤3 次工具调用（预算硬上限，绝无 getEverything）。
      // 判定与计划都用**过门后** context——denied 应用已剥离，查询串与结果
      // 不会携带被拒应用键（不变量 D 覆盖升级路径，非只预填）。
      const toolLines: AgentToolLine[] = []
      if (options.tools && upgrade(gated.context)) {
        for (const call of planToolCalls(gated.context, budget)) {
          const gate = gateToolCall(policy, call.tool, gated.context.now)
          if (!gate.allowed) {
            // search_clipboard 开关关 → 空 + 拦截记录（spec 决策 7）。
            options.recordPrivacy?.({ decisionId: chainId, reason: gate.reason, access: ACCESS_BY_TOOL[call.tool] })
            toolLines.push({ tool: call.tool, query: call.query, count: 0, preview: '(blocked by privacy policy)' })
            continue
          }
          try {
            const result = await runTool(options.tools, call)
            const line: AgentToolLine = {
              tool: call.tool,
              query: call.query,
              count: result.count,
              preview: result.preview.slice(0, 200)
            }
            options.recordRecall?.({ ...line, decisionId: chainId })
            toolLines.push(line)
          } catch (err) {
            // 工具失败不炸决策：记 recall 空结果，预算照花。
            const message = err instanceof Error ? err.message : String(err)
            options.recordRecall?.({ decisionId: chainId, tool: call.tool, query: call.query, count: 0, preview: `(tool error: ${message})` })
            toolLines.push({ tool: call.tool, query: call.query, count: 0, preview: '(tool error)' })
          }
        }
      }
      try {
        const result = await chat(buildDecisionRequest(gated.context, timeoutMs, toolLines))
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
    async evaluateTaskContext(ctx: DecisionContext, decisionId?: string): Promise<TaskDecision> {
      if (!options.optimizer) return options.inner.evaluateTaskContext(ctx, decisionId)
      const original = ctx.candidates
      try {
        const optimized = await options.optimizer.optimize(toCandidateActivities(original))
        if (optimized === null || optimized.length === 0) {
          // 降级：算法候选原样（不变量 H）。
          return options.inner.evaluateTaskContext(ctx, decisionId)
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
          return options.inner.evaluateTaskContext(ctx, decisionId)
        }
        const innerDecision = await options.inner.evaluateTaskContext({ ...ctx, candidates: next }, decisionId)
        // 优化器实际介入（过滤/标题/排序）→ 盖章本地模型；否则透传内层 id。
        return { ...innerDecision, decidedBy: 'local-model' }
      } catch {
        return options.inner.evaluateTaskContext(ctx, decisionId)
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* suggestTitle（t56 迁入；ADR-0003 保存时自动标题）                    */
/* ------------------------------------------------------------------ */

export interface TitleSuggestionOptions {
  /** Provider 链聊天入口（null = 无 AI，返回 null——渲染侧算法标题兜底）。 */
  getChat: () => ((req: ChatRequest) => Promise<ChatResult>) | null
  /** 上下文先验（ADR-0003）：confirmed project/workflow 记忆重叠草稿文本。 */
  readMemories?: () => readonly Memory[]
  /** ai-log 落点（缺省 = 静默）。 */
  log?: (entry: Record<string, unknown>) => void
  /** 请求超时（缺省 20s，与引擎一致）。 */
  timeoutMs?: number
}

export interface TitleSuggester {
  /** 1-3 个标题候选；无 provider / 链失败 / 回复不过校验 → null（调用方算法标题兜底）。 */
  suggestTitle(ctx: SuggestTitleContext): Promise<string[] | null>
}

const MAX_TITLE_CHARS = 60
const DEFAULT_TITLE_TIMEOUT_MS = 20_000

function sanitizeTitleString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** Text a segment is matched against: window titles + app names. */
export interface SegmentText {
  appNames: string[]
  windowTitles: string[]
}

/**
 * Context-prior matching (spec decision 7): which confirmed project/workflow
 * memories each segment hits. A memory matches when its content and the
 * segment text overlap in either direction (case-insensitive substring) — a
 * memory "CAD Agent" hits a "CAD Agent" segment, and a memory describing the
 * segment's own terms hits as well. Identity/tool memories and anything not
 * user-confirmed are never injected.
 */
export function matchMemories(segments: SegmentText[], memories: readonly Memory[]): string[][] {
  const usable = memories.filter(
    (m) => m.userState === 'confirmed' && (m.type === 'project' || m.type === 'workflow') && m.content.trim().length > 0
  )
  return segments.map((seg) => {
    const parts = [...seg.windowTitles, ...seg.appNames].map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0)
    if (parts.length === 0) return []
    const joined = parts.join(' ')
    const hits: string[] = []
    for (const m of usable) {
      const content = m.content.trim().toLowerCase()
      if (!content) continue
      // Either the memory is a phrase inside the segment text, or the segment
      // carries one of the memory's phrases — checked per part, because the
      // joined text is only meaningful in the memory->text direction.
      if (joined.includes(content) || parts.some((p) => content.includes(p))) hits.push(m.content.trim())
    }
    return hits
  })
}

/**
 * suggestTitle（ADR-0003 保存时自动标题，t56 从 suggestionEngine 迁入）：
 * IPC 通道（task:suggest-title）与触发条件（渲染侧：标题空 + 其他内容非空
 * 才调用；失败静默降级算法标题）不变，行为一致。纯逻辑：chat / 记忆 / log
 * 注入，vitest 直测。
 */
export function createTitleSuggester(options: TitleSuggestionOptions): TitleSuggester {
  const log = options.log ?? (() => {})
  const timeoutMs = options.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS
  return {
    async suggestTitle(ctx: SuggestTitleContext): Promise<string[] | null> {
      const chat = options.getChat()
      if (!chat) {
        log({ kind: 'title.request', context: {}, error: 'no provider configured' })
        return null
      }
      // Only the fields the draft actually carries travel to the provider.
      const details: Record<string, unknown> = {}
      if (ctx.title && ctx.title.trim().length > 0) details.title = ctx.title.trim()
      if (ctx.note && ctx.note.trim().length > 0) details.note = ctx.note.trim()
      if (ctx.appNames.length > 0) details.appNames = ctx.appNames
      if (ctx.resourcePreviews.length > 0) details.resourcePreviews = ctx.resourcePreviews
      // Memory context (ADR-0003): same context-prior rule as the analysis
      // pass — confirmed project/workflow memories overlapping the draft
      // text (apps + previews + title + note) travel as memoryContext.
      if (options.readMemories) {
        const draftParts = [ctx.title, ctx.note, ...ctx.resourcePreviews].filter(
          (s): s is string => typeof s === 'string' && s.trim().length > 0
        )
        const hits = matchMemories([{ appNames: ctx.appNames, windowTitles: draftParts }], options.readMemories())
        if (hits[0] && hits[0].length > 0) details.memoryContext = hits[0]
      }
      log({ kind: 'title.request', context: details })
      const req: ChatRequest = {
        messages: [
          {
            role: 'system',
            content:
              'You suggest titles for a task tracker. Given a task draft, reply with JSON only: ' +
              '{"titles": ["...", "..."]} with 1 to 3 concise titles, at most 8 words each, no quotes, ' +
              'written in the same language as the draft. The first title is the best; every candidate must be distinct.'
          },
          { role: 'user', content: `Task: ${JSON.stringify(details)}` }
        ],
        schema: {
          type: 'object',
          properties: { titles: { type: 'array', items: { type: 'string' } } },
          required: ['titles']
        },
        maxTokens: 200,
        timeoutMs
      }

      let result: ChatResult
      try {
        result = await chat(req)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.log(`[Suggestion] title suggestion failed: ${error}`)
        log({ kind: 'title.result', titles: null, error })
        return null
      }
      if (!result.ok || !result.parsed || typeof result.parsed !== 'object' || Array.isArray(result.parsed)) {
        log({ kind: 'title.result', titles: null, error: result.ok ? 'invalid reply' : result.error })
        return null
      }
      const parsed = result.parsed as { titles?: unknown }
      if (!Array.isArray(parsed.titles)) {
        log({ kind: 'title.result', titles: null, error: 'invalid reply' })
        return null
      }

      const seen = new Set<string>()
      const titles: string[] = []
      for (const raw of parsed.titles) {
        const title = sanitizeTitleString(raw, MAX_TITLE_CHARS)
        if (title.length === 0 || seen.has(title.toLowerCase())) continue
        seen.add(title.toLowerCase())
        titles.push(title)
        if (titles.length >= 3) break
      }
      const out = titles.length > 0 ? titles : null
      log({ kind: 'title.result', titles: out, error: out ? undefined : 'no valid titles' })
      return out
    }
  }
}
