/**
 * 决策者三实现一致性测试（t55，spec Testing Decisions 决策者替换用例）。
 *
 * 同一 DecisionContext 下 agent / 算法 / 本地模型（fake）产出一致结构
 * （合法 TaskDecision 判别联合）；本地模型失败 / 关闭 → 算法候选原样传递
 * （不变量 H）；agent 无 AI 配置 / 回复非法 → 算法兜底（AI 是增强不是依赖）。
 */
import { describe, expect, it, vi } from 'vitest'

import type { ChatResult } from '../electron/main/provider'
import type { CandidateActivity, ClipboardItem, ContentType, Memory } from '../shared/types'
import {
  applyPrefillPrivacy,
  AGENT_TOOLS,
  clampToolBudget,
  clipboardContentType,
  createAgentDecisionProvider,
  createAlgorithmDecisionProvider,
  createLocalModelDecisionProvider,
  createTitleSuggester,
  filterClipboardHitsByType,
  parseTaskDecision,
  planToolCalls,
  shouldUpgradeToTools,
  TOOL_BUDGET_CAP,
  type AgentToolSet,
  type PrefillPrivacyBlock,
  type ToolRecall
} from '../electron/store/decisionProvider'
import { DEFAULT_POLICY, type PrivacyPolicy } from '../electron/store/privacyGate'
import type { DecisionContext, TaskDecision } from '../electron/store/currentTaskController'
import type { Activity, ActivityDetail } from '../electron/store/activityLedger'

function makeContext(overrides?: Partial<DecisionContext>): DecisionContext {
  const startAt = 1_000_000
  const activity: Activity = {
    id: 'act_1',
    startAt,
    endAt: startAt + 30_000,
    apps: [{ id: 'code.exe', name: 'code.exe', durationMs: 30_000, windows: ['VSCode - x.ts'] }],
    clipboardRefs: [],
    attribution: { taskId: 't_B', confidence: 0.8 },
    signature: 'sig',
    classifierVersion: 'clusterer@1'
  }
  const detail: ActivityDetail = {
    zone: 'high',
    confidence: 0.8,
    windowTitles: ['VSCode - x.ts'],
    evidence: { appCombination: 'code.exe', durationMs: 30_000, overlappingTasks: [], margin: 0.3 }
  }
  return {
    activity,
    detail,
    currentTask: { id: 't_A', title: 'Task A', status: 'running' },
    currentSession: null,
    candidates: [{ taskId: 't_B', title: 'Task B', confidence: 0.8, zone: 'high', margin: 0.3, evidence: ['VSCode - x.ts'] }],
    matchedMemories: [],
    profile: {},
    now: 1_000_000,
    ...overrides
  }
}

function okResult(parsed: unknown): ChatResult {
  return { ok: true, content: JSON.stringify(parsed), parsed, provider: { id: 'p1', baseUrl: 'x', model: 'm' }, providerIndex: 0 }
}

function failResult(error: string): ChatResult {
  return { ok: false, error, attempts: [{ providerId: 'p1', error }] }
}

describe('parseTaskDecision — 客户端校验', () => {
  it('接受合法判别联合，拒绝缺字段 / 坏类型', () => {
    expect(parseTaskDecision({ action: 'continue', taskId: 't_1', confidence: 0.5, reason: 'r' })).toEqual({
      action: 'continue',
      taskId: 't_1',
      confidence: 0.5,
      reason: 'r'
    })
    expect(parseTaskDecision({ action: 'switch', fromTaskId: 'a', toTaskId: 'b', confidence: 0.9, reason: 'r', evidence: ['e'] })).toMatchObject({
      action: 'switch',
      toTaskId: 'b'
    })
    expect(parseTaskDecision({ action: 'new', title: 'T', confidence: 0.4, reason: 'r', apps: ['a'], evidence: [] })).toMatchObject({
      action: 'new',
      title: 'T'
    })
    expect(parseTaskDecision({ action: 'ignore', reason: 'r' })).toEqual({ action: 'ignore', reason: 'r' })
    // 缺 taskId / 缺 confidence / 未知动作 / 非对象 → null。
    expect(parseTaskDecision({ action: 'continue', confidence: 0.5, reason: 'r' })).toBeNull()
    expect(parseTaskDecision({ action: 'switch', toTaskId: 'b', reason: 'r' })).toBeNull()
    expect(parseTaskDecision({ action: 'explode', reason: 'r' })).toBeNull()
    expect(parseTaskDecision('nope')).toBeNull()
    expect(parseTaskDecision([{ action: 'continue' }])).toBeNull()
  })

  it('confidence 越界（<0 或 >1）拒绝', () => {
    expect(parseTaskDecision({ action: 'continue', taskId: 't', confidence: 1.5, reason: 'r' })).toBeNull()
    expect(parseTaskDecision({ action: 'continue', taskId: 't', confidence: -0.1, reason: 'r' })).toBeNull()
  })
})

describe('决策者三实现 — 同一输入产出一致结构', () => {
  it('算法：候选超当前 → switch；winner == current → continue；无候选 → new', async () => {
    const algo = createAlgorithmDecisionProvider()
    const ctx = makeContext()
    const d = await algo.evaluateTaskContext(ctx)
    expect(d).toMatchObject({ action: 'switch', toTaskId: 't_B', confidence: 0.8 })
    const same = await algo.evaluateTaskContext({ ...ctx, candidates: [{ ...ctx.candidates[0], taskId: 't_A', title: 'Task A' }] })
    expect(same).toMatchObject({ action: 'continue', taskId: 't_A' })
    const none = await algo.evaluateTaskContext(makeContext({ candidates: [], detail: { ...ctx.detail, zone: 'new', confidence: 0.3 } }))
    expect(none).toMatchObject({ action: 'new' })
    expect((none as { title: string }).title).toMatch(/task$/)
  })

  it('agent（fake chat 合法回复）→ 与算法一致的判别联合结构', async () => {
    const agent = createAgentDecisionProvider({
      getChat: () => async () => okResult({ action: 'switch', fromTaskId: 't_A', toTaskId: 't_B', confidence: 0.8, reason: 'llm', evidence: [] }),
      fallback: createAlgorithmDecisionProvider()
    })
    const d = await agent.evaluateTaskContext(makeContext())
    expect(d).toMatchObject({ action: 'switch', toTaskId: 't_B', confidence: 0.8, reason: 'llm' })
  })

  it('agent 无 AI 配置（chat null）→ 算法兜底', async () => {
    const agent = createAgentDecisionProvider({ getChat: () => null })
    const d = await agent.evaluateTaskContext(makeContext())
    expect(d.action).toBe('switch') // 算法判定
  })

  it('agent 回复非法 / 失败 → 算法兜底（AI 是增强不是依赖）', async () => {
    const algo = createAlgorithmDecisionProvider()
    const garbage = createAgentDecisionProvider({
      getChat: () => async () => okResult({ action: 'explode' }),
      fallback: algo
    })
    const failed = createAgentDecisionProvider({
      getChat: () => async () => failResult('provider down'),
      fallback: algo
    })
    expect(await garbage.evaluateTaskContext(makeContext())).toEqual(await algo.evaluateTaskContext(makeContext()))
    expect(await failed.evaluateTaskContext(makeContext())).toEqual(await algo.evaluateTaskContext(makeContext()))
  })

  it('本地模型（fake 优化器成功）→ 候选经优化后交内层', async () => {
    const inner = {
      id: 'algorithm',
      async evaluateTaskContext(ctx: DecisionContext): Promise<TaskDecision> {
        return { action: 'switch', fromTaskId: '', toTaskId: ctx.candidates[0]?.taskId ?? '', confidence: 0.8, reason: 'inner', evidence: [] }
      }
    }
    let seen: CandidateActivity[] | null = null
    const lm = createLocalModelDecisionProvider({
      inner,
      optimizer: {
        async optimize(candidates: CandidateActivity[]): Promise<CandidateActivity[] | null> {
          seen = candidates
          return candidates.map((c) => ({ ...c, semanticLabel: '本地草稿' }))
        }
      }
    })
    const d = await lm.evaluateTaskContext(makeContext())
    expect(seen).toHaveLength(1)
    expect(seen![0].candidateTaskId).toBe('t_B')
    expect(d).toMatchObject({ action: 'switch', toTaskId: 't_B' })
  })

  it('优化器 rerank 顺序与标题草稿到达内层（MAJOR-2）', async () => {
    let seen: DecisionContext['candidates'] | null = null
    const inner = {
      id: 'algorithm',
      async evaluateTaskContext(ctx: DecisionContext): Promise<TaskDecision> {
        seen = ctx.candidates
        return { action: 'continue', taskId: ctx.candidates[0]?.taskId ?? '', confidence: 0.8, reason: 'inner' }
      }
    }
    const ctx = makeContext({
      candidates: [
        { taskId: 't_B', title: 'Task B', confidence: 0.8, zone: 'high', margin: 0.3, evidence: ['e1'] },
        { taskId: 't_C', title: 'Task C', confidence: 0.6, zone: 'low', margin: 0.2, evidence: ['e2'] }
      ]
    })
    const lm = createLocalModelDecisionProvider({
      inner,
      optimizer: {
        async optimize(candidates) {
          // 重排：把第二个提到最前 + 标题草稿。
          return [candidates[1], candidates[0]].map((c, i) => ({ ...c, semanticLabel: `草稿${i + 1}` }))
        }
      }
    })
    await lm.evaluateTaskContext(ctx)
    expect(seen!.map((c) => c.taskId)).toEqual(['t_C', 't_B']) // 优化器顺序保留
    expect(seen![0].title).toBe('草稿1')
    expect(seen![1].title).toBe('草稿2')
  })

  it('decidedBy 标识实际执行者（MINOR-3）', async () => {
    const algo = createAlgorithmDecisionProvider()
    expect((await algo.evaluateTaskContext(makeContext())).decidedBy).toBe('algorithm')
    const agent = createAgentDecisionProvider({
      getChat: () => async () => okResult({ action: 'continue', taskId: 't_A', confidence: 0.5, reason: 'llm' })
    })
    expect((await agent.evaluateTaskContext(makeContext())).decidedBy).toBe('agent')
    // 本地模型介入 → 盖 local-model 章（无论内层是谁）。
    const lm = createLocalModelDecisionProvider({ inner: agent, optimizer: { async optimize(c) { return c } } })
    expect((await lm.evaluateTaskContext(makeContext())).decidedBy).toBe('local-model')
    // 本地模型关闭 / 失败 → 透传内层章：算法直连 → algorithm；agent 无 chat → 算法兜底。
    const off = createLocalModelDecisionProvider({ inner: algo, optimizer: null })
    expect((await off.evaluateTaskContext(makeContext())).decidedBy).toBe('algorithm')
    // 本地模型关闭 + agent 无 AI 配置 → 算法兜底并盖算法章。
    const noChatAgent = createAgentDecisionProvider({ getChat: () => null })
    const agentOff = createLocalModelDecisionProvider({ inner: noChatAgent, optimizer: null })
    expect((await agentOff.evaluateTaskContext(makeContext())).decidedBy).toBe('algorithm')
    const failing = createLocalModelDecisionProvider({ inner: agent, optimizer: { async optimize() { throw new Error('down') } } })
    expect((await failing.evaluateTaskContext(makeContext())).decidedBy).toBe('agent') // 降级 → 内层 agent 实际裁决
  })

  it('本地模型失败 / 关闭 → 算法候选原样（不变量 H）', async () => {
    let innerCtx: DecisionContext | null = null
    const inner = {
      id: 'algorithm',
      async evaluateTaskContext(ctx: DecisionContext): Promise<TaskDecision> {
        innerCtx = ctx
        return { action: 'switch', fromTaskId: '', toTaskId: ctx.candidates[0]?.taskId ?? '', confidence: 0.8, reason: 'inner', evidence: [] }
      }
    }
    const original = makeContext()
    // 优化器返回 null（关闭 / 失败语义）。
    const failing = createLocalModelDecisionProvider({ inner, optimizer: { async optimize() { return null } } })
    await failing.evaluateTaskContext(original)
    expect(innerCtx!.candidates).toEqual(original.candidates)
    // 优化器抛错。
    const throwing = createLocalModelDecisionProvider({
      inner,
      optimizer: { async optimize() { throw new Error('model down') } }
    })
    await throwing.evaluateTaskContext(original)
    expect(innerCtx!.candidates).toEqual(original.candidates)
    // 优化器为 null（本地模型关闭）。
    const off = createLocalModelDecisionProvider({ inner, optimizer: null })
    await off.evaluateTaskContext(original)
    expect(innerCtx!.candidates).toEqual(original.candidates)
  })
})

/* ------------------------------------------------------------------ */
/* t56: 预填隐私门（不变量 D）                                         */
/* ------------------------------------------------------------------ */

describe('applyPrefillPrivacy — 预填整体过隐私门（不变量 D）', () => {
  it('null policy（未接线）→ 原样透传、无拦截', () => {
    const ctx = makeContext({ matchedMemories: [{ content: 'm', reasons: ['activity'], hops: 0 }] })
    const gated = applyPrefillPrivacy(ctx, null)
    expect(gated.allowAgent).toBe(true)
    expect(gated.blocks).toEqual([])
    expect(gated.context).toBe(ctx)
  })

  it('denied 应用 → 预填无该应用数据（活动 / 窗口标题 / appCombination 全剥离）', () => {
    const base = makeContext()
    const ctx: DecisionContext = {
      ...base,
      activity: {
        ...base.activity,
        apps: [
          { id: 'code.exe', name: 'code.exe', durationMs: 30_000, windows: ['VSCode - x.ts'] },
          { id: 'C:/Apps/Bank.exe', name: 'Bank', durationMs: 10_000, windows: ['statement.pdf'] }
        ]
      },
      detail: {
        ...base.detail,
        windowTitles: ['VSCode - x.ts', 'statement.pdf'],
        evidence: { ...base.detail.evidence, appCombination: 'code.exe, Bank' }
      }
    }
    const policy: PrivacyPolicy = { ...DEFAULT_POLICY, deniedApps: ['c:/apps/bank.exe'] } // 大小写/反斜杠归一化
    const gated = applyPrefillPrivacy(ctx, policy)
    expect(gated.allowAgent).toBe(true)
    expect(gated.blocks).toEqual([
      { reason: 'app on denied list: c:/apps/bank.exe', access: 'prefill', appExePath: 'C:/Apps/Bank.exe' }
    ])
    expect(gated.context.activity.apps.map((a) => a.name)).toEqual(['code.exe'])
    expect(gated.context.detail.windowTitles).toEqual(['VSCode - x.ts'])
    expect(gated.context.detail.evidence.appCombination).toBe('code.exe')
  })

  it('全部应用被拒 → 预填活动为空（结构仍合法），AI 侧零数据', () => {
    const ctx = makeContext()
    const policy: PrivacyPolicy = { ...DEFAULT_POLICY, deniedApps: ['code.exe'] }
    const gated = applyPrefillPrivacy(ctx, policy)
    expect(gated.context.activity.apps).toEqual([])
    expect(gated.context.detail.windowTitles).toEqual([])
    expect(gated.blocks.length).toBe(1)
  })

  it('memoryAccess 关 → 预填无已匹配记忆 + 拦截块', () => {
    const ctx = makeContext({ matchedMemories: [{ content: 'CAD Agent', reasons: ['activity'], hops: 0 }] })
    const policy: PrivacyPolicy = { ...DEFAULT_POLICY, memoryAccess: false }
    const gated = applyPrefillPrivacy(ctx, policy)
    expect(gated.allowAgent).toBe(true)
    expect(gated.context.matchedMemories).toEqual([])
    expect(gated.blocks).toEqual([{ reason: 'memory access disabled', access: 'prefill' }])
  })

  it('memoryAccess 关但预填本就无记忆 → 无拦截', () => {
    const gated = applyPrefillPrivacy(makeContext(), { ...DEFAULT_POLICY, memoryAccess: false })
    expect(gated.blocks).toEqual([])
  })

  it('aiEnabled 关 → allowAgent false（整趟 AI 停，算法兜底）', () => {
    const gated = applyPrefillPrivacy(makeContext(), { ...DEFAULT_POLICY, aiEnabled: false })
    expect(gated.allowAgent).toBe(false)
    expect(gated.blocks).toEqual([{ reason: 'ai disabled', access: 'prefill' }])
  })

  it('时间窗外 → allowAgent false', () => {
    const now = new Date(2026, 0, 1, 18, 30).getTime() // 本地 18:30
    const gated = applyPrefillPrivacy(makeContext({ now }), { ...DEFAULT_POLICY, aiTimeRangeHours: 18 })
    expect(gated.allowAgent).toBe(false)
    expect(gated.blocks[0].reason).toMatch(/outside ai time range/)
  })
})

/* ------------------------------------------------------------------ */
/* t56: 工具预算（≤3，四固定工具面）                                   */
/* ------------------------------------------------------------------ */

describe('planToolCalls — 工具预算与工具面', () => {
  it('预算硬上限 ≤3；顺序固定（记忆 → 场景 → 剪贴板最后）', () => {
    const ctx = makeContext({
      activity: { ...makeContext().activity, clipboardRefs: ['item_9'] },
      detail: { ...makeContext().detail, zone: 'new', confidence: 0.3 }
    })
    const plan = planToolCalls(ctx, TOOL_BUDGET_CAP)
    expect(plan.length).toBeLessThanOrEqual(TOOL_BUDGET_CAP)
    expect(plan.map((c) => c.tool)).toEqual(['search_memories', 'search_tasks', 'search_activities'])
    // 剪贴板：预算耗尽时不追加（敏感面最后，且只随引用出现）。
    expect(plan.some((c) => c.tool === 'search_clipboard')).toBe(false)
  })

  it('预算余量足且活动带剪贴板引用 → search_clipboard 最后调用', () => {
    // else 分支（竞争 / 常规低置信）：记忆 + 活动 = 2，剪贴板补第 3 格。
    const ctx = makeContext({
      activity: { ...makeContext().activity, clipboardRefs: ['item_9'] },
      detail: { ...makeContext().detail, zone: 'high', confidence: 0.3 }
    })
    const plan = planToolCalls(ctx, 3)
    expect(plan).toEqual([
      { tool: 'search_memories', query: expect.any(String) },
      { tool: 'search_activities', query: expect.any(String) },
      { tool: 'search_clipboard', query: 'item_9' }
    ])
  })

  it('无活动键（无 app 名/窗口）→ 空计划（不发无意义查询）', () => {
    const ctx = makeContext({
      activity: { ...makeContext().activity, apps: [], clipboardRefs: [] }
    })
    expect(planToolCalls(ctx, 3)).toEqual([])
  })

  it('clampToolBudget：0..3 钳制；0 = 禁用升级路径', () => {
    expect(clampToolBudget(undefined)).toBe(3)
    expect(clampToolBudget(5)).toBe(3)
    expect(clampToolBudget(-1)).toBe(0)
    expect(clampToolBudget(2)).toBe(2)
  })

  it('AGENT_TOOLS 固定四工具面（类型级约束；无 getEverything）', () => {
    expect(AGENT_TOOLS).toEqual(['search_tasks', 'search_memories', 'search_activities', 'search_clipboard'])
  })

  it('shouldUpgradeToTools：新簇 / 无候选 / 低置信 / 竞争 触发', () => {
    const base = makeContext()
    expect(shouldUpgradeToTools({ ...base, detail: { ...base.detail, zone: 'new' } }, 0.45)).toBe(true)
    expect(shouldUpgradeToTools({ ...base, candidates: [] }, 0.45)).toBe(true)
    expect(shouldUpgradeToTools({ ...base, detail: { ...base.detail, confidence: 0.3 } }, 0.45)).toBe(true)
    expect(
      shouldUpgradeToTools(
        { ...base, detail: { ...base.detail, evidence: { ...base.detail.evidence, overlappingTasks: ['t1', 't2'] } } },
        0.45
      )
    ).toBe(true)
    expect(shouldUpgradeToTools(base, 0.45)).toBe(false)
    // 竞争需 ≥2 个可行动重叠（终态过滤在 buildContext，控制器侧测试覆盖）。
    expect(
      shouldUpgradeToTools(
        { ...base, detail: { ...base.detail, evidence: { ...base.detail.evidence, overlappingTasks: ['t1'] } } },
        0.45
      )
    ).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* t56: 剪贴板内容类型过滤（评审：allowedContentTypes 在决策路径生效）   */
/* ------------------------------------------------------------------ */

describe('clipboardContentType / filterClipboardHitsByType', () => {
  const textItem: ClipboardItem = { id: 't1', data: { kind: 'text', text: 'hello', isUrl: false }, capturedAt: 1, hitCount: 1, pinned: false }
  const imageItem: ClipboardItem = { id: 'i1', data: { kind: 'image', imageId: 'x', width: 10, height: 10, bytes: 5 }, capturedAt: 1, hitCount: 1, pinned: false }
  const filesItem: ClipboardItem = { id: 'f1', data: { kind: 'files', paths: ['a.pdf'] }, capturedAt: 1, hitCount: 1, pinned: false }

  it('clipboardContentType 映射三键空间（image-collection 归 image）', () => {
    expect(clipboardContentType(textItem.data)).toBe('text')
    expect(clipboardContentType(imageItem.data)).toBe('image')
    expect(clipboardContentType({ kind: 'image-collection', images: [] })).toBe('image')
    expect(clipboardContentType(filesItem.data)).toBe('files')
  })

  it('收窄为仅 text → 文件 / 图片条目整格剔除（预览不进 AI）', () => {
    const allowed: ContentType[] = ['text']
    const out = filterClipboardHitsByType([textItem, imageItem, filesItem], allowed)
    expect(out.map((i) => i.id)).toEqual(['t1'])
  })

  it('缺省允许全部 → 原样保留', () => {
    const out = filterClipboardHitsByType([textItem, imageItem, filesItem], ['text', 'image', 'files'])
    expect(out).toHaveLength(3)
  })
})

/* ------------------------------------------------------------------ */
/* t56: Agent 升级路径执行 + 兜底                                      */
/* ------------------------------------------------------------------ */

describe('agent 决策者 — 预填门 + 工具升级路径', () => {
  function makeAgent(opts: {
    policy?: PrivacyPolicy | null
    tools?: AgentToolSet
    budget?: number
    chat?: (req: unknown) => Promise<ChatResult>
  }): {
    provider: TaskDecisionProvider
    chat: ReturnType<typeof vi.fn>
    recalls: ToolRecall[]
    blocks: PrefillPrivacyBlock[]
    calls: { tool: string; query: string }[]
  } {
    const chat =
      opts.chat ??
      (async () => okResult({ action: 'continue', taskId: 't_A', confidence: 0.8, reason: 'r' }))
    const chatFn = vi.fn(chat)
    const recalls: ToolRecall[] = []
    const blocks: PrefillPrivacyBlock[] = []
    const calls: { tool: string; query: string }[] = []
    const tools: AgentToolSet | undefined =
      opts.tools ??
      (Object.fromEntries(
        [
          ['searchTasks', 'search_tasks'],
          ['searchMemories', 'search_memories'],
          ['searchActivities', 'search_activities'],
          ['searchClipboard', 'search_clipboard']
        ].map(([method, tool]) => [
          method,
          async (query: string) => {
            calls.push({ tool, query })
            return { count: 1, preview: `hit for ${query}` }
          }
        ])
      ) as unknown as AgentToolSet)
    const provider = createAgentDecisionProvider({
      getChat: () => chatFn,
      getPolicy: () => (opts.policy !== undefined ? opts.policy : DEFAULT_POLICY),
      recordRecall: (r) => recalls.push(r),
      recordPrivacy: (b) => blocks.push(b),
      tools: tools ?? undefined,
      toolBudget: opts.budget,
      shouldUpgrade: (ctx) => shouldUpgradeToTools(ctx, 0.45)
    })
    return { provider, chat: chatFn, recalls, blocks, calls }
  }

  it('高不确定（新簇）→ 执行计划内工具，recall 全部落 trace（共享 decisionId）', async () => {
    const ctx = makeContext({ detail: { ...makeContext().detail, zone: 'new', confidence: 0.3 } })
    const { provider, chat, recalls, calls } = makeAgent({})
    const decision = await provider.evaluateTaskContext(ctx, 'd_1')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.length).toBeLessThanOrEqual(TOOL_BUDGET_CAP)
    expect(recalls.length).toBe(calls.length)
    for (const r of recalls) expect(r.decisionId).toBe('d_1')
    // 工具结果进入决策请求（LLM 可见）。
    const req = chat.mock.calls[0][0]
    expect(req.messages[1].content).toContain('Tool results:')
    expect(req.messages[1].content).toContain('search_memories')
    expect(decision.decidedBy).toBe('agent')
  })

  it('稳态（无升级信号）→ 0 次工具调用', async () => {
    const { provider, calls } = makeAgent({})
    await provider.evaluateTaskContext(makeContext(), 'd_1')
    expect(calls).toEqual([])
  })

  it('工具调用数硬上限 ≤3：计划再宽也截断', async () => {
    const ctx = makeContext({
      activity: { ...makeContext().activity, clipboardRefs: ['i1', 'i2'] },
      detail: { ...makeContext().detail, zone: 'new', confidence: 0.3 }
    })
    const { provider, calls } = makeAgent({ budget: 3 })
    await provider.evaluateTaskContext(ctx, 'd_1')
    expect(calls.length).toBeLessThanOrEqual(3)
  })

  it('search_clipboard 开关关 → 空结果行 + 拦截记录，不执行工具', async () => {
    // else 分支计划 = 记忆 + 活动 + 剪贴板；剪贴板一格被门拦。
    const ctx = makeContext({
      activity: { ...makeContext().activity, clipboardRefs: ['item_9'] },
      detail: { ...makeContext().detail, zone: 'high', confidence: 0.3 }
    })
    const policy: PrivacyPolicy = { ...DEFAULT_POLICY, clipboardAccess: false }
    const { provider, chat, blocks, calls } = makeAgent({ policy })
    await provider.evaluateTaskContext(ctx, 'd_1')
    // 剪贴板查询被门拦截：空结果行 + kind='privacy' 记录；其余工具照常。
    expect(calls.every((c) => c.tool !== 'search_clipboard')).toBe(true)
    const clipboardBlock = blocks.find((b) => b.access === 'clipboard')
    expect(clipboardBlock).toBeDefined()
    expect(clipboardBlock!.reason).toMatch(/clipboard access disabled/)
    const req = chat.mock.calls[0][0]
    expect(req.messages[1].content).toContain('0 hit(s) — (blocked by privacy policy)')
  })

  it('aiEnabled 关 → 跳过 LLM 与工具，算法兜底（AI 是增强不是依赖）', async () => {
    const ctx = makeContext({ detail: { ...makeContext().detail, zone: 'new', confidence: 0.3 }, candidates: [] })
    const { provider, chat, calls, blocks } = makeAgent({ policy: { ...DEFAULT_POLICY, aiEnabled: false } })
    const decision = await provider.evaluateTaskContext(ctx, 'd_1')
    expect(decision.decidedBy).toBe('algorithm')
    expect(decision.action).toBe('new')
    expect(chat).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(blocks[0].reason).toBe('ai disabled')
  })

  it('工具抛错 → recall 记空结果（预算照花），决策照常', async () => {
    const ctx = makeContext({ detail: { ...makeContext().detail, zone: 'new', confidence: 0.3 } })
    const failing: AgentToolSet = {
      searchTasks: async () => {
        throw new Error('db down')
      },
      searchMemories: async () => ({ count: 0, preview: '' }),
      searchActivities: async () => ({ count: 0, preview: '' }),
      searchClipboard: async () => ({ count: 0, preview: '' })
    }
    const { provider, recalls } = makeAgent({ tools: failing })
    const decision = await provider.evaluateTaskContext(ctx, 'd_1')
    expect(decision.action).toBe('continue')
    expect(recalls.some((r) => r.preview.includes('tool error'))).toBe(true)
  })

  it('无工具注入 → 纯预填决策（t55 行为），0 次工具调用', async () => {
    const ctx = makeContext({ detail: { ...makeContext().detail, zone: 'new', confidence: 0.3 } })
    const chat = vi.fn(async () => okResult({ action: 'ignore', reason: 'noise' }))
    const provider = createAgentDecisionProvider({
      getChat: () => chat,
      getPolicy: () => DEFAULT_POLICY,
      shouldUpgrade: (c) => shouldUpgradeToTools(c, 0.45)
    })
    const decision = await provider.evaluateTaskContext(ctx, 'd_1')
    expect(decision).toEqual({ action: 'ignore', reason: 'noise', decidedBy: 'agent' })
  })

  it('denied 应用不进入升级路径：查询串与 Tool results 均无被拒应用键（t56 评审）', async () => {
    // 活动 = code + Bank（被拒应用），Bank 窗口标题活跃；低置信 → 升级触发。
    const base = makeContext()
    const ctx: DecisionContext = {
      ...base,
      activity: {
        ...base.activity,
        apps: [
          { id: 'code.exe', name: 'code.exe', durationMs: 20_000, windows: ['VSCode - x.ts'] },
          { id: 'C:/Apps/Bank.exe', name: 'Bank', durationMs: 10_000, windows: ['statement.pdf'] }
        ]
      },
      detail: { ...base.detail, zone: 'high', confidence: 0.3, windowTitles: ['VSCode - x.ts', 'statement.pdf'] }
    }
    const policy: PrivacyPolicy = { ...DEFAULT_POLICY, deniedApps: ['c:/apps/bank.exe'] }
    const { provider, chat, calls, blocks } = makeAgent({ policy })
    await provider.evaluateTaskContext(ctx, 'd_1')
    // 预填门先剥离 Bank：拦截块记录，工具面照常执行（升级判定用门后 ctx）。
    expect(blocks.some((b) => b.appExePath === 'C:/Apps/Bank.exe')).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    const content = String(chat.mock.calls[0][0].messages[1].content)
    expect(content.toLowerCase()).not.toContain('bank')
    expect(content.toLowerCase()).not.toContain('statement.pdf')
  })
})

/* ------------------------------------------------------------------ */
/* t56: suggestTitle 迁入（ADR-0003 通道与触发条件不变）                */
/* ------------------------------------------------------------------ */

describe('suggestTitle (task:suggest-title, t56 迁入决策模块)', () => {
  const ctx = {
    title: 'draft',
    note: 'polish the CAD drawings',
    appNames: ['Code', 'Chrome'],
    resourcePreviews: ['report.md']
  }

  function makeSuggester(opts?: { memories?: Memory[]; chat?: (req: unknown) => Promise<ChatResult> }) {
    const chat =
      opts?.chat ?? (async () => okResult({ titles: ['Title'] }))
    const chatFn = vi.fn(chat)
    const suggester = createTitleSuggester({
      getChat: () => chatFn,
      readMemories: () => opts?.memories ?? [],
      log: () => {}
    })
    return { suggester, chat: chatFn }
  }

  it('returns 1-3 sanitized candidates when the chain succeeds', async () => {
    const { suggester, chat } = makeSuggester({
      chat: async () =>
        okResult({
          titles: [
            'Finish CAD drawings',
            '   ',
            'CAD polish',
            'CAD polish',
            'A very long title that exceeds the sixty character cap for a suggestion title and should be cut',
            'Extra'
          ]
        })
    })
    const titles = await suggester.suggestTitle(ctx)
    expect(titles).toEqual(['Finish CAD drawings', 'CAD polish', 'A very long title that exceeds the sixty character cap for a']) // 去空、去重、截断、上限 3
    const req = chat.mock.calls[0][0]
    expect(JSON.parse(req.messages[1].content.slice('Task: '.length))).toEqual({
      title: 'draft',
      note: 'polish the CAD drawings',
      appNames: ['Code', 'Chrome'],
      resourcePreviews: ['report.md']
    })
  })

  it('returns null without a provider', async () => {
    const suggester = createTitleSuggester({ getChat: () => null })
    expect(await suggester.suggestTitle(ctx)).toBeNull()
  })

  it('returns null when the chain reports failure', async () => {
    const { suggester } = makeSuggester({ chat: async () => failResult('all providers failed') })
    expect(await suggester.suggestTitle(ctx)).toBeNull()
  })

  it('returns null when the chain throws', async () => {
    const { suggester } = makeSuggester({
      chat: async () => {
        throw new Error('network down')
      }
    })
    expect(await suggester.suggestTitle(ctx)).toBeNull()
  })

  it('returns null when the reply fails validation', async () => {
    for (const parsed of [null, { nope: [] }, { titles: 'x' }, { titles: [] }, { titles: ['   '] }]) {
      const { suggester } = makeSuggester({ chat: async () => okResult(parsed) })
      expect(await suggester.suggestTitle(ctx)).toBeNull()
    }
  })

  it('omits empty draft fields from the request', async () => {
    const { suggester, chat } = makeSuggester({ chat: async () => okResult({ titles: ['Only app names'] }) })
    const titles = await suggester.suggestTitle({ title: '', note: '  ', appNames: ['Code'], resourcePreviews: [] })
    expect(titles).toEqual(['Only app names'])
    const req = chat.mock.calls[0][0]
    expect(JSON.parse(req.messages[1].content.slice('Task: '.length))).toEqual({ appNames: ['Code'] })
  })

  it('injects confirmed project/workflow memories overlapping the draft as memoryContext (ADR-0003)', async () => {
    const memories: Memory[] = [
      { id: 'm1', type: 'project', content: 'CAD drawings', userState: 'confirmed', confidence: 1, hitCount: 2, lastSeenAt: 1, createdAt: 1, source: 'user' },
      { id: 'm2', type: 'tool', content: 'Chrome', userState: 'confirmed', confidence: 1, hitCount: 1, lastSeenAt: 1, createdAt: 1, source: 'user' },
      { id: 'm3', type: 'project', content: 'polish the CAD drawings', userState: 'suggested', confidence: 1, hitCount: 1, lastSeenAt: 1, createdAt: 1, source: 'ai-suggest' }
    ]
    const { suggester, chat } = makeSuggester({ memories })
    await suggester.suggestTitle({ title: '', note: 'polish the CAD drawings', appNames: ['Code'], resourcePreviews: [] })
    const payload = JSON.parse(chat.mock.calls[0][0].messages[1].content.slice('Task: '.length))
    // 'CAD drawings' sits inside the draft note (memory → text direction); m2
    // is a tool (never injected), m3 is not user-confirmed (never injected).
    expect(payload.memoryContext).toEqual(['CAD drawings'])
  })

  it('omits memoryContext when no memory overlaps the draft', async () => {
    const memories: Memory[] = [
      { id: 'm1', type: 'project', content: 'CAD Agent', userState: 'confirmed', confidence: 1, hitCount: 1, lastSeenAt: 1, createdAt: 1, source: 'user' }
    ]
    const { suggester, chat } = makeSuggester({ memories })
    await suggester.suggestTitle({ title: 'Tax filing', note: '', appNames: ['Excel'], resourcePreviews: [] })
    const payload = JSON.parse(chat.mock.calls[0][0].messages[1].content.slice('Task: '.length))
    expect(payload.memoryContext).toBeUndefined()
  })
})
