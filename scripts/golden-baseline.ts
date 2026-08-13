/**
 * golden-baseline.ts — Golden Dataset 首次跑分的 seam harness（票 58 验收项 1）。
 *
 * 每条 seed 记录 = 一次独立回放（fresh TaskStore + fresh 控制器，零跨记录状态）：
 *   - 时钟注入：now 从记录 input.ts 起步，第二次观察前进 switchDwellSeconds+1ms。
 *   - 决策者：input.mode === 'algorithm' → 真实算法决策者（decisionProvider 兜底
 *     路径）；'llm' → 脚本决策者（按记录 output.suggestion 脚本化——该记录本身
 *     就是那个分析时刻的真实 LLM 产出，见 export-golden-seed.cjs）。
 *   - 两次观察让候选驱动触发（new-cluster / competition）的 pending 窗口成熟为
 *     恰好一次决策调用（spec 决策 5：候选持续满 dwell 才调用；单次观察只开窗）。
 *
 * 七标签映射（详见 golden/eval/README.md，可推导处标注 INFERENCE）：
 *   activityBoundary ← 最后一次观察的 triggers（new-cluster / session-boundary）
 *   currentTask      ← continue/switch/merge 的目标任务；new/ignore → null；
 *                      无决策 → 控制器当前跟踪的 RUNNING 任务
 *   candidateRanking ← 决策目标任务在预填候选（ctx.candidates）中的 1-based 名次
 *                      [INFERENCE：golden 是旧引擎建议列表名次，控制器候选空间
 *                      不同]；new/ignore/无决策 → null
 *   switch           ← 有决策 ? (action === 'switch') : null
 *   merge            ← 有决策 ? (action === 'merge') : null
 *   suggestionLevel  ← 有决策 ? (decidedBy === 'algorithm' ? 'algorithm' : 'llm')
 *                      : null
 *   reason           ← 有决策 ? decision.reason : null
 *
 * 纯逻辑，零 Electron import；由 scripts/golden-runner.cjs 经 esbuild 打包后以
 * node 运行（仓库无 tsx，vitest 只覆盖 tests/）。
 */
import { createCurrentTaskController } from '../electron/store/currentTaskController'
import type {
  ControllerOutcome,
  CurrentTaskController,
  DecisionContext,
  SwitchParams,
  TaskDecision,
  TaskDecisionProvider
} from '../electron/store/currentTaskController'
import { createAlgorithmDecisionProvider } from '../electron/store/decisionProvider'
import { TaskStore } from '../electron/store/TaskStore'
import type { Activity, ActivityDetail } from '../electron/store/activityLedger'
import type { Task } from '../shared/types'

/* ------------------------------- seed 形状 ------------------------------- */

export interface SeedCandidate {
  id: string
  title: string
  llmTitle: boolean
  confidence: number
  apps: string[]
  clipboardRefs: number
  reason?: string
}

export interface SeedSegment {
  apps: string[]
  durationMs: number
  windowTitles: string[]
  confidence: number
  zone: 'high' | 'low' | 'new'
  taskId: string | null
}

export interface SeedRecord {
  id: string
  ts: number
  input: {
    ts: number
    mode: 'llm' | 'algorithm'
    segment: SeedSegment
    candidates: SeedCandidate[]
  }
  output: { suggestion: SeedCandidate }
}

export interface BaselineRow {
  id: string
  labels: {
    activityBoundary: boolean
    currentTask: string | null
    candidateRanking: number | null
    switch: boolean | null
    merge: boolean | null
    suggestionLevel: 'llm' | 'algorithm' | null
    reason: string | null
  }
}

/* ------------------------------- 滞回参数 -------------------------------- */

/** 生产 = Settings 投影缺省（与 tests/currentTaskController.test.ts 同构）。 */
const BASE_PARAMS: SwitchParams = {
  switchDwellSeconds: 45,
  switchMargin: 0.1,
  confidenceHigh: 0.7,
  confidenceLow: 0.45,
  idleResumeMs: 15 * 60_000
}

/* ------------------------------ 输入构造 ------------------------------- */

function appRefs(names: string[]): { id: string; name: string }[] {
  return names.map((n) => ({ id: n, name: n }))
}

/**
 * 种子任务：归属任务（running，seed 未携带其标题 [INFERENCE]：段窗口标题/应用
 * 名兜底——只进 ctx/理由字符串，不进任何标签）+ 候选建议任务（waiting）。
 * 候选建议是旧引擎在该分析时刻匹配到的已知任务，回放时作为任务池存在。
 */
function seedTasks(rec: SeedRecord, ts: number): Task[] {
  const seg = rec.input.segment
  const tasks: Task[] = []
  const make = (id: string, title: string, apps: string[], status: Task['status']): Task => ({
    id,
    title,
    status,
    statusSource: 'system',
    statusReason: status === 'running' ? 'migration' : 'auto_switch',
    apps: appRefs(apps),
    resources: [],
    windowTitles: seg.windowTitles,
    createdAt: ts,
    updatedAt: ts,
    lastActiveAt: ts,
    activeMs: 0
  })
  if (seg.taskId) {
    tasks.push(make(seg.taskId, seg.windowTitles[0] ?? seg.apps[0] ?? seg.taskId, seg.apps, 'running'))
  }
  for (const c of rec.input.candidates) {
    tasks.push(make(c.id, c.title, c.apps, 'waiting'))
  }
  return tasks
}

/** segment → Activity（startAt = ts − durationMs，与 ledger 的段窗口语义一致）。 */
function activityFrom(rec: SeedRecord, ts: number): Activity {
  const seg = rec.input.segment
  return {
    id: `act_${rec.id}`,
    startAt: ts - seg.durationMs,
    endAt: ts,
    apps: seg.apps.map((name) => ({ id: name, name, durationMs: seg.durationMs, windows: seg.windowTitles })),
    clipboardRefs: [],
    ...(seg.taskId ? { attribution: { taskId: seg.taskId, confidence: seg.confidence } } : {}),
    signature: 'golden-seed',
    classifierVersion: 'golden-baseline@1'
  }
}

/** segment → ActivityDetail。overlappingTasks 与 ledger 同语义：与段共享应用集
 * 的任务，排除归属胜者（clusterEvents 的 winner 排除），封顶 8。 */
function detailFrom(rec: SeedRecord, store: TaskStore): ActivityDetail {
  const seg = rec.input.segment
  const appSet = new Set(seg.apps)
  const overlapping = store
    .list()
    .filter((t) => t.id !== seg.taskId && t.apps.some((a) => appSet.has(a.id)))
    .slice(0, 8)
    .map((t) => t.id)
  return {
    zone: seg.zone,
    confidence: seg.confidence,
    windowTitles: seg.windowTitles,
    evidence: {
      appCombination: seg.apps.slice(0, 5).join(', '),
      durationMs: seg.durationMs,
      overlappingTasks: overlapping,
      // margin 由聚类相似分差得出，seed 未携带 [INFERENCE]：置 0。本回放中归属
      // 恒等于运行任务，candidate-ahead 触发与切换滞回门都不参与，不影响结果。
      margin: 0
    }
  }
}

/* -------------------------------- 决策者 -------------------------------- */

/** llm 模式脚本决策者：按记录的真实 LLM 产出（output.suggestion）脚本化。 */
function scriptedDecider(rec: SeedRecord): TaskDecisionProvider {
  return {
    id: 'agent',
    async evaluateTaskContext(ctx: DecisionContext): Promise<TaskDecision> {
      const sug = rec.output?.suggestion ?? {
        title: 'Untitled task',
        confidence: rec.input.segment.confidence
      }
      if (rec.input.segment.taskId) {
        return {
          action: 'continue',
          taskId: rec.input.segment.taskId,
          confidence: rec.input.segment.confidence,
          reason: sug.reason ?? 'scripted continue (llm mode)',
          decidedBy: 'agent'
        }
      }
      return {
        action: 'new',
        title: sug.title,
        confidence: sug.confidence,
        reason: sug.reason ?? 'scripted new (llm mode)',
        apps: ctx.activity.apps.map((a) => a.name),
        evidence: [...ctx.detail.windowTitles.slice(0, 3), ctx.detail.evidence.appCombination],
        decidedBy: 'agent'
      }
    }
  }
}

/* -------------------------------- 七标签映射 ----------------------------- */

function mapLabels(
  rec: SeedRecord,
  controller: CurrentTaskController,
  outcome: ControllerOutcome,
  ctx: DecisionContext | null
): BaselineRow {
  const triggers = outcome.triggers
  const hasDecision = outcome.decisionCalls > 0 && outcome.decision !== undefined
  const activityBoundary = triggers.includes('new-cluster') || triggers.includes('session-boundary')

  let currentTask: string | null
  let candidateRanking: number | null
  let switchLabel: boolean | null
  let mergeLabel: boolean | null
  let suggestionLevel: 'llm' | 'algorithm' | null
  let reason: string | null

  if (!hasDecision) {
    // 稳态 noop（不变量 E）：控制器继续跟踪运行任务，未产生任何决策。
    currentTask = controller.currentTaskId()
    candidateRanking = null
    switchLabel = null
    mergeLabel = null
    suggestionLevel = null
    reason = null
  } else {
    const d = outcome.decision as TaskDecision
    const target =
      d.action === 'continue' || d.action === 'switch' || d.action === 'merge' ? d.toTaskId ?? d.taskId : null
    currentTask = target
    candidateRanking =
      target === null
        ? null
        : (() => {
            const idx = (ctx?.candidates ?? []).findIndex((c) => c.taskId === target)
            return idx >= 0 ? idx + 1 : null
          })()
    switchLabel = d.action === 'switch'
    mergeLabel = d.action === 'merge'
    suggestionLevel = d.decidedBy === 'algorithm' ? 'algorithm' : 'llm'
    reason = d.reason
  }

  return {
    id: rec.id,
    labels: {
      activityBoundary,
      currentTask,
      candidateRanking,
      switch: switchLabel,
      merge: mergeLabel,
      suggestionLevel,
      reason
    }
  }
}

/* -------------------------------- 单条回放 ------------------------------- */

async function runOne(rec: SeedRecord): Promise<BaselineRow> {
  let now = rec.input.ts
  const saved: { version: number; tasks: Task[] } = { version: 2, tasks: seedTasks(rec, now) }
  const store = new TaskStore({ load: () => saved, save: () => undefined, now: () => now })
  store.load()

  const decide = rec.input.mode === 'llm' ? scriptedDecider(rec) : createAlgorithmDecisionProvider()
  // 捕获决策上下文：candidateRanking 映射需要 ctx.candidates（照抄测试 harness 的
  // record 包装模式）。
  let ctx: DecisionContext | null = null
  const capture: TaskDecisionProvider = {
    id: decide.id,
    async evaluateTaskContext(c: DecisionContext, decisionId?: string): Promise<TaskDecision> {
      ctx = c
      return decide.evaluateTaskContext(c, decisionId)
    }
  }

  const controller = createCurrentTaskController({
    taskStore: store,
    decide: capture,
    getParams: () => BASE_PARAMS,
    now: () => now
  })

  const activity = activityFrom(rec, now)
  const detail = detailFrom(rec, store)
  await controller.observe(activity, detail)
  // 候选持续满 dwell 后第二次观察 → pending 窗口成熟，恰好一次决策调用。
  now += BASE_PARAMS.switchDwellSeconds * 1000 + 1
  const outcome = await controller.observe(activity, detail)
  return mapLabels(rec, controller, outcome, ctx)
}

/** 逐条回放全部 seed 记录，返回 {id, labels} 预测行（与 seed 同序）。 */
export async function runGoldenBaseline(records: SeedRecord[]): Promise<BaselineRow[]> {
  const rows: BaselineRow[] = []
  for (const rec of records) {
    rows.push(await runOne(rec))
  }
  return rows
}
