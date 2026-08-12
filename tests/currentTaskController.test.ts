/**
 * CurrentTaskController 主 seam 测试（t55，spec Testing Decisions 主 seam 用例）。
 *
 * 组装真实 TaskStore（内存会话）+ 注入决策者 / trace / 时钟后调用
 * `observe(activity, detail)`，只断言外部可观察行为：门控调用次数、六触发、
 * 滞回（threshold + margin + dwell）、切换原子性、PAUSED 免疫、trace 记录。
 * 时间敏感逻辑全部注入时钟（tick），不 sleep。
 */
import { describe, expect, it } from 'vitest'

import { TaskStore, type TaskIndex } from '../electron/store/TaskStore'
import { createMemorySessionStore } from '../electron/store/sessionStore'
import { createMemoryTraceStore, type TraceStore } from '../electron/store/traceStore'
import {
  createCurrentTaskController,
  type CurrentTaskController,
  type DecisionContext,
  type SwitchParams,
  type TaskDecision,
  type TaskDecisionProvider
} from '../electron/store/currentTaskController'
import { createAlgorithmDecisionProvider } from '../electron/store/decisionProvider'
import type { Activity, ActivityDetail } from '../electron/store/activityLedger'

const BASE_PARAMS: SwitchParams = {
  switchDwellSeconds: 45,
  switchMargin: 0.1,
  confidenceHigh: 0.7,
  confidenceLow: 0.45,
  idleResumeMs: 15 * 60_000
}

/** 构造一次观察的活动 + 详情（契约形状直接构造，不跑聚类）。 */
function activityOf(opts: {
  apps?: string[]
  zone: 'high' | 'low' | 'new'
  confidence: number
  margin?: number
  attribution?: { taskId: string; confidence: number }
  overlappingTasks?: string[]
  windowTitles?: string[]
}): { activity: Activity; detail: ActivityDetail } {
  const startAt = 1_000_000
  const appNames = opts.apps ?? ['code.exe']
  const activity: Activity = {
    id: 'act_1',
    startAt,
    endAt: startAt + 30_000,
    apps: appNames.map((name) => ({ id: name, name, durationMs: 30_000, windows: opts.windowTitles ?? [] })),
    clipboardRefs: [],
    ...(opts.attribution ? { attribution: opts.attribution } : {}),
    signature: 'sig',
    classifierVersion: 'clusterer@1'
  }
  const detail: ActivityDetail = {
    zone: opts.zone,
    confidence: opts.confidence,
    windowTitles: opts.windowTitles ?? [],
    evidence: {
      appCombination: appNames.slice(0, 5).join(', '),
      durationMs: 30_000,
      overlappingTasks: opts.overlappingTasks ?? [],
      margin: opts.margin ?? 0.3
    }
  }
  return { activity, detail }
}

interface Harness {
  store: TaskStore
  controller: CurrentTaskController
  calls: DecisionContext[]
  trace: TraceStore
  tick: (ms: number) => void
  now: () => number
  decide: (d: TaskDecision) => void
}

/** 主 seam 测试 harness：真实 TaskStore（注入时钟）+ 注入决策者 / trace。 */
function makeHarness(opts?: {
  params?: Partial<SwitchParams>
  provider?: TaskDecisionProvider
  readMemories?: (activity: Activity) => { content: string; reasons: string[]; hops: number }[]
}): Harness {
  let saved: TaskIndex | null = null
  let now = 1_000_000
  const store = new TaskStore({
    load: () => saved,
    save: (index) => { saved = index },
    now: () => now,
    sessionStore: createMemorySessionStore()
  })
  store.load()
  const calls: DecisionContext[] = []
  let scripted: TaskDecision | null = null
  const record = (inner: TaskDecisionProvider): TaskDecisionProvider => ({
    id: inner.id,
    async evaluateTaskContext(ctx) {
      calls.push(ctx)
      return inner.evaluateTaskContext(ctx)
    }
  })
  const provider: TaskDecisionProvider = opts?.provider
    ? record(opts.provider)
    : record({
        id: 'test',
        async evaluateTaskContext(ctx) {
          if (scripted) return scripted
          return { action: 'continue', taskId: ctx.currentTask?.id ?? '', confidence: ctx.detail.confidence, reason: 'test' }
        }
      })
  const trace = createMemoryTraceStore()
  const controller = createCurrentTaskController({
    taskStore: store,
    decide: provider,
    trace,
    getParams: () => ({ ...BASE_PARAMS, ...opts?.params }),
    now: () => now,
    readMemories: opts?.readMemories
  })
  return {
    store,
    controller,
    calls,
    trace,
    tick: (ms: number) => { now += ms },
    now: () => now,
    decide: (d: TaskDecision) => { scripted = d }
  }
}

function runningIds(store: TaskStore): string[] {
  return store.list().filter((t) => t.status === 'running').map((t) => t.id)
}

function attributed(zone: 'high' | 'low', confidence: number, taskId: string, margin = 0.3) {
  return activityOf({ zone, confidence, margin, attribution: { taskId, confidence } })
}

describe('CurrentTaskController — 门控（99% 不变量 E）', () => {
  it('稳定连续活动 → 决策者 0 次调用', async () => {
    const { store, controller, calls } = makeHarness()
    const a = store.create('A', { apps: [{ id: 'code.exe', name: 'code.exe' }] })!
    for (let i = 0; i < 5; i++) {
      const outcome = await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
      expect(outcome.triggers).toEqual([])
      expect(outcome.decisionCalls).toBe(0)
      expect(outcome.action).toBe('noop')
    }
    expect(calls).toHaveLength(0)
  })

  it('稳定低置信归属（zone low，winner == running）也 0 次调用', async () => {
    const { store, controller, calls } = makeHarness()
    const a = store.create('A')!
    for (let i = 0; i < 3; i++) {
      await controller.observe(...Object.values(attributed('low', 0.55, a.id)))
    }
    expect(calls).toHaveLength(0)
  })

  it('分数跌破阈值 → 恰好 1 次决策调用', async () => {
    const { store, controller, tick, calls, trace } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    const a = store.create('A')!
    // 稳态高置信。
    await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
    // 跌破阈值（zone new，无归属）→ 窗口开启，dwell 未满不调用。
    const drop = activityOf({ zone: 'new', confidence: 0.3 })
    const first = await controller.observe(drop.activity, drop.detail)
    expect(first.triggers).toEqual(['score-drop', 'new-cluster'])
    expect(first.decisionCalls).toBe(0)
    expect(controller.candidateSince()).not.toBeNull()
    // dwell 满后再次观察（仍低）→ 恰好 1 次调用。
    tick(46_000)
    const second = await controller.observe(drop.activity, drop.detail)
    expect(second.triggers).toContain('new-cluster')
    expect(second.decisionCalls).toBe(1)
    expect(second.action).toBe('new')
    expect(second.decision?.action).toBe('new')
    expect(calls).toHaveLength(1)
    // 同候选不重复开窗：再观察仍 0 次。
    const third = await controller.observe(drop.activity, drop.detail)
    expect(third.decisionCalls).toBe(0)
    // trace：observed + decision 同链（不变量 I）。
    const chain = trace.listByDecisionId(second.decisionId!)
    expect(chain.map((r) => r.kind).sort()).toEqual(['decision', 'observed'])
    const decisionRow = chain.find((r) => r.kind === 'decision')!
    expect(decisionRow.payload.action).toBe('new')
    expect(decisionRow.payload.title).toMatch(/task$/)
    // 实际执行者盖章（算法路径 → algorithm；包装链降级透传内层）。
    expect(decisionRow.payload.decidedBy).toBe('algorithm')
  })

  it('跌破阈值后候选未持续满 dwell 即恢复 → 0 次调用（短时离开不误判）', async () => {
    const { store, controller, tick, calls } = makeHarness()
    const a = store.create('A')!
    await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
    const drop = activityOf({ zone: 'new', confidence: 0.3 })
    await controller.observe(drop.activity, drop.detail)
    tick(10_000) // dwell 未满
    await controller.observe(...Object.values(attributed('high', 0.85, a.id))) // 恢复稳态 → 窗口关闭
    expect(calls).toHaveLength(0)
  })
})

describe('CurrentTaskController — 滞回（threshold + margin + dwell）', () => {
  it('候选持续不足 30-60s 不切换；dwell + margin + threshold 全满足才 switch', async () => {
    const { store, controller, tick, trace } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    const b = store.create('B')!
    const a = store.create('A', { apps: [{ id: 'code.exe', name: 'code.exe' }] })!
    expect(runningIds(store)).toEqual([a.id])
    const obs = () => attributed('high', 0.8, b.id)

    // t=0：候选超当前 → 触发，dwell 未满 → 0 调用、不切换。
    const first = await controller.observe(...Object.values(obs()))
    expect(first.triggers).toEqual(['candidate-ahead'])
    expect(first.decisionCalls).toBe(0)
    expect(controller.candidateSince()).not.toBeNull()
    expect(runningIds(store)).toEqual([a.id])

    // t=+9s：仍不足 dwell → 不切换。
    tick(9_000)
    const mid = await controller.observe(...Object.values(obs()))
    expect(mid.decisionCalls).toBe(0)
    expect(runningIds(store)).toEqual([a.id])

    // t=+46s：dwell 满 → 调用 + 切换原子完成。
    tick(37_000)
    const late = await controller.observe(...Object.values(obs()))
    expect(late.decisionCalls).toBe(1)
    expect(late.action).toBe('switch')
    expect(late.switchedTo).toBe(b.id)
    expect(runningIds(store)).toEqual([b.id])

    // 原子性：旧会话 settle + 新会话 open + 状态迁移一次完成。
    expect(store.get(a.id)!.status).toBe('waiting')
    expect(store.get(a.id)!.statusReason).toBe('auto_switch')
    const aSessions = store.toDto().find((d) => d.id === a.id)!.sessions
    expect(aSessions.length).toBeGreaterThan(0)
    expect(aSessions[0].endedAt).toBeDefined()
    expect(aSessions[0].transitionReason).toBe('auto_switch')
    const bSession = store.openSessionFor(b.id)
    expect(bSession).toBeDefined()
    expect(bSession!.endedAt).toBeUndefined()
    expect(bSession!.previousTaskId).toBe(a.id)
    // 不变量：runningTaskCount ≤ 1。
    expect(runningIds(store)).toHaveLength(1)
    // trace：switch 决策链完整；已执行 switch 随任务活（taskId 落行）。
    const chain = trace.listByDecisionId(late.decisionId!)
    expect(chain.map((r) => r.kind).sort()).toEqual(['decision', 'observed'])
    const decisionRow = chain.find((r) => r.kind === 'decision')!
    expect(decisionRow.payload).toMatchObject({ action: 'switch', targetTaskId: b.id })
    expect(decisionRow.taskId).toBe(b.id)
  })

  it('margin 不达标（evidence margin < switchMargin）→ 不构成候选触发、不开窗（MINOR-1）', async () => {
    const { store, controller, calls } = makeHarness({
      provider: createAlgorithmDecisionProvider(),
      params: { switchMargin: 0.4 }
    })
    const b = store.create('B')!
    const a = store.create('A')!
    const obs = () => attributed('high', 0.8, b.id, 0.3) // evidence margin 0.3 < 0.4
    const first = await controller.observe(...Object.values(obs()))
    expect(first.triggers).toEqual([])
    expect(first.decisionCalls).toBe(0)
    expect(controller.candidateSince()).toBeNull()
    expect(runningIds(store)).toEqual([a.id])
    expect(calls).toHaveLength(0)
  })

  it('margin 门拒绝：switch 到运行中任务（差为 0）→ 拒绝、不切换、不落定', async () => {
    const { store, controller, tick, decide } = makeHarness({ params: { switchMargin: 0.1 } })
    const a = store.create('A')!
    decide({ action: 'switch', fromTaskId: '', toTaskId: a.id, confidence: 0.8, reason: 'x', evidence: [] })
    const obs = activityOf({ zone: 'new', confidence: 0.3 })
    await controller.observe(obs.activity, obs.detail)
    tick(46_000)
    const late = await controller.observe(obs.activity, obs.detail)
    expect(late.decisionCalls).toBe(1)
    expect(late.decision?.action).toBe('switch')
    expect(late.action).toBe('noop')
    expect(late.rejected).toMatch(/margin not met/)
    expect(late.settled).toBe(false)
    expect(runningIds(store)).toEqual([a.id])
  })

  it('门拒绝不落定：证据改善后同候选可重开窗并切换（MINOR-2）', async () => {
    const { store, controller, tick, decide, calls } = makeHarness()
    const b = store.create('B')!
    const a = store.create('A')!
    const obs = () => attributed('high', 0.6, b.id) // 0.6 ≥ θ_low 0.45 → 候选触发
    await controller.observe(...Object.values(obs()))
    // 第一次成熟：决策者给出低置信 switch → 阈值门拒绝。
    decide({ action: 'switch', fromTaskId: a.id, toTaskId: b.id, confidence: 0.3, reason: 'x', evidence: [] })
    tick(46_000)
    const first = await controller.observe(...Object.values(obs()))
    expect(first.decisionCalls).toBe(1)
    expect(first.action).toBe('noop')
    expect(first.rejected).toMatch(/threshold/)
    expect(first.settled).toBe(false)
    expect(runningIds(store)).toEqual([a.id])
    // 门拒绝不设 lastDecidedKey → 同候选证据改善（信心恢复）→ 重开窗并切换。
    decide({ action: 'switch', fromTaskId: a.id, toTaskId: b.id, confidence: 0.7, reason: 'x', evidence: [] })
    tick(46_000)
    const rearmed = await controller.observe(...Object.values(obs()))
    expect(rearmed.decisionCalls).toBe(0) // 重开窗，dwell 未满
    expect(rearmed.action).toBe('noop')
    expect(controller.candidateSince()).not.toBeNull()
    tick(46_000)
    const second = await controller.observe(...Object.values(obs()))
    expect(second.decisionCalls).toBe(1)
    expect(second.action).toBe('switch')
    expect(second.switchedTo).toBe(b.id)
    expect(runningIds(store)).toEqual([b.id])
    expect(calls).toHaveLength(2)
  })

  it('threshold 不满足（候选低于 θ_low）→ 不构成候选触发、不切换', async () => {
    const { store, controller, calls } = makeHarness({
      provider: createAlgorithmDecisionProvider(),
      params: { confidenceLow: 0.8 }
    })
    const b = store.create('B')!
    const a = store.create('A')!
    const outcome = await controller.observe(...Object.values(attributed('low', 0.6, b.id)))
    expect(outcome.triggers).toEqual([])
    expect(outcome.decisionCalls).toBe(0)
    expect(runningIds(store)).toEqual([a.id])
    expect(calls).toHaveLength(0)
  })
})

describe('CurrentTaskController — 六触发各自触发路径', () => {
  it('新语义簇：持续满 dwell 后产出 new 提案，不改状态', async () => {
    const { store, controller, tick, calls } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    const a = store.create('A')!
    const obs = () => activityOf({ zone: 'new', confidence: 0.3, apps: ['figma.exe'] })
    const first = await controller.observe(...Object.values(obs()))
    expect(first.triggers).toEqual(['new-cluster'])
    expect(first.decisionCalls).toBe(0)
    tick(46_000)
    const matured = await controller.observe(...Object.values(obs()))
    expect(matured.triggers).toContain('new-cluster')
    expect(matured.decisionCalls).toBe(1)
    expect(matured.action).toBe('new')
    expect(matured.decision?.title).toContain('figma.exe')
    expect(runningIds(store)).toEqual([a.id]) // 提案不改状态
    expect(calls).toHaveLength(1)
  })

  it('多任务竞争（≥2 overlapping）→ 升级路径（调用决策者）', async () => {
    const { store, controller, tick, calls } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    const a = store.create('A')!
    const obs = () =>
      activityOf({
        zone: 'high',
        confidence: 0.8,
        margin: 0.3,
        attribution: { taskId: a.id, confidence: 0.8 },
        overlappingTasks: ['B', 'C']
      })
    const first = await controller.observe(...Object.values(obs()))
    expect(first.triggers).toEqual(['competition'])
    expect(first.decisionCalls).toBe(0)
    tick(46_000)
    const matured = await controller.observe(...Object.values(obs()))
    expect(matured.triggers).toContain('competition')
    expect(matured.decisionCalls).toBe(1)
    expect(matured.decision?.action).toBe('continue') // winner == running → 算法判继续
    expect(calls).toHaveLength(1)
  })

  it('会话边界：运行中任务在控制器外改变 → 立即调用（无需 dwell），但 switch 意图被抑制', async () => {
    const { store, controller } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    const a = store.create('A')!
    await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
    // 用户手动暂停当前任务（控制器外路径）。
    store.update(a.id, { status: 'paused' })
    const outcome = await controller.observe(...Object.values(attributed('high', 0.8, a.id)))
    expect(outcome.triggers).toContain('session-boundary')
    expect(outcome.decisionCalls).toBe(1) // 立即调用，不等 dwell
    // 边界只重同步：算法意图 switch→A 被抑制（用户操作优先），A 保持 PAUSED。
    expect(outcome.decision?.action).toBe('switch')
    expect(outcome.action).toBe('noop')
    expect(outcome.rejected).toMatch(/boundary/)
    expect(store.get(a.id)!.status).toBe('paused')
  })

  it('用户显式切换不被会话边界撤销（MAJOR-1）', async () => {
    const { store, controller } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    const b = store.create('B')!
    const a = store.create('A')!
    expect(runningIds(store)).toEqual([a.id])
    // 控制器稳态跟踪 A。
    await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
    // 用户显式切到 B（域外路径）：B waiting→running，A running→waiting。
    store.update(b.id, { status: 'running' })
    expect(runningIds(store)).toEqual([b.id])
    // 下一趟第一段是切换前残留的 A 活动 → 边界；算法意图 switch→A → 抑制。
    const outcome = await controller.observe(...Object.values(attributed('high', 0.8, a.id)))
    expect(outcome.triggers).toContain('session-boundary')
    expect(outcome.decisionCalls).toBe(1)
    expect(outcome.action).toBe('noop')
    expect(outcome.rejected).toMatch(/boundary/)
    expect(runningIds(store)).toEqual([b.id]) // 用户切换保持
    expect(store.get(a.id)!.status).toBe('waiting')
    // 候选驱动同现 → 窗口已为 A 开启；稳态 B 活动 → 窗口关闭，不打扰。
    expect(controller.candidateSince()).not.toBeNull()
    await controller.observe(...Object.values(attributed('high', 0.85, b.id)))
    expect(controller.candidateSince()).toBeNull()
    expect(runningIds(store)).toEqual([b.id])
  })

  it('边界后持久候选领先 → 候选路径（dwell 保护）完成切换（MAJOR-1）', async () => {
    const { store, controller, tick } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    const b = store.create('B')!
    const a = store.create('A')!
    await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
    store.update(b.id, { status: 'running' })
    // 残留 A 活动：边界抑制立即 switch，窗口开启。
    const residue = await controller.observe(...Object.values(attributed('high', 0.8, a.id)))
    expect(residue.action).toBe('noop')
    expect(controller.candidateSince()).not.toBeNull()
    // A 证据持续领先 → dwell 成熟 → 候选路径完成切换。
    tick(46_000)
    const late = await controller.observe(...Object.values(attributed('high', 0.8, a.id)))
    expect(late.decisionCalls).toBe(1)
    expect(late.action).toBe('switch')
    expect(late.switchedTo).toBe(a.id)
    expect(runningIds(store)).toEqual([a.id])
  })

  it('长 idle 恢复：观察间隔 ≥ idleResumeMs → 立即调用', async () => {
    const { store, controller, tick, calls } = makeHarness()
    const a = store.create('A')!
    await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
    expect(calls).toHaveLength(0)
    tick(16 * 60_000) // > idleResumeMs (15min)
    const outcome = await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
    expect(outcome.triggers).toEqual(['idle-resume'])
    expect(outcome.decisionCalls).toBe(1)
  })
})

describe('CurrentTaskController — 切换原子性与域层约束', () => {
  it('PAUSED 免疫：决策说 switch 到 PAUSED 任务 → 被域层拒绝', async () => {
    const { store, controller, tick, trace } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    const p = store.create('P')!
    store.update(p.id, { status: 'paused' }) // 用户手动暂停（P 从 RUNNING 暂停）
    const a = store.create('A')! // A 成为 RUNNING
    expect(runningIds(store)).toEqual([a.id])
    expect(store.get(p.id)!.status).toBe('paused')
    const obs = () => attributed('high', 0.8, p.id)
    await controller.observe(...Object.values(obs()))
    tick(46_000)
    const late = await controller.observe(...Object.values(obs()))
    expect(late.decisionCalls).toBe(1)
    expect(late.decision?.action).toBe('switch')
    expect(late.action).toBe('noop')
    expect(late.rejected).toMatch(/PAUSED|domain/)
    expect(runningIds(store)).toEqual([a.id]) // 运行中任务不变
    expect(store.get(p.id)!.status).toBe('paused')
    // 决策仍全量入 trace（可追溯，不变量 I）。
    const chain = trace.listByDecisionId(late.decisionId!)
    expect(chain.some((r) => r.kind === 'decision' && r.payload.action === 'switch')).toBe(true)
  })

  it('switch 到不存在的任务 → 域层拒绝、状态不变', async () => {
    const missingProvider: TaskDecisionProvider = {
      id: 'test',
      async evaluateTaskContext(): Promise<TaskDecision> {
        return { action: 'switch', fromTaskId: '', toTaskId: 't_missing', confidence: 0.9, reason: 'x', evidence: [] }
      }
    }
    const { store, controller, tick } = makeHarness({ provider: missingProvider })
    const a = store.create('A')!
    const obs = activityOf({ zone: 'new', confidence: 0.3 })
    await controller.observe(obs.activity, obs.detail)
    tick(46_000)
    const late = await controller.observe(obs.activity, obs.detail)
    expect(late.decisionCalls).toBe(1)
    expect(late.action).toBe('noop')
    expect(late.rejected).toMatch(/domain/)
    expect(runningIds(store)).toEqual([a.id])
  })

  it('runningTaskCount ≤ 1 在切换后仍成立', async () => {
    const { store, controller, tick } = makeHarness({ provider: createAlgorithmDecisionProvider() })
    store.create('C')!
    const b = store.create('B')!
    store.create('A')!
    const obs = () => attributed('high', 0.8, b.id)
    await controller.observe(...Object.values(obs()))
    tick(46_000)
    const switched = await controller.observe(...Object.values(obs()))
    expect(switched.action).toBe('switch')
    expect(runningIds(store)).toHaveLength(1)
  })
})

describe('CurrentTaskController — 决策上下文与 trace', () => {
  it('决策上下文携带最小预填：当前任务 / 会话 / 候选 / 已匹配记忆', async () => {
    const memories = () => [{ content: '用户在做 CAD Agent', reasons: ['activity'], hops: 0 }]
    const { store, controller, tick, calls, now } = makeHarness({ readMemories: memories })
    const b = store.create('B')!
    const a = store.create('A')!
    const obs = () =>
      activityOf({
        zone: 'high',
        confidence: 0.8,
        margin: 0.3,
        attribution: { taskId: b.id, confidence: 0.8 },
        windowTitles: ['VSCode - controller.ts']
      })
    await controller.observe(...Object.values(obs()))
    tick(46_000)
    const late = await controller.observe(...Object.values(obs()))
    expect(late.decisionCalls).toBe(1)
    const ctx = calls[0]
    expect(ctx.currentTask).toMatchObject({ id: a.id, status: 'running' })
    expect(ctx.currentSession?.taskId).toBe(a.id)
    expect(ctx.candidates).toHaveLength(1)
    expect(ctx.candidates[0]).toMatchObject({ taskId: b.id, zone: 'high', confidence: 0.8 })
    expect(ctx.matchedMemories).toEqual([{ content: '用户在做 CAD Agent', reasons: ['activity'], hops: 0 }])
    expect(ctx.now).toBe(now())
  })

  it('边界触发的 continue 决策也全部入 trace', async () => {
    const { store, controller, trace } = makeHarness()
    const a = store.create('A')!
    await controller.observe(...Object.values(attributed('high', 0.85, a.id)))
    store.update(a.id, { status: 'paused' })
    const outcome = await controller.observe(...Object.values(attributed('high', 0.8, a.id)))
    expect(outcome.decisionCalls).toBe(1)
    const chain = trace.listByDecisionId(outcome.decisionId!)
    expect(chain.map((r) => r.kind).sort()).toEqual(['decision', 'observed'])
    expect(chain.find((r) => r.kind === 'decision')!.payload.action).toBe('continue')
  })
})
