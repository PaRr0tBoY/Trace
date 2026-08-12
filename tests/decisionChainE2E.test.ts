/**
 * 端到端全链测试（t57，spec Testing Decisions 主 seam）：
 *   事件 → 活动 → 决策 → 提案 → 采纳 → 任务 / 会话 / 记忆 / trace
 *
 * 真实组件：TaskStore / ActivityLedger + evidence / CurrentTaskController /
 * 内存 trace 与推荐历史 / SQLite memoryGraph；注入时钟与脚本化决策者
 * （fake provider）。引擎与 state.ts 同构接线（onActivities → 控制器、
 * onProposals → 引擎 propose、onPatternMatch / onPatternFeedback → 图）。
 *
 * 刻意压掉引擎 Path A（忽略表挡签名）：待定列表只含决策提案，断言单链；
 * 顺带验证 t55 MINOR-4 的语义——被忽略表挡建议构建的活动仍送达决策层。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { closeDatabase, openDatabase, type TraceDatabase } from '../electron/store/db'
import { createSuggestionEngine, type MemoryCandidate, type SuggestionEngine } from '../electron/main/suggestionEngine'
import { createIgnoredTable, type IgnoredTable } from '../electron/main/ignored'
import {
  createActivityLedger,
  DEFAULT_SEGMENT_PARAMS,
  recommendationFingerprint,
  suggestionSignature,
  type ActivityAnalysis
} from '../electron/store/activityLedger'
import { createMemoryEvidenceStore, evidenceFromUsageEvent, type EvidenceStore } from '../electron/store/evidenceStore'
import { TaskStore } from '../electron/store/TaskStore'
import {
  createCurrentTaskController,
  MAX_PENDING_PROPOSALS,
  type CurrentTaskController,
  type TaskDecision,
  type TaskDecisionProvider
} from '../electron/store/currentTaskController'
import { createMemoryTraceStore, type TraceStore } from '../electron/store/traceStore'
import { createMemoryRecommendationHistory, type RecommendationHistory } from '../electron/store/recommendationHistory'
import { gradeProposal } from '../electron/store/proposalGrading'
import { applyPatternFeedback, createSqliteMemoryGraph, type MemoryGraphStore } from '../electron/store/memoryGraph'
import type { AppSwitchEvent, TaskProposal, UsageEvent } from '../shared/types'

/** Single-app event; gaps are small so the whole batch is one segment. */
function ev(appName: string, ts: number, title = ''): AppSwitchEvent {
  return {
    type: 'app-switch',
    appName,
    exePath: `C:\\Apps\\${appName.toLowerCase()}.exe`,
    pid: 1,
    windowTitle: title,
    ts
  }
}

/** 5 events, one segment (1s gaps < transientMs 2.5s). */
function batch(appName: string, base: number): UsageEvent[] {
  return [
    ev(appName, base, `${base} window`),
    ev(appName, base + 1_000),
    ev(appName, base + 2_000),
    ev(appName, base + 3_000),
    ev(appName, base + 4_000)
  ]
}

/** Code+Chrome 混合段（与引擎测试 batch() 同构）：单段、双应用、有标题 token。 */
function codeChromeBatch(base: number): UsageEvent[] {
  return [
    ev('Code', base, 'report.md — Code'),
    ev('Code', base + 1_000),
    ev('Chrome', base + 2_000, 'docs.example.com'),
    ev('Chrome', base + 3_000),
    ev('Code', base + 4_000)
  ]
}

const CODE_CHROME_KEYS = ['c:/apps/chrome.exe', 'c:/apps/code.exe']
/** batch1 的段签名（应用键排序 + 小时桶；batch2 同桶同键 → 同签名）。 */
const CHAIN_SIG = suggestionSignature(CODE_CHROME_KEYS, 10_000)

const SETTINGS = { suggestionMinEvents: 5, suggestionSilenceSeconds: 60, confidenceHigh: 0.7, confidenceLow: 0.45 }

interface ChainHarness {
  engine: SuggestionEngine
  store: TaskStore
  events: UsageEvent[]
  evidence: EvidenceStore
  now: number
  ignored: IgnoredTable
  pushed: TaskProposal[][]
  history: RecommendationHistory
  trace: TraceStore
  graph: MemoryGraphStore
  db: TraceDatabase
  controller: CurrentTaskController
  memoryCandidates: MemoryCandidate[]
  decisions: TaskDecision[]
  /** 决策链 id 序号（确定性且每次决策唯一——提案 id 派生自它）。 */
  chainSeq: number
}

/**
 * The installed better-sqlite3 addon may target a different runtime ABI than
 * the test runner's Node (the repo keeps the Electron-ABI build for packaging).
 * Fall back to a cached Node-ABI prebuild through the official `nativeBinding`
 * injection seam — same convention as tests/db.test.ts.
 */
const CACHED_NODE_BINDING = join(process.cwd(), 'node_modules', '.cache', 'better-sqlite3-node', 'better_sqlite3.node')

function openDbForTest(): TraceDatabase {
  try {
    return openDatabase(':memory:')
  } catch (e) {
    if (!(e instanceof Error && e.message.includes('NODE_MODULE_VERSION'))) throw e
    if (!existsSync(CACHED_NODE_BINDING)) {
      throw new Error(`better-sqlite3 ABI mismatch and no cached Node build at ${CACHED_NODE_BINDING}`)
    }
    return openDatabase(':memory:', { nativeBinding: CACHED_NODE_BINDING })
  }
}

const openDbs: TraceDatabase[] = []
afterEach(() => {
  for (const db of openDbs.splice(0)) closeDatabase(db)
})

function makeHarness(): ChainHarness {
  const h = {
    events: [] as UsageEvent[],
    now: 1_000_000,
    ignored: createIgnoredTable({ load: () => null, save: () => {} }),
    pushed: [] as TaskProposal[][],
    decisions: [] as TaskDecision[],
    memoryCandidates: [] as MemoryCandidate[],
    chainSeq: 0,
    store: new TaskStore({ load: () => null, save: () => {} }),
    evidence: createMemoryEvidenceStore(),
    history: createMemoryRecommendationHistory({ now: () => h.now }),
    trace: createMemoryTraceStore({ now: () => h.now }),
    db: openDbForTest(),
    graph: undefined as unknown as MemoryGraphStore,
    controller: undefined as unknown as CurrentTaskController,
    engine: undefined as unknown as SuggestionEngine
  }
  openDbs.push(h.db)
  h.graph = createSqliteMemoryGraph(h.db, { now: () => h.now, lambda: 0.25 })

  const ledger = createActivityLedger({
    evidence: h.evidence,
    getTasks: () => h.store.list(),
    getParams: () => ({
      ...DEFAULT_SEGMENT_PARAMS,
      confidenceHigh: SETTINGS.confidenceHigh,
      confidenceLow: SETTINGS.confidenceLow
    }),
    ignored: h.ignored,
    // 与 state.ts 同构：推荐历史冷却并入 ledger 的 blockedSignatures。
    cooling: (fingerprint) => h.history.cooldownMs(fingerprint) > 0
  })

  const decide: TaskDecisionProvider = {
    id: 'fake',
    async evaluateTaskContext(): Promise<TaskDecision> {
      // 未脚本化时默认 ignore（真实 provider 总会裁决；脚本化决策只在链测试
      // 需要时注入）。
      return h.decisions.shift() ?? { action: 'ignore', reason: 'no scripted decision', decidedBy: 'fake' }
    }
  }

  h.engine = createSuggestionEngine({
    now: () => h.now,
    readEvents: () => h.events,
    store: h.store,
    getSettings: () => SETTINGS,
    ledger,
    onSuggestions: (sugs) => h.pushed.push(sugs),
    history: h.history,
    getLevel: (input) => gradeProposal(input),
    trace: h.trace,
    onMemorySuggestion: (candidate) => h.memoryCandidates.push(candidate),
    // 与 state.ts 同构：任务比对命中 → pattern 事实（suggested）。
    onPatternMatch: (match) => {
      h.graph.addFact({
        type: 'pattern',
        content: `${match.appCombination} → ${match.taskTitle}`,
        source: 'inferred',
        userState: 'suggested',
        intent: 'system-infer',
        entities: match.appNames.map((name) => ({ name, type: 'app' })),
        validAt: match.now,
        lastSeenAt: match.now
      })
    },
    // 与 state.ts 同构：采纳/忽略 → 图侧状态转换（t57 闭环）。
    onPatternFeedback: (feedback) => applyPatternFeedback(h.graph, feedback),
    // 与 state.ts 同构：采纳/忽略的决策提案回流控制器缓冲剔除（BLOCK-1）。
    onProposalConsumed: (ids) => h.controller.consume(ids),
    // 与 state.ts 同构：活动推送 → 当前任务控制器（主 seam）。
    onActivities: async (analysis: ActivityAnalysis) => {
      for (let i = 0; i < analysis.activities.length; i++) {
        await h.controller.observe(analysis.activities[i], analysis.details[i])
      }
    },
  })

  h.controller = createCurrentTaskController({
    taskStore: h.store,
    decide,
    trace: h.trace,
    history: h.history,
    // 假时钟注入：滞回 dwell / idle-resume 与引擎分析同钟（缺省 Date.now
    // 会让跨 tick 的真实毫秒间隔把窗口永远卡在"刚开启"）。
    now: () => h.now,
    getParams: () => ({
      switchDwellSeconds: 0,
      switchMargin: 0.1,
      confidenceHigh: SETTINGS.confidenceHigh,
      confidenceLow: SETTINGS.confidenceLow,
      idleResumeMs: 60_000
    }),
    // 确定性决策链 id（trace 断言面）；顺序唯一——提案 id = prop_<决策链 id>，
    // 多次决策必须不同（同 id 会被引擎已消费过滤器当复活卡拦截）。
    createDecisionId: () => `d_chain_${++h.chainSeq}`,
    // t57 决策产出接线：提案缓冲 → 引擎待定列表（≤3 FIFO / 同 key 替换在
    // 控制器内完成，引擎整体消费）。
    onProposals: (proposals) => h.engine.propose(proposals)
  })
  return h
}

/** 事件入证据 + 环形缓冲，时钟前移，等一趟 tick。 */
async function feedAndTick(h: ChainHarness, events: UsageEvent[], now: number): Promise<void> {
  for (const e of events) h.evidence.record(evidenceFromUsageEvent(e))
  h.events.push(...events)
  h.now = now
  await h.engine.tick()
}

describe('端到端全链（t57）：事件 → 活动 → 决策 → 提案 → 采纳 → 任务/会话/记忆/trace', () => {
  it('决策 new → 提案 ≤3 带 decisionId → 采纳落任务/会话/记忆/trace 全链', async () => {
    const h = makeHarness()
    // Path A 挡掉本签名：待定列表只含决策提案（顺带验证 MINOR-4：被忽略表
    // 挡建议构建的活动仍送达决策层）。引擎 start 基线化游标后才记录事件。
    h.ignored.add(CHAIN_SIG)
    h.engine.start()

    // ① 事件 → 活动：首趟分析（静默 ≥60s）→ 新语义簇触发，滞回窗口开启。
    await feedAndTick(h, codeChromeBatch(10_000), 100_000)
    expect(h.controller.pendingProposals()).toHaveLength(0)
    expect(h.pushed.at(-1)).toEqual([])

    // ② 第二事件批（同模式 +10s）→ 第二趟观察 → dwell(0) 满足 → 决策调用
    // → new 提案。
    h.decisions.push({
      action: 'new',
      title: 'Build CAD Agent',
      confidence: 0.8,
      reason: 'new semantic cluster',
      apps: ['Code', 'Chrome'],
      evidence: [],
      decidedBy: 'fake'
    })
    await feedAndTick(h, codeChromeBatch(24_000), 200_000)

    // ③ 提案：≤3、带决策链 id、new 无 taskId、L1 展示级。
    const latest = h.pushed.at(-1)!
    expect(latest.length).toBeGreaterThan(0)
    expect(latest.length).toBeLessThanOrEqual(MAX_PENDING_PROPOSALS)
    const proposal = latest.find((p) => p.title === 'Build CAD Agent')
    expect(proposal).toBeDefined()
    expect(proposal!.decisionId).toBeTruthy()
    expect(proposal!.taskId).toBeUndefined()
    expect(proposal!.level).toBe(1)
    // 决策提案携带身份数据（引擎 accept/ignore 落推荐历史的键输入）。
    expect(proposal!.appExePaths).toEqual(expect.arrayContaining(['c:/apps/code.exe', 'c:/apps/chrome.exe']))
    expect(proposal!.segmentStartTs).toBeGreaterThan(0)
    expect(h.controller.pendingProposals()).toHaveLength(1)

    // ④ 采纳 → commit 接缝：新任务 + 会话（create → makeRunning → openSession）。
    const taskId = h.engine.accept(proposal!.id)
    expect(taskId).not.toBeNull()
    const task = h.store.list().find((t) => t.id === taskId)
    expect(task).toBeDefined()
    expect(task!.title).toBe('Build CAD Agent')
    expect(task!.status).toBe('running')
    expect(task!.apps.map((a) => a.name)).toEqual(expect.arrayContaining(['Code', 'Chrome']))
    const session = h.store.openSessionFor(task!.id)
    expect(session).toBeDefined()
    expect(session!.taskId).toBe(task!.id)
    // 待定列表随采纳收缩（卡片移除）。
    expect(h.engine.suggestions()).toHaveLength(0)

    // ⑤ 记忆：采纳反馈候选（project）发出；本链无覆盖任务 → 无 pattern 事实。
    expect(h.memoryCandidates.some((c) => c.type === 'project' && c.content === 'Build CAD Agent')).toBe(true)

    // ⑥ 推荐历史：accepted 记录（actionReason user_confirmed，指纹来自提案身份数据）。
    const records = h.history.list()
    expect(records.some((r) => r.outcome === 'accepted' && r.actionReason === 'user_confirmed')).toBe(true)

    // ⑦ trace：决策链 observed + decision + result（采纳回填）共享 decisionId。
    const chain = h.trace.listByDecisionId(proposal!.decisionId!)
    expect(chain.map((r) => r.kind)).toEqual(expect.arrayContaining(['observed', 'decision', 'result']))
    const resultRow = chain.find((r) => r.kind === 'result')
    expect(resultRow).toBeDefined()
    expect(resultRow!.payload.outcome).toBe('accepted')
    expect(resultRow!.payload.proposalId).toBe(proposal!.id)
    expect(resultRow!.taskId).toBe(task!.id)
  })

  it('采纳 → pattern 事实确认强化；忽略 → 按原因置 ignored（模式记忆闭环）', async () => {
    const h = makeHarness()
    h.engine.start()
    // 覆盖任务（Code+Chrome）：分析命中任务比对 → onPatternMatch 沉淀事实。
    const target = h.store.create('Writing report', {
      apps: [
        { id: 'c:/apps/code.exe', name: 'Code' },
        { id: 'c:/apps/chrome.exe', name: 'Chrome' }
      ]
    })!
    await feedAndTick(h, codeChromeBatch(10_000), 100_000)

    const facts = h.graph.listFacts({ types: ['pattern'] })
    expect(facts).toHaveLength(1)
    const fact1 = facts[0]
    expect(fact1.userState).toBe('suggested')
    const weightBefore = fact1.weight
    const acceptProposal = h.engine.suggestions().find((s) => s.taskId === target.id)
    expect(acceptProposal).toBeDefined()

    // 采纳 → 确认强化：userState confirmed、意图档升 adopt-suggestion、
    // hitCount+1、权重上调。
    expect(h.engine.accept(acceptProposal!.id)).toBe(target.id)
    const confirmed = h.graph.getFact(fact1.id)!
    expect(confirmed.userState).toBe('confirmed')
    expect(confirmed.intent).toBe('adopt-suggestion')
    expect(confirmed.hitCount).toBe(1)
    expect(confirmed.weight).toBeGreaterThan(weightBefore)

    // 第二任务（Figma+Slack）：另一模式的 pattern 事实；忽略（not_now）→
    // 置 ignored。
    const target2 = h.store.create('Design review', {
      apps: [
        { id: 'c:/apps/figma.exe', name: 'Figma' },
        { id: 'c:/apps/slack.exe', name: 'Slack' }
      ]
    })!
    await feedAndTick(
      h,
      [
        ev('Figma', 30_000, 'canvas — Figma'),
        ev('Figma', 31_000),
        ev('Slack', 32_000, 'design channel'),
        ev('Slack', 33_000),
        ev('Figma', 34_000)
      ],
      300_000
    )

    const facts2 = h.graph.listFacts({ types: ['pattern'] })
    expect(facts2).toHaveLength(2)
    const fact2 = facts2.find((f) => f.content.includes('Design review'))
    expect(fact2).toBeDefined()
    expect(fact2!.userState).toBe('suggested')
    const ignoreProposal = h.engine.suggestions().find((s) => s.taskId === target2.id)
    expect(ignoreProposal).toBeDefined()

    expect(h.engine.ignore(ignoreProposal!.id, 'not_now')).toBe(true)
    expect(h.graph.getFact(fact2!.id)!.userState).toBe('ignored')
    // 已确认的事实不受后续影响。
    expect(h.graph.getFact(fact1.id)!.userState).toBe('confirmed')
    // 推荐历史：ignored 记录带 actionReason（忽略原因）。
    const ignored = h.history.list().find((r) => r.outcome === 'ignored')
    expect(ignored).toBeDefined()
    expect(ignored!.actionReason).toBe('not_now')
  })

  it('propose 并入待定列表：新到缓冲整体替换决策子集', () => {
    const h = makeHarness()
    const p1: TaskProposal = {
      id: 'prop_d1',
      title: 'A',
      appNames: ['Code'],
      confidence: 0.6,
      lowConfidence: false,
      algorithmReason: 'r',
      evidence: { appCombination: 'Code', durationMs: 1000, overlappingTasks: [] },
      decisionId: 'd1',
      level: 1
    }
    const p2: TaskProposal = { ...p1, id: 'prop_d2', title: 'B', decisionId: 'd2' }
    const p3: TaskProposal = { ...p1, id: 'prop_d3', title: 'C', decisionId: 'd3' }

    h.engine.propose([p1, p2])
    expect(h.engine.suggestions().map((s) => s.id)).toEqual(['prop_d1', 'prop_d2'])
    // 控制器缓冲整体换血（同 key 替换 / FIFO 已在 56 侧完成）：旧决策提案
    // 全部移除，新缓冲并入，不重复。
    h.engine.propose([p2, p3])
    expect(h.engine.suggestions().map((s) => s.id)).toEqual(['prop_d2', 'prop_d3'])
    expect(h.pushed.at(-1)!.map((s) => s.id)).toEqual(['prop_d2', 'prop_d3'])
  })

  it('采纳后的决策提案不复活：二次决策批整批推送，缓冲与待定列表无旧卡（review BLOCK-1）', async () => {
    const h = makeHarness()
    // 两批都挡 Path A：待定列表只反映决策提案（含图密批的新语义簇）。
    h.ignored.add(CHAIN_SIG)
    h.ignored.add(suggestionSignature(['c:/apps/figma.exe', 'c:/apps/slack.exe'], 60_000))
    h.engine.start()

    // ① 第一决策批 → 采纳 p1：引擎待定清空、控制器缓冲同步剔除。
    await feedAndTick(h, codeChromeBatch(10_000), 100_000)
    h.decisions.push({
      action: 'new',
      title: 'Build CAD Agent',
      confidence: 0.8,
      reason: 'first cluster',
      apps: ['Code', 'Chrome'],
      evidence: [],
      decidedBy: 'fake'
    })
    await feedAndTick(h, codeChromeBatch(24_000), 200_000)
    const p1 = h.pushed.at(-1)!.find((p) => p.title === 'Build CAD Agent')
    expect(p1).toBeDefined()
    expect(h.engine.accept(p1!.id)).not.toBeNull()
    expect(h.engine.suggestions()).toHaveLength(0)
    expect(h.controller.pendingProposals()).toHaveLength(0)

    // ② 第二决策批（新语义簇 Figma+Slack）→ 整批推送：旧卡不复活，缓冲只
    // 含新提案（无回流剔除时 p1 会随批复活——回归面）。
    h.decisions.push({
      action: 'new',
      title: 'Second thing',
      confidence: 0.8,
      reason: 'second cluster',
      apps: ['Figma', 'Slack'],
      evidence: [],
      decidedBy: 'fake'
    })
    await feedAndTick(
      h,
      [
        ev('Figma', 60_000, 'canvas — Figma'),
        ev('Figma', 61_000),
        ev('Slack', 62_000, 'design channel'),
        ev('Slack', 63_000),
        ev('Figma', 64_000)
      ],
      400_000
    )
    expect(h.engine.suggestions().find((p) => p.id === p1!.id)).toBeUndefined()
    const p2 = h.engine.suggestions().find((p) => p.title === 'Second thing')
    expect(p2).toBeDefined()
    expect(h.controller.pendingProposals().map((p) => p.id)).toEqual([p2!.id])
  })

  it('决策提案忽略：actionReason 落历史、trace result ignored、L2 指纹冷却 ≥ 48h（review MINOR-2/3）', async () => {
    const h = makeHarness()
    h.ignored.add(CHAIN_SIG)
    h.engine.start()
    await feedAndTick(h, codeChromeBatch(10_000), 100_000)

    // 低置信度决策提案 → 展示分级 L2（不再硬编码 L1）。
    h.decisions.push({
      action: 'new',
      title: 'Low confidence task',
      confidence: 0.3,
      reason: 'weak cluster',
      apps: ['Code', 'Chrome'],
      evidence: [],
      decidedBy: 'fake'
    })
    await feedAndTick(h, codeChromeBatch(24_000), 200_000)
    const prop = h.pushed.at(-1)!.find((p) => p.title === 'Low confidence task')
    expect(prop).toBeDefined()
    expect(prop!.level).toBe(2)

    expect(h.engine.ignore(prop!.id, 'not_now')).toBe(true)
    expect(h.engine.suggestions()).toHaveLength(0)

    // 推荐历史：ignored + actionReason；L2 → 同类冷却 ≥ 48h（同一"不感兴趣"
    // 语义不再只冷 24h）。
    const record = h.history.list().find((r) => r.outcome === 'ignored')
    expect(record).toBeDefined()
    expect(record!.actionReason).toBe('not_now')
    expect(record!.level).toBe(2)
    const fp = recommendationFingerprint(['c:/apps/code.exe', 'c:/apps/chrome.exe'], prop!.segmentStartTs!)
    expect(h.history.cooldownMs(fp)).toBeGreaterThanOrEqual(48 * 3600 * 1000)

    // trace：result ignored 行回填决策链（无 meta 分支）。
    const chain = h.trace.listByDecisionId(prop!.decisionId!)
    const resultRow = chain.find((r) => r.kind === 'result' && r.payload.outcome === 'ignored')
    expect(resultRow).toBeDefined()
    expect(resultRow!.payload.proposalId).toBe(prop!.id)
  })
})
