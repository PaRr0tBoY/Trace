/**
 * CurrentTaskController — the main seam of the decision layer (t55, spec
 * 实现决策 5).
 *
 * 位置：聚类（ActivityLedger）与任务域（TaskStore）之间。`observe(activity,
 * detail)` 是主测试 seam：组装真实 stores（TaskStore / TraceStore / 注入决策
 * 者）后调用，断言输出。
 *
 * Task Change Detector（确定性、免费）六触发门控决策调用：
 *   1. score-drop       候选分数跌破阈值（上一观察 ≥ θ_low，本观察 < θ_low）
 *   2. candidate-ahead  候选超当前 + margin（归属任务 ≠ 运行中任务）
 *   3. new-cluster      新语义簇（zone 'new'，无归属）
 *   4. idle-resume      长 idle 后恢复（观察间隔 ≥ idleResumeMs）
 *   5. competition      多任务竞争（≥2 个任务共享应用集）
 *   6. session-boundary 会话边界（运行中任务在控制器外被改变）
 * 其余 observe 直接继续——99% 普通状态 0 次决策调用（不变量 E）。
 *
 * 滞回（切换判定 = threshold + margin + dwell 三者满足）：
 *   - dwell：候选持续 ≥ switchDwellSeconds（设置，30-60s）
 *   - margin：分数差 ≥ switchMargin（设置）
 *   - threshold：候选置信度 ≥ θ_low（zone 非 new）
 * 候选驱动的触发（1/2/3/5）走统一 pending 窗口：窗口开启（变化沿）→ 候选
 * 持续满 dwell 后恰好调用决策者 1 次 → 应用。观察恢复稳态（无任何触发）则
 * 窗口未成熟即关闭，0 次调用——短时离开不误判、不花 LLM。
 * 一次性触发（4/6）是离散事件：检测到即调用（无需 dwell），switch 仍受
 * threshold + margin 约束。
 *
 * 切换原子：复用 TaskStore.transition(to, 'running', 'system') —— 旧会话
 * settle + 新会话 open + 状态迁移一次完成；PAUSED 免疫（决策说 switch 到
 * PAUSED 任务被域层拒绝）；runningTaskCount ≤ 1 由域层强制。
 *
 * 决策者可替换：agent / 算法 / 本地模型（decisionProvider.ts）实现同一接口
 * （TaskDecisionProvider），控制器不感知谁在做。决策结果全部追加 trace
 * （kind 'observed' + 'decision'，共享 decisionId，不变量 I）。
 *
 * 纯逻辑：零 Electron import；时钟 / 决策者 / trace / 参数全部注入。
 */
import { createId } from './ids'
import type { Activity, ActivityDetail, ConfidenceZone } from './activityLedger'
import type { TraceStore, TraceInput } from './traceStore'
import type { StatusSource, Task, TaskSession, TaskStatus } from '../../shared/types'

/** Spec 决策 6 — decision protocol（判别联合，决策者公共输出契约）。
 * `decidedBy` 是客户端元数据（不在模型回复 schema 内）：实际执行决策的
 * 决策者 id（包装链降级时透传内层），供 trace 审计——agentVersion 只标识
 * 链入口，decidedBy 标识真正做出判断的那一层。
 */
export type TaskDecision = (
  | { action: 'continue'; taskId: string; confidence: number; reason: string }
  | { action: 'switch'; fromTaskId: string; toTaskId: string; confidence: number; reason: string; evidence: string[] }
  | { action: 'new'; title: string; confidence: number; reason: string; apps: string[]; evidence: string[] }
  | { action: 'merge'; fromTaskId: string; toTaskId: string; confidence: number; reason: string }
  | { action: 'ignore'; reason: string }
) & { decidedBy?: string }

/** Task Change Detector 六触发（spec 决策 5）。 */
export type TriggerKind =
  | 'score-drop'
  | 'candidate-ahead'
  | 'new-cluster'
  | 'idle-resume'
  | 'competition'
  | 'session-boundary'

/** 一个确定性候选（决策上下文用；≤3，来自归属 + 池内任务）。 */
export interface TaskCandidate {
  taskId: string
  title: string
  confidence: number
  zone: ConfidenceZone
  margin: number
  evidence: string[]
}

/** 画像预填（spec 决策 10 显式画像；设置页字段接入前为空对象）。 */
export interface ProfileInfo {
  occupation?: string
  bio?: string
}

/** 已匹配记忆（t50 确定性预筛结果，非 Top-K）；由预填方组装。 */
export interface MatchedMemory {
  content: string
  reasons: string[]
  hops: number
}

/**
 * 最小预填（spec 决策 6 雏形；t56 扩展整体过隐私门 + 工具升级路径）：
 * 当前活动 + 当前任务会话 + ≤3 确定性候选 + 已匹配记忆 + 画像。
 */
export interface DecisionContext {
  activity: Activity
  detail: ActivityDetail
  currentTask: { id: string; title: string; status: TaskStatus } | null
  currentSession: TaskSession | null
  candidates: TaskCandidate[]
  matchedMemories: MatchedMemory[]
  profile: ProfileInfo
  /** 本次决策调用时刻（注入时钟）。 */
  now: number
}

/** 决策者公共接口 —— 控制器不感知谁在做（agent / 算法 / 本地模型）。 */
export interface TaskDecisionProvider {
  /** 决策者标识（trace agentVersion 与诊断用）：'algorithm' | 'agent' | 'local-model' | … */
  readonly id: string
  evaluateTaskContext(ctx: DecisionContext): Promise<TaskDecision>
}

/** 控制器读 TaskStore 的端口（窄接口；TaskStore 本身满足）。 */
export interface CurrentTaskPort {
  list(): readonly Task[]
  /** 域层迁移缝：系统路径 running→waiting / waiting→running；PAUSED 免疫。 */
  transition(id: string, to: TaskStatus, source: StatusSource): boolean
  openSessionFor(taskId: string): TaskSession | undefined
}

/** 滞回与门控参数（生产 = Settings 投影，见 state.ts 接线）。 */
export interface SwitchParams {
  /** 候选持续秒数（30-60）。 */
  switchDwellSeconds: number
  /** 分数差下限（0-1）。 */
  switchMargin: number
  confidenceHigh: number
  confidenceLow: number
  /** 长 idle 窗口 ms（生产 = taskPauseThresholdMinutes × 60_000）。 */
  idleResumeMs: number
}

export interface CurrentTaskControllerOptions {
  taskStore: CurrentTaskPort
  decide: TaskDecisionProvider
  /** trace 落点；null = DB 降级，决策照常但不记录。 */
  trace?: TraceStore | null
  getParams: () => SwitchParams
  now?: () => number
  createDecisionId?: () => string
  /** 已匹配记忆预筛（t50 retrieveMemories 的消费方组装）；缺省 = 空。 */
  readMemories?: (activity: Activity) => MatchedMemory[]
}

/** 一次 observe 的对外输出（主 seam 断言面）。 */
export interface ControllerOutcome {
  /** 本次观察触发的六触发（空 = 门控通过，稳态）。 */
  triggers: TriggerKind[]
  /** 本次观察对决策者的调用次数（99% 稳态 = 0）。 */
  decisionCalls: number
  /** 生效动作：switch = 状态机已切换；new/merge/ignore = 提案/记录路径（t56）；noop = 无状态变更。 */
  action: 'switch' | 'new' | 'merge' | 'ignore' | 'continue' | 'noop'
  /** 决策者原始输出（未调用 = undefined）。 */
  decision?: TaskDecision
  /** 本条决策链 trace 分组 id（未调用 = undefined）。 */
  decisionId?: string
  /** switch 成功执行后的新 RUNNING 任务。 */
  switchedTo?: string
  /** 决策被滞回 / 域层拒绝的原因（未拒绝 = undefined）。 */
  rejected?: string
  /**
   * 决策是否已“落定”（continue/new/merge/ignore 已记录、switch 已执行、或
   * 域层拒绝）。门拒绝（threshold/margin/dwell）→ false：证据改善可重开窗。
   */
  settled?: boolean
}

/** 切换判定：threshold + margin + dwell 三者满足才执行。 */
function switchHysteresisOk(
  candidate: { taskId: string | null; confidence: number },
  running: Task | null,
  detail: ActivityDetail,
  params: SwitchParams,
  dwellElapsed: boolean
): { ok: boolean; reason?: string } {
  if (!candidate.taskId) return { ok: false, reason: 'no attributed candidate' }
  // threshold：候选置信度 ≥ θ_low（zone 非 new 的归属候选）。
  if (candidate.confidence < params.confidenceLow) {
    return { ok: false, reason: `threshold not met (${candidate.confidence.toFixed(2)} < ${params.confidenceLow})` }
  }
  // margin：分数差 ≥ switchMargin。运行中任务胜出 → 差为 0；否则运行任务的
  // 分数 ≤ 次优 = best − 聚类边距（保守下界），差 ≥ min(best, 聚类边距)。
  const currentScore =
    running && running.id === candidate.taskId ? candidate.confidence : Math.max(0, candidate.confidence - detail.evidence.margin)
  if (candidate.confidence - currentScore < params.switchMargin) {
    return { ok: false, reason: `margin not met (${(candidate.confidence - currentScore).toFixed(2)} < ${params.switchMargin})` }
  }
  if (!dwellElapsed) return { ok: false, reason: 'dwell not elapsed' }
  return { ok: true }
}

/** 控制器内部 pending 窗口：候选驱动触发开启，成熟后恰好一次决策调用。 */
interface PendingWindow {
  /** 窗口身份 = 候选身份（归属任务 id 或 'new'）。 */
  key: string
  /** 窗口开启时刻（spec 内部状态 candidateSince）。 */
  since: number
}

/** 控制器对外形状（observe 主 seam + spec 内部状态访问器）。 */
export interface CurrentTaskController {
  /** 主 seam：观察一个活动（ledger.analyze 之后），返回门控 / 决策 / 应用结果。 */
  observe(activity: Activity, detail: ActivityDetail): Promise<ControllerOutcome>
  /** 当前跟踪的 RUNNING 任务 id（spec 内部状态；测试与诊断）。 */
  currentTaskId(): string | null
  /** 当前跟踪的会话 id（spec 内部状态；测试与诊断）。 */
  currentSessionId(): string | null
  /** 候选窗口开启时刻（spec 内部状态 candidateSince；无窗口 = null）。 */
  candidateSince(): number | null
  /** 最近一次观察时刻（spec 内部状态 lastEvidenceAt）。 */
  lastEvidenceAt(): number
}

export function createCurrentTaskController(options: CurrentTaskControllerOptions): CurrentTaskController {
  const now = options.now ?? Date.now
  const createDecisionId = options.createDecisionId ?? (() => `d_${createId()}`)
  const port = options.taskStore
  const trace = options.trace ?? null

  // spec 决策 5 内部状态：currentTaskId / currentSessionId / candidateSince /
  // lastEvidenceAt / switchConfidence。
  let currentTaskId: string | null = null
  let currentSessionId: string | null = null
  let lastEvidenceAt = 0
  let seen = false
  let pending: PendingWindow | null = null
  /** 已对某候选身份做过决策；同身份不重复开窗，直到稳态复位。 */
  let lastDecidedKey: string | null = null
  /** 上一观察最佳分（score-drop 变化沿检测；spec 内部状态 lastScore）。 */
  let prevBestScore: number | null = null

  function runningTask(): Task | null {
    return port.list().find((t) => t.status === 'running') ?? null
  }

  function resync(running: Task | null): void {
    currentTaskId = running?.id ?? null
    currentSessionId = running ? port.openSessionFor(running.id)?.id ?? null : null
  }

  /** 观察 → 六触发（确定性、免费）。 */
  function detectTriggers(
    activity: Activity,
    detail: ActivityDetail,
    running: Task | null,
    idleGap: number,
    prevBest: number | null,
    boundary: boolean
  ): TriggerKind[] {
    const triggers: TriggerKind[] = []
    const attribution = activity.attribution
    const bestScore = detail.confidence
    // 1. 分数跌破阈值：上一观察 ≥ θ_low，本观察 < θ_low（变化沿）。
    if (prevBest !== null && prevBest >= params().confidenceLow && bestScore < params().confidenceLow) {
      triggers.push('score-drop')
    }
    // 2. 候选超当前 + margin：归属任务 ≠ 运行中任务（或无运行任务），
    //    且置信度越过 θ_low 才构成“有据候选”。margin 一并进触发（与切换门
    //    同语义）：恒不达标（margin < switchMargin）的候选不开窗，dwell 满
    //    也不白花决策调用。
    if (
      attribution &&
      detail.zone !== 'new' &&
      attribution.confidence >= params().confidenceLow &&
      detail.evidence.margin >= params().switchMargin &&
      (running === null || attribution.taskId !== running.id)
    ) {
      triggers.push('candidate-ahead')
    }
    // 3. 新语义簇。
    if (detail.zone === 'new') triggers.push('new-cluster')
    // 4. 长 idle 恢复。
    if (idleGap >= params().idleResumeMs) triggers.push('idle-resume')
    // 5. 多任务竞争：≥2 个任务与活动共享应用集。
    if (detail.evidence.overlappingTasks.length >= 2) triggers.push('competition')
    // 6. 会话边界：运行中任务在控制器外被改变。
    if (boundary) triggers.push('session-boundary')
    return triggers
  }

  function params(): SwitchParams {
    return options.getParams()
  }

  /** 构建决策上下文（最小预填雏形）。 */
  function buildContext(activity: Activity, detail: ActivityDetail, running: Task | null): DecisionContext {
    const candidates: TaskCandidate[] = []
    const attribution = activity.attribution
    if (attribution && detail.zone !== 'new') {
      const task = port.list().find((t) => t.id === attribution.taskId)
      candidates.push({
        taskId: attribution.taskId,
        title: task?.title ?? attribution.taskId,
        confidence: attribution.confidence,
        zone: detail.zone,
        margin: detail.evidence.margin,
        evidence: [...detail.windowTitles.slice(0, 3), detail.evidence.appCombination]
      })
    }
    const session = running ? port.openSessionFor(running.id) ?? null : null
    return {
      activity,
      detail,
      currentTask: running ? { id: running.id, title: running.title, status: running.status } : null,
      currentSession: session,
      candidates,
      matchedMemories: options.readMemories ? options.readMemories(activity) : [],
      profile: {},
      now: now()
    }
  }

  function appendTrace(decisionId: string, kind: TraceInput['kind'], payload: Record<string, unknown>, extra?: Partial<TraceInput>): void {
    if (!trace) return
    trace.append({
      decisionId,
      kind,
      payload,
      ...extra
    })
  }

  /** 记录决策链（observed + decision；不变量 I）。 */
  function recordDecision(activity: Activity, decision: TaskDecision, decisionId: string, taskId?: string): void {
    appendTrace(
      decisionId,
      'observed',
      {
        summary: `${activity.apps.map((a) => a.name).join(', ')} · ${Math.round((activity.endAt - activity.startAt) / 1000)}s`,
        activityId: activity.id
      },
      {
        classifierVersion: activity.classifierVersion,
        promptVersion: activity.promptVersion,
        agentVersion: options.decide.id
      }
    )
    const payload: Record<string, unknown> = {
      action: decision.action,
      reason: decision.reason,
      // 实际执行者（包装链降级时透传内层 id）；未盖章 → 链入口 id。
      decidedBy: decision.decidedBy ?? options.decide.id
    }
    if (decision.action === 'switch') {
      payload.targetTaskId = decision.toTaskId
      payload.confidence = decision.confidence
    } else if (decision.action === 'continue') {
      payload.targetTaskId = decision.taskId
      payload.confidence = decision.confidence
    } else if (decision.action === 'new') {
      payload.title = decision.title
      payload.confidence = decision.confidence
    } else if (decision.action === 'merge') {
      payload.targetTaskId = decision.toTaskId
      payload.confidence = decision.confidence
    } else {
      payload.confidence = 0
    }
    appendTrace(
      decisionId,
      'decision',
      payload,
      {
        taskId,
        classifierVersion: activity.classifierVersion,
        promptVersion: activity.promptVersion,
        agentVersion: options.decide.id
      }
    )
  }

  /**
   * 应用决策。switch → TaskStore.transition（原子 settle+open+迁移，PAUSED
   * 免疫由域层拒绝）；其余动作只记录（new/merge 提案路径与 ignore 推荐历史
   * 属 t56 接线）。
   *
   * `applySwitch=false`（会话边界路径）：刚重同步到用户显式选择的 RUNNING，
   * 立即 switch 会撤销用户操作——决策限 continue/ignore 语义，switch 意图
   * 只记录不执行，交给候选驱动路径（dwell 保护）接管。
   *
   * `settled`：决策者明确裁决且已被采纳/记录（continue/new/merge/ignore、
   * switch 已执行、或域层拒绝——域层状态由用户控制，重判无益）。门拒绝
   * （threshold/margin/dwell）不算 settled：证据改善应能重开窗。
   */
  async function callAndApply(
    activity: Activity,
    detail: ActivityDetail,
    running: Task | null,
    triggers: TriggerKind[],
    dwellElapsed: boolean,
    applySwitch = true
  ): Promise<ControllerOutcome> {
    const ctx = buildContext(activity, detail, running)
    const decision = await options.decide.evaluateTaskContext(ctx)
    const decisionId = createDecisionId()
    let action: ControllerOutcome['action'] = 'noop'
    let switchedTo: string | undefined
    let rejected: string | undefined
    let traceTaskId: string | undefined
    let settled = false

    if (decision.action === 'switch') {
      if (!applySwitch) {
        // 会话边界：只重同步，不发起 switch（撤销用户显式切换由 dwell 保护
        // 的候选路径负责，见 observe 的 oneShot 分支）。
        rejected = 'boundary resync: switch deferred to candidate-driven path'
      } else {
        // 切换判定：threshold + margin + dwell 三者满足（决策者的 switch 意图
        // 也要过滞回——它可能来自 boundary/resume 的即时调用）。
        const candidate = { taskId: decision.toTaskId, confidence: decision.confidence }
        const gate = switchHysteresisOk(candidate, running, detail, params(), dwellElapsed)
        if (gate.ok) {
          if (port.transition(decision.toTaskId, 'running', 'system')) {
            action = 'switch'
            switchedTo = decision.toTaskId
            traceTaskId = decision.toTaskId
            currentTaskId = decision.toTaskId
            currentSessionId = port.openSessionFor(decision.toTaskId)?.id ?? null
            settled = true
          } else {
            // 域层拒绝：PAUSED 免疫 / COMPLETED/ARCHIVED 不可自动复活 / 任务
            // 不存在。域层状态由用户控制——重判无益，算 settled。
            rejected = `switch rejected by domain (PAUSED immunity or non-switchable target)`
            settled = true
          }
        } else {
          rejected = gate.reason
        }
      }
    } else if (decision.action === 'continue') {
      action = 'continue'
      traceTaskId = decision.taskId
      settled = true
    } else if (decision.action === 'new') {
      action = 'new'
      settled = true
    } else if (decision.action === 'merge') {
      action = 'merge'
      traceTaskId = decision.toTaskId
      settled = true
    } else {
      action = 'ignore'
      settled = true
    }

    recordDecision(activity, decision, decisionId, traceTaskId)
    return { triggers, decisionCalls: 1, action, decision, decisionId, switchedTo, rejected, settled }
  }

  async function observe(activity: Activity, detail: ActivityDetail): Promise<ControllerOutcome> {
    const t = now()
    const idleGap = seen ? t - lastEvidenceAt : 0
    lastEvidenceAt = t
    seen = true
    const prevBest = prevBestScore
    prevBestScore = detail.confidence

    const running = runningTask()
    // 会话边界：运行中任务与控制器跟踪不一致（用户操作 / 归属自动恢复 /
    // 其他路径切换）。检测即重同步——内部状态永远跟域层一致。首次观察（从未
    // 跟踪过）静默采纳当前 RUNNING，不构成边界。
    const boundary = currentTaskId !== null && running?.id !== currentTaskId
    if (boundary || (currentTaskId === null && running !== null)) resync(running)

    const triggers = detectTriggers(activity, detail, running, idleGap, prevBest, boundary)
    if (triggers.length === 0) {
      // 稳态：关闭未成熟的 pending 窗口，复位“已决策”记忆——变化沿彻底消失。
      pending = null
      lastDecidedKey = null
      return { triggers, decisionCalls: 0, action: 'noop' }
    }

    const attribution = activity.attribution
    const candidateTaskId = attribution && detail.zone !== 'new' ? attribution.taskId : null
    const key = candidateTaskId ?? 'new'
    const oneShot = triggers.some((tr) => tr === 'session-boundary' || tr === 'idle-resume')
    const candidateDriven = triggers.some((tr) => tr !== 'session-boundary' && tr !== 'idle-resume')

    if (oneShot) {
      // 离散事件：即时调用（无需 dwell）；switch 仍受 threshold + margin 约束。
      // 会话边界例外：刚重同步到用户显式选择的 RUNNING——立即 switch 会撤销
      // 用户操作，故决策限 continue/ignore 语义；若同现候选驱动触发，则同步
      // 开启 pending 窗口，持久候选领先由 dwell 保护的候选路径接管。
      const boundary = triggers.includes('session-boundary')
      pending = null
      const outcome = await callAndApply(activity, detail, running, triggers, true, !boundary)
      lastDecidedKey = !boundary && outcome.settled ? key : null
      if (boundary && candidateDriven) pending = { key, since: t }
      return outcome
    }

    // 候选驱动触发 → pending 窗口（滞回 dwell）。
    if (pending && pending.key === key) {
      const dwellElapsed = t - pending.since >= params().switchDwellSeconds * 1000
      if (!dwellElapsed) return { triggers, decisionCalls: 0, action: 'noop' }
      pending = null
      const outcome = await callAndApply(activity, detail, running, triggers, true)
      // 决策者明确裁决（或域层拒绝）→ 抑制同候选重复打扰；门拒绝（threshold
      // / margin）→ 不设——证据改善可重开窗。
      lastDecidedKey = outcome.settled ? key : null
      return outcome
    }
    if (lastDecidedKey === key) {
      // 同候选已决策过（决策者判断过），不重复开窗——直到稳态复位。
      return { triggers, decisionCalls: 0, action: 'noop' }
    }
    // 新窗口（或候选更换）：dwell 从本观察起算。
    pending = { key, since: t }
    return { triggers, decisionCalls: 0, action: 'noop' }
  }

  return {
    observe,
    currentTaskId: () => currentTaskId,
    currentSessionId: () => currentSessionId,
    candidateSince: () => pending?.since ?? null,
    lastEvidenceAt: () => lastEvidenceAt
  }
}
