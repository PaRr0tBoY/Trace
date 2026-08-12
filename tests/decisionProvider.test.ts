/**
 * 决策者三实现一致性测试（t55，spec Testing Decisions 决策者替换用例）。
 *
 * 同一 DecisionContext 下 agent / 算法 / 本地模型（fake）产出一致结构
 * （合法 TaskDecision 判别联合）；本地模型失败 / 关闭 → 算法候选原样传递
 * （不变量 H）；agent 无 AI 配置 / 回复非法 → 算法兜底（AI 是增强不是依赖）。
 */
import { describe, expect, it } from 'vitest'

import type { ChatResult } from '../electron/main/provider'
import type { CandidateActivity } from '../shared/types'
import {
  createAgentDecisionProvider,
  createAlgorithmDecisionProvider,
  createLocalModelDecisionProvider,
  parseTaskDecision
} from '../electron/store/decisionProvider'
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
