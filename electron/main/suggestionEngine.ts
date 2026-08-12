/**
 * SuggestionEngine — quiet-period trigger + suggestion lifecycle (t19).
 *
 * The glue between the event bus (t12), the ActivityLedger clustering
 * module (t40) and the provider chain (t15). Pure module: no Electron
 * imports, everything the engine needs is injected so vitest drives it with
 * a fake clock, a fake bus and a real TaskStore.
 *
 * Pipeline per analysis (spec 实现决策 5):
 *   1. Trigger — at least `suggestionMinEvents` events arrived since the
 *      last analysis AND no new event for `suggestionSilenceSeconds`. The
 *      cursor itself lives in the ledger (t40); the engine only evaluates
 *      the settings thresholds against the ledger's pending stats.
 *   2. ledger.analyze() (t40) turns the evidence batch into Activity
 *      objects; each activity becomes a TaskProposal unless its signature is
 *      on the ignored table (the ledger owns that gate too).
 *   3. Context-prior (spec 实现决策 7): confirmed project/workflow memories
 *      matching a segment nudge its confidence up and travel as
 *      memoryContext into the LLM annotation.
 *   4. LLM annotation — for every built suggestion (bounded by
 *      MAX_LLM_CANDIDATES): title + rationale, never the attribution
 *      decision. One batched call for the whole analysis; an OCR pass on the
 *      foreground window (t30) may add screen text as ocrContext when a
 *      provider is available. When no provider is configured or the chain
 *      fails, the pass degrades silently to pure algorithm: temporary titles
 *      like "Code + Chrome task", no rationale.
 *   5. Grading tail (t47, spec 实现决策 9): batch semantic dedup (deterministic
 *      fingerprint when the local model is off), task comparison (app-set
 *      coverage ≥ 0.6: hit on the attributed task → L2 reinforcement, coverage
 *      by another active task → obvious-duplicate L3 drop; never touches
 *      confidence), per-candidate level via the injected getLevel
 *      (proposalGrading.ts), L1 cap, and a noop row recorded per displayed
 *      L1/L2 + dropped L3. Pattern matches (task ∩ current activity) fire
 *      onPatternMatch so the glue sinks them into memoryGraph as 'pattern'
 *      facts (t50 API area untouched).
 *
 * TaskProposal lifecycle: pending proposals are transient and in-memory
 * only — never persisted (restart clears them). Accept merges into the
 * candidate task (type-safe, TaskStore.merge) or creates a new one; ignore
 * routes the signature through the ledger's table and drops the card. A new
 * analysis replaces the whole pending list. A successful accept also emits a
 * memory candidate (onMemorySuggestion) so the task system's feedback
 * distills into long-term memory — the candidate stays 'suggested' until the
 * user confirms it in the memory panel.
 *
 * Privacy (spec 铁律): the LLM call carries the event-batch summary (app
 * names, window titles, durations) and similar task titles — only to the
 * configured provider chain; cloud endpoints are explicit in settings (t15).
 *
 * Logging: `[Suggestion]` tag, one line per analysis (with mode), one line
 * per accept/ignore. No per-event noise.
 */
import type { ActivityAnalysis, ActivityLedger } from '../store/activityLedger'
import { recommendationFingerprint, recommendationPatternKey } from '../store/activityLedger'
import {
  derivePatternScore,
  ignoreReasonToActionReason,
  type PatternScore,
  type RecommendationHistory
} from '../store/recommendationHistory'
import {
  appCoverage,
  capL1,
  dedupBatch,
  TASK_COVERAGE_THRESHOLD,
  TIME_OVERLAP_WINDOW_MS
} from '../store/proposalGrading'
import type { ChatRequest, ChatResult } from './provider'
import { algorithmicTitle } from '../../shared/titles'
import { createId } from '../store/ids'
import { normalizeAppKey } from '../../shared/appKey'
import { normalizeExePath, type PrivacyPolicy } from '../store/privacyGate'
import { buildClipboardRef, type TaskStore } from '../store/TaskStore'
import { MAX_LOCAL_CANDIDATES, type CandidateOptimizer } from '../store/localModelOptimizer'
import { matchMemories } from '../store/decisionProvider'
import type { TraceStore } from '../store/traceStore'
import type {
  AppRef,
  CandidateActivity,
  ClipboardItem,
  IgnoreReason,
  Memory,
  MemoryType,
  RecommendationActionReason,
  RecommendationLevel,
  RecommendationRecord,
  ResourceRef,
  TaskProposal,
  Task,
  UsageEvent
} from '../../shared/types'

const MAX_TITLE_CHARS = 60
const MAX_REASON_CHARS = 300
/** Batched LLM annotation budget — the local optimizer's input bound is kept equal (t54). */
export const MAX_LLM_CANDIDATES = 8
const TICK_INTERVAL_MS = 2_000
const LLM_TIMEOUT_MS = 20_000

/**
 * Confidence gain when a segment matches a confirmed project/workflow memory
 * (context-prior, spec decision 7). Deliberately small: zones are decided by
 * the clusterer, so the boost only nudges the displayed confidence and must
 * not look like a zone change. Visible but honest — one memory hit is weak
 * evidence on top of the clustering margin.
 */
export const MEMORY_CONFIDENCE_BOOST = 0.05

/** Memory candidate emitted after a successful accept (feedback sink). */
export interface MemoryCandidate {
  type: MemoryType
  content: string
}

/**
 * 采纳/忽略 → 模式记忆反馈载荷（t57，spec 决策 9 闭环）。调用方（state.ts）
 * 按载荷定位 memoryGraph 的 pattern 事实：采纳 → updateFactState 'confirmed'
 * （意图档升 adopt-suggestion + hitCount+1 + 权重上调，即"addFact 确认态"）；
 * 忽略 → 'ignored'（默认检索排除；原因级衰减由 t46 derivePatternScore 按
 * ACTION_REASON_DECAY 兑现）。纯载荷，无图依赖。
 */
export interface PatternFeedback {
  kind: 'accepted' | 'ignored'
  /** 采纳/忽略原因（spec 决策 9 值域；accepted = user_confirmed / user_edited_title）。 */
  actionReason: RecommendationActionReason
  /** 证据串（pattern 事实 content 的主语侧，与 onPatternMatch 同源）。 */
  appCombination: string
  /** 应用显示名（pattern 事实实体）。 */
  appNames: string[]
  /** 采纳后的任务标题（pattern 事实 content 的宾语侧）；忽略时无。 */
  taskTitle?: string
  now: number
}

/**
 * The confirmed title becomes the memory content: it is the user's own term
 * (the whole point of context-prior is 标题贴合用户术语), and the type
 * 'project' encodes 长期项目. The app set is already on the task, so it adds
 * nothing to the memory. Null for blank titles.
 */
export function buildMemoryCandidate(title: string): MemoryCandidate | null {
  const content = title.trim()
  if (!content) return null
  return { type: 'project', content }
}

/** The subset of settings the engine reads live on every tick. */
export interface SuggestionSettings {
  suggestionMinEvents: number
  suggestionSilenceSeconds: number
  /** 高/低置信阈值（t47 评级证据稳定判据的边距下限推导源，与聚类参数同源）。 */
  confidenceHigh: number
  confidenceLow: number
}

/** Chat surface of the provider chain (injected; absent = algorithmic only). */
export type ChatFn = (req: ChatRequest) => Promise<ChatResult>

/**
 * OCR capture of the foreground window (t30). Returns recognized text or
 * null; absent = the analysis runs without OCR context. Never throws.
 */
export type OcrFn = () => Promise<string | null>

export interface SuggestionEngineOptions {
  now: () => number
  /** Ring-buffer read (eventBus.recentEvents in prod). */
  readEvents: () => UsageEvent[]
  store: TaskStore
  getSettings: () => SuggestionSettings
  /** ActivityLedger (t40): owns the trigger cursor, clustering and ignore gate. */
  ledger: ActivityLedger
  /** Provider chain; undefined until the main process wires it (index.ts). */
  chat?: ChatFn
  /** Full-list push to the renderer (state.ts pushState.suggestions). */
  onSuggestions: (suggestions: TaskProposal[]) => void
  /**
   * Long-term memories (context-prior input; only confirmed project/workflow
   * entries are used). Absent = context-prior disabled.
   */
  readMemories?: () => readonly Memory[]
  /**
   * Resolve a clipboard item by id (ItemStore in prod). Clipboard events
   * carry itemId; without this the suggestions carry no material.
   */
  readItem?: (itemId: string) => ClipboardItem | undefined
  /** Observability sink (ai-log.jsonl in prod): algorithm inputs/outputs. */
  log?: (entry: Record<string, unknown>) => void
  /** Feedback sink: called with a memory candidate after a successful accept. */
  onMemorySuggestion?: (candidate: MemoryCandidate) => void
  /**
   * 已消费提案回调（t57 review BLOCK-1）：采纳/忽略的决策提案 id 回流控制器
   * （其缓冲只随 handleDecisionOutputs 变更，不回流会导致已消费卡随下批
   * onProposals 整批复活）。
   */
  onProposalConsumed?: (ids: string[]) => void
  /**
   * Privacy policy supplier (t44): the denied-app list the analysis filter
   * checks before candidacy. Absent = no filtering (engine behavior
   * unchanged). Only the denied-app dimension gates candidates — the master
   * switch / time range gate AI *services* (OCR, prefill, tools), while the
   * algorithmic pipeline must keep working locally (spec story 33).
   */
  getPolicy?: () => PrivacyPolicy
  /**
   * Trace sink for denied-app interceptions (t44): one call per blocked
   * activity, payload per TracePrivacyPayload (kind 'privacy' lands in the
   * AI-rationale UI as "已被隐私政策过滤"). Absent = interceptions still
   * filter candidates, but nothing is recorded.
   */
  recordPrivacy?: (input: { reason: string; access?: string; appExePath?: string; contentType?: string }) => void
  /**
   * Recommendation history (t46, spec 决策 9): accept/ignore 处记录 outcome 与
   * actionReason（回填）。Absent = 不记录历史（既有测试与无 DB 环境）。
   */
  history?: RecommendationHistory
  /**
   * 展示分级解析（t47 评级接入，46 预留位）：runAnalysis 对每个候选调用，
   * 返回 L1/L2/L3（L3 丢弃不展示）。输入携带全部确定性判据（聚类证据、
   * 任务比对、模式学习得分、最近记录），真实实现 = proposalGrading 的
   * gradeProposal（state.ts 注入）。缺省按 1（当前全部卡片都是 L1 主动建议）。
   */
  getLevel?: (input: LevelInput) => RecommendationLevel
  /**
   * 模式记忆沉淀（t47，spec 决策 9）：任务比对命中（候选应用集被现有任务
   * 覆盖 ≥ TASK_COVERAGE_THRESHOLD）时回调，调用方（state.ts）经既有
   * memoryGraph.addFact(type='pattern') 落库。Absent = 不沉淀。
   */
  onPatternMatch?: (match: PatternMatch) => void
  /**
   * Local model candidate optimizer (t54, spec 决策 6/11): 聚类候选 →
   * CandidateActivity → 过滤 ≤3 / 标题草稿 / 排序（接入点 = runAnalysis
   * 候选后处理）。Absent = 纯算法路径（不变量 H：功能等价）。优化器返回
   * null（关闭 / 失败）时算法候选原样传递，绝不污染决策数据。
   */
  localModel?: CandidateOptimizer
  /**
   * Current-task controller hook (t55, spec 决策 5): called once per analysis
   * pass with the privacy-filtered activities (denied apps never reach the
   * decision maker — 不变量 D 在决策源头成立)。引擎不 await 结果：控制器
   * 内部自行消化（LLM 延迟绝不阻塞建议推送）。Absent = 控制器未接线。
   */
  onActivities?: (analysis: ActivityAnalysis) => Promise<void> | void
  /**
   * 采纳/忽略模式反馈（t57，spec 决策 9 闭环）：采纳 → 调用方（state.ts）把
   * 匹配的 pattern 事实确认强化；忽略 → 按 actionReason 置 ignored（默认检索
   * 排除）。Absent = 不沉淀（既有测试与无图环境）。
   */
  onPatternFeedback?: (feedback: PatternFeedback) => void
  /**
   * 决策链结果回填（t57，spec 决策 8）：采纳/忽略后追加 kind='result' 行，
   * 与决策链（observed/decision）共享 decisionId。Absent = 不回填。
   */
  trace?: Pick<TraceStore, 'append'>
}

/**
 * 分级决策输入（getLevel 的实参）：引擎组装全部确定性判据，决策函数（缺省
 * 是 proposalGrading.gradeProposal 的直通）只做规则表判断。pattern/lastRecord
 * 按 recommendationPatternKey 跨小时桶累积（"同类"历史），冷却仍按指纹逐桶。
 */
export interface LevelInput {
  suggestion: TaskProposal
  /** 聚类证据带（'high' | 'low' | 'new'）。 */
  zone: 'high' | 'low' | 'new'
  /** 最佳聚类边距（best − second）。 */
  margin: number
  /** 边距下限 = θ_high − θ_low。 */
  marginFloor: number
  /** 任务池大小（0 = 新工作无竞争）。 */
  taskPoolSize: number
  /** 被现有任务应用集覆盖（含归属目标 taskId）。 */
  coveredByTask: boolean
  /** 被活跃任务覆盖（时段重叠）—— 明显重复。 */
  coveredByActiveTask: boolean
  /** 确定性指纹（含小时桶）。 */
  fingerprint: string
  /** 模式学习得分（同类累积）。 */
  pattern: PatternScore
  /** 该模式最近一条记录（无 = 从未展示/无同类历史）。 */
  lastRecord?: RecommendationRecord
  now: number
}

/** 任务比对命中（模式记忆沉淀载荷，spec 决策 9 匹配信号）。 */
export interface PatternMatch {
  /** 被覆盖的现有任务标题。 */
  taskTitle: string
  /** 候选的应用组合串（证据串，事实 content 的主语侧）。 */
  appCombination: string
  /** 应用显示名（事实实体）。 */
  appNames: string[]
  /** 命中时刻（注入时钟）。 */
  now: number
}

/** Per-suggestion engine-side material the renderer never needs. */
interface TaskProposalMeta {
  appRefs: AppRef[]
  /** Activity id (ledger Activity.id) — the CandidateActivity identity key (t54). */
  activityId: string
  segmentStartTs: number
  signature: string
  /** Window titles of the source segment (LLM material only). */
  windowTitles: string[]
  /** Confirmed project/workflow memories this segment matched (LLM material). */
  memoryContext: string[]
  /** 聚类证据带与最佳边距（t47 分级输入）。 */
  zone: 'high' | 'low' | 'new'
  margin: number
  /** 任务比对结果（t47）：被现有任务应用集覆盖 / 被活跃任务覆盖。 */
  coveredByTask: boolean
  coveredByActiveTask: boolean
  /** 展示分级（t47）：accept/ignore 记录用展示时刻的分级，随卡片落库。 */
  level: RecommendationLevel
  /**
   * 落库/分级键快照（t47）：去重合并会吸收败者应用集（语义合并下 A∪B 是
   * "幻影键"，冷却永不命中）；键固定为该条自身吸收前的原始应用集。
   */
  recordFingerprint: string
  recordPatternKey: string
  /** 本地模型草稿标题（t47 语义去重键）；无草稿 = undefined。 */
  drafted?: string
}

/**
 * User-edited accept payload (suggestion convert panel). Each field is
 * optional: absent fields fall back to what the suggestion carries.
 */
export interface AcceptOptions {
  title?: string
  note?: string
  apps?: AppRef[]
  /** Final clipboard resource list, snapshotted by the IPC layer. */
  clipboardRefs?: ResourceRef[]
}

export interface SuggestionEngine {
  /** Baseline the event cursor; idempotent. */
  start(): void
  stop(): void
  /**
   * Evaluate the trigger; call this on a periodic timer. Resolves when the
   * triggered analysis (if any) finished — the production timer ignores the
   * promise, tests await it.
   */
  tick(): Promise<TaskProposal[]> | undefined
  /** Run one analysis pass immediately (tests). Returns the pushed list. */
  analyzeNow(): Promise<TaskProposal[]>
  /**
   * 决策路径提案消费（t57）：控制器（56）的 ≤3 FIFO / 同 key 替换缓冲并入
   * 引擎待定列表并推送渲染层。控制器是该子集的唯一事实源——新到缓冲整体
   * 替换上一批决策提案（引擎不重复实现 FIFO/替换，沿用 56 的
   * handleDecisionOutputs）。
   */
  propose(proposals: TaskProposal[]): void
  /** Pending proposals (transient). */
  suggestions(): readonly TaskProposal[]
  /**
   * Accept: merge into the candidate task or create a new one. `opts`
   * overrides what the suggestion itself carries — the convert panel sends
   * the user's edited title/note/apps and the selected clipboard refs.
   * Returns the accepted task id; null when the id is stale (already
   * replaced by a newer analysis).
   */
  accept(id: string, opts?: AcceptOptions): Task['id'] | null
  /**
   * Ignore: drop the card and write its signature into the table (existing
   * LRU behavior, unchanged), plus record outcome + actionReason into the
   * recommendation history (t46). `reason` is the user's ignore reason;
   * absent = 不感兴趣.
   */
  ignore(id: string, reason?: IgnoreReason): boolean
  /** Wire the provider chain after construction (index.ts). */
  setChat(chat: ChatFn): void
  /** Wire the OCR capture after construction (index.ts); optional, silent when absent. */
  setOcr(ocr: OcrFn): void
}

/**
 * 批内去重合并（t47）：胜者吸收败者的应用集（appNames/appExePaths 平行数组
 * 按名去重）、剪贴板材料、时长与置信度（取高）。合并只发生在后处理区，归因
 * 决策数据（zone/置信度语义）仍以胜者为主。
 */
function absorbCandidate(
  winner: { suggestion: TaskProposal; meta: TaskProposalMeta },
  loser: { suggestion: TaskProposal; meta: TaskProposalMeta }
): void {
  const w = winner.suggestion
  const l = loser.suggestion
  const names = new Set(w.appNames)
  for (let i = 0; i < l.appNames.length; i++) {
    if (names.has(l.appNames[i])) continue
    names.add(l.appNames[i])
    w.appNames.push(l.appNames[i])
    if (l.appExePaths && l.appExePaths.length > i) {
      w.appExePaths = w.appExePaths ?? []
      w.appExePaths.push(l.appExePaths[i])
    }
  }
  if (l.clipboardRefs) w.clipboardRefs = [...(w.clipboardRefs ?? []), ...l.clipboardRefs]
  w.evidence.durationMs += l.evidence.durationMs
  w.confidence = Math.max(w.confidence, l.confidence)
  for (const t of loser.meta.windowTitles) if (!winner.meta.windowTitles.includes(t)) winner.meta.windowTitles.push(t)
  for (const ref of loser.meta.appRefs) {
    if (!winner.meta.appRefs.some((r) => r.id === ref.id)) winner.meta.appRefs.push(ref)
  }
}

export function createSuggestionEngine(options: SuggestionEngineOptions): SuggestionEngine {
  const { now, readEvents, store, getSettings, ledger, onSuggestions } = options
  const log = options.log ?? (() => {})
  let chat: ChatFn | undefined = options.chat
  let ocr: OcrFn | undefined = undefined
  let running = false
  let analyzing = false
  let pending: TaskProposal[] = []
  const meta = new Map<string, TaskProposalMeta>()
  /** 决策路径提案 id 集（t57）：propose 整体替换的"上一批"标识。 */
  let decisionProposalIds = new Set<string>()
  /**
   * 已采纳/已忽略的决策提案 id（t57 review BLOCK-1 双保险）：控制器 consume
   * 已从缓冲剔除，入站批再滤一遍防在途推送复活。有界：仅决策提案经用户动作
   * 积累，会话级忽略不计。
   */
  let consumedDecisionIds = new Set<string>()

  /** 决策提案的 app 键（身份/指纹输入）：appExePaths 平行数组优先，缺省按显示名归一化。 */
  function appKeysFromProposal(p: TaskProposal): string[] {
    if (p.appExePaths && p.appExePaths.length > 0) return p.appExePaths.map((x) => normalizeAppKey(x))
    return p.appNames.map((n) => normalizeAppKey(n))
  }

  /** 决策提案的 AppRef（采纳落库的 apps 兜底）：id 遵循 AppRef.id 约定（归一化 exePath 或进程名）。 */
  function appRefsFromProposal(p: TaskProposal): AppRef[] {
    const keys = appKeysFromProposal(p)
    return p.appNames.map((name, i) => ({ id: keys[i] ?? normalizeAppKey(name), name }))
  }

  /**
   * Most recent app-switch event whose normalized exePath or appName matches
   * the segment appKey; the "open app" action's linked-window snapshot
   * (ADR-0005). Newest-first scan; events are chronological in the ring buffer.
   */
  function latestSwitchFor(appKey: string): { pid: number; title: string; ts: number; exePath?: string } | undefined {
    const events = readEvents()
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.type !== 'app-switch') continue
      if (normalizeAppKey(e.exePath) === appKey || normalizeAppKey(e.appName) === appKey) {
        return { pid: e.pid, title: e.windowTitle, ts: e.ts, exePath: e.exePath || undefined }
      }
    }
    return undefined
  }

  /** AppRefs from a segment: id = normalized exePath (attributor key space), name = display name. */
  function appRefsFromSegment(appKeys: string[], appNames: string[]): AppRef[] {
    const refs: AppRef[] = []
    for (let i = 0; i < appKeys.length; i++) {
      const ref: AppRef = { id: appKeys[i], name: appNames[i] ?? appKeys[i] }
      const linked = latestSwitchFor(appKeys[i])
      if (linked) {
        ref.linkedWindow = { pid: linked.pid, title: linked.title, ts: linked.ts }
        // Original-case exePath powers icon extraction at push time
        // (appIconCore skips apps without one).
        ref.exePath = linked.exePath
      }
      refs.push(ref)
    }
    return refs
  }

  function algorithmReason(attr: { zone: string; confidence: number; evidence: { appCombination: string; durationMs: number; overlappingTasks: string[] } }, target: Task | undefined): string {
    const minutes = Math.max(1, Math.round(attr.evidence.durationMs / 60_000))
    const basis = attr.zone === 'new'
      ? `New activity pattern: ${attr.evidence.appCombination}, ${minutes} min, no matching task`
      : `Similar to "${target?.title ?? 'unknown'}" — ${attr.evidence.appCombination}, ${minutes} min`
    const overlaps = attr.evidence.overlappingTasks.slice(0, 2)
    return overlaps.length > 0 ? `${basis}; also near ${overlaps.join(', ')}` : basis
  }

  /**
   * Resolve the activity's clipboard itemId refs (assigned to the activity
   * window by the ledger) into ResourceRefs through `readItem`; items
   * evicted between copy and analysis are skipped.
   */
  function resolveClipboardRefs(itemIds: string[]): ResourceRef[] {
    if (!options.readItem) return []
    const refs: ResourceRef[] = []
    for (const itemId of itemIds) {
      const item = options.readItem(itemId)
      if (item) refs.push(buildClipboardRef(item))
    }
    return refs
  }

  /** Batched LLM annotation for the built suggestions (bounded by MAX_LLM_CANDIDATES). */
  async function annotateWithLlm(
    candidates: Array<{ suggestion: TaskProposal; meta: TaskProposalMeta }>,
    ocrText: string | null
  ): Promise<boolean> {
    if (!chat || candidates.length === 0) return false
    const segments = candidates.map((c) => ({
      apps: c.suggestion.appNames,
      windowTitles: c.meta.windowTitles,
      // Familiar phrases from the user's confirmed memories; omitted when absent.
      ...(c.meta.memoryContext.length > 0 ? { memoryContext: c.meta.memoryContext } : {}),
      similarTasks: c.suggestion.evidence.overlappingTasks
    }))
    // OCR screen text (t30) rides alongside the segments; omitted when absent.
    const payload: Record<string, unknown> = { segments }
    if (ocrText && ocrText.length > 0) payload.ocrContext = ocrText
    const req: ChatRequest = {
      messages: [
        {
          role: 'system',
          content:
            'You name short work sessions for a task tracker. Given a JSON list of activity segments, reply with JSON only: ' +
            '{"items": [{"title": "...", "reason": "..."}]}, one item per segment in the same order. ' +
            'title: a concise task title, at most 8 words, no quotes, written in the same language as the window titles. ' +
            'When a segment has "memoryContext", prefer those familiar phrases in the title when they fit. ' +
            'When the payload carries "ocrContext" (OCR text of the foreground screen during the session), ' +
            'use it to disambiguate what the user was doing. ' +
            'reason: one plain sentence explaining what this session looks like.'
        },
        { role: 'user', content: `Segments: ${JSON.stringify(payload)}` }
      ],
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, reason: { type: 'string' } },
              required: ['title', 'reason']
            }
          }
        },
        required: ['items']
      },
      maxTokens: 500,
      timeoutMs: LLM_TIMEOUT_MS
    }

    let result: ChatResult
    try {
      result = await chat(req)
    } catch (err) {
      console.log(`[Suggestion] llm annotation failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    if (!result.ok || !result.parsed || typeof result.parsed !== 'object' || Array.isArray(result.parsed)) return false
    const parsed = result.parsed as { items?: unknown }
    if (!Array.isArray(parsed.items)) return false

    const items = parsed.items as Array<{ title?: unknown; reason?: unknown }>
    for (let i = 0; i < candidates.length && i < items.length; i++) {
      const title = sanitizeString(items[i]?.title, MAX_TITLE_CHARS)
      const reason = sanitizeString(items[i]?.reason, MAX_REASON_CHARS)
      if (title) candidates[i].suggestion.title = title
      if (reason) candidates[i].suggestion.reason = reason
    }
    return true
  }

  function sanitizeString(value: unknown, max: number): string {
    if (typeof value !== 'string') return ''
    const trimmed = value.trim().replace(/\s+/g, ' ')
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed
  }

  /** One OCR attempt for the analysis; silent on any failure. */
  async function runOcrOnce(): Promise<string | null> {
    if (!ocr) return null
    try {
      const text = await ocr()
      return typeof text === 'string' && text.length > 0 ? text : null
    } catch (err) {
      console.log(`[Ocr] capture failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** One analysis pass: ledger clusters the pending batch, we build proposals. */
  async function runAnalysis(): Promise<TaskProposal[]> {
    analyzing = true
    try {
      const tasks = [...store.list()]
      // OCR only when a provider exists to consume it — no AI config means
      // no screen capture at all (performance guard, t30).
      const [analysis, ocrText] = await Promise.all([
        ledger.analyze(),
        chat ? runOcrOnce() : Promise.resolve(null)
      ])

      // Privacy (t44, spec story 33/36): denied apps' activities never
      // become suggestion candidates — the algorithm layer (ledger
      // clustering / attribution) ran untouched above; only the AI-facing
      // candidacy is filtered. Each interception is recorded (kind
      // 'privacy', reason included) so the AI-rationale UI can show
      // "已被隐私政策过滤". The gate checks the denied list only: the AI
      // master switch / time range gate AI services, while the local
      // algorithmic pipeline keeps working (no-provider fallback).
      let blockedByPrivacy = 0
      const privacyBlocks: Array<{ app: string; reason: string }> = []
      const policy = options.getPolicy?.()
      if (policy && policy.deniedApps.length > 0) {
        const blockedIdx = new Set<number>()
        for (let i = 0; i < analysis.activities.length; i++) {
          const denied = analysis.activities[i].apps.find((a) =>
            policy.deniedApps.some((d) => normalizeExePath(d) === normalizeExePath(a.id))
          )
          if (!denied) continue
          blockedIdx.add(i)
          const key = normalizeExePath(denied.id)
          const reason = `app on denied list: ${key}`
          privacyBlocks.push({ app: key, reason })
          // Same reason format as privacyGate's aiAllowed deny — trace
          // payloads stay consistent across gate sites.
          options.recordPrivacy?.({ reason, access: 'activities', appExePath: key })
        }
        if (blockedIdx.size > 0) {
          analysis.activities = analysis.activities.filter((_, i) => !blockedIdx.has(i))
          analysis.details = analysis.details.filter((_, i) => !blockedIdx.has(i))
          blockedByPrivacy = blockedIdx.size
        }
      }

      // Current-task controller (t55, spec 决策 5): 活动推送路径 = ledger
      // analyze 之后、建议构建之前；只看到隐私过滤后的活动。不 await：
      // 决策（可能含 LLM）延迟不阻塞本趟建议推送，控制器内部消化错误。
      // 忽略表 / 冷却不挡此推送（blockedSignatures 只挡建议构建，见下）。
      void options.onActivities?.(analysis)

      const built: Array<{ suggestion: TaskProposal; meta: TaskProposalMeta }> = []
      // Ignore/cooldown (t46) gate only suggestion building — the activities
      // themselves are observations the controller already consumed. Ledger
      // computes the marks; here we skip by stable signature (immune to the
      // privacy filter's reindexing above).
      const blocked = new Set(analysis.blockedSignatures)
      for (let i = 0; i < analysis.activities.length; i++) {
        const activity = analysis.activities[i]
        const detail = analysis.details[i]
        if (blocked.has(activity.signature)) continue
        const appRefs = appRefsFromSegment(activity.apps.map((a) => a.id), activity.apps.map((a) => a.name))
        if (appRefs.length === 0) continue
        // The activity's own signature travels as the proposal's dismissal key.
        const signature = activity.signature

        const attribution = activity.attribution
        const target = attribution ? tasks.find((t) => t.id === attribution.taskId) : undefined
        // Icon extraction prefers original-case exePaths; the normalized
        // identity key is the fallback when no raw path is known.
        const appExePaths = activity.apps.slice(0, 5).map((app) => latestSwitchFor(app.id)?.exePath ?? app.id)
        const suggestion: TaskProposal = {
          id: `s_${createId()}`,
          title: target ? target.title : algorithmicTitle(activity.apps.map((a) => a.name)),
          appNames: activity.apps.slice(0, 5).map((a) => a.name),
          appExePaths,
          confidence: detail.confidence,
          lowConfidence: detail.zone === 'low',
          algorithmReason: algorithmReason(detail, target),
          evidence: {
            appCombination: detail.evidence.appCombination,
            durationMs: detail.evidence.durationMs,
            overlappingTasks: detail.evidence.overlappingTasks
          },
          taskId: activity.attribution?.taskId,
          // The material copied during the activity's window (isomorphic with
          // a task's resources — the card and the convert panel show these).
          clipboardRefs: resolveClipboardRefs(activity.clipboardRefs)
        }
        built.push({
          suggestion,
          meta: {
            appRefs,
            activityId: activity.id,
            segmentStartTs: activity.startAt,
            signature,
            windowTitles: detail.windowTitles.slice(0, 3),
            memoryContext: [],
            zone: detail.zone,
            margin: detail.evidence.margin,
            coveredByTask: false,
            coveredByActiveTask: false,
            level: 1,
            // 去重合并会吸收败者应用集（语义合并下 A∪B 是"幻影键"，冷却永不
            // 命中）；键在合并前按本条自身应用集固定（absorbCandidate 不改）。
            recordFingerprint: recommendationFingerprint(appRefs.map((a) => a.id), activity.startAt),
            recordPatternKey: recommendationPatternKey(appRefs.map((a) => a.id))
          }
        })
      }

      // Context-prior: confirmed project/workflow memories matching a segment
      // nudge its confidence up and give the LLM the user's own terms.
      if (options.readMemories) {
        const hits = matchMemories(
          built.map((b) => ({ appNames: b.suggestion.appNames, windowTitles: b.meta.windowTitles })),
          options.readMemories()
        )
        for (let i = 0; i < built.length; i++) {
          if (hits[i].length === 0) continue
          built[i].meta.memoryContext = hits[i]
          built[i].suggestion.confidence = Math.min(1, built[i].suggestion.confidence + MEMORY_CONFIDENCE_BOOST)
        }
      }

      // All built suggestions go through the LLM (bounded); algorithmic titles
      // are only the no-AI fallback.
      const llmCandidates = built.slice(0, MAX_LLM_CANDIDATES)
      const llmOk = llmCandidates.length > 0 ? await annotateWithLlm(llmCandidates, ocrText) : false

      // Local model candidate optimization (t54, spec 决策 6/11 接入点):
      // 聚类候选 → CandidateActivity → 过滤 ≤3 / 标题草稿 / 排序。关闭或失败
      // → 算法候选原样传递（不变量 H：功能等价，绝不污染决策数据）。归因
      // （confidence / algorithmReason）始终来自算法层 — 本地模型只改顺序、
      // 数量与标题草稿。
      let finalBuilt = built
      let localModelMode: 'off' | 'ok' | 'degraded' = 'off'
      if (options.localModel && built.length > 0) {
        const candidates: CandidateActivity[] = built.map((b) => ({
          activityId: b.meta.activityId,
          candidateTaskId: b.suggestion.taskId,
          semanticLabel: b.suggestion.title,
          score: b.suggestion.confidence,
          evidenceRefs: [...b.meta.windowTitles, b.suggestion.evidence.appCombination]
        }))
        try {
          const optimized = await options.localModel.optimize(candidates)
          if (optimized !== null && optimized.length > 0) {
            const ordered: typeof built = []
            for (const c of optimized) {
              const entry = built.find((b) => b.meta.activityId === c.activityId)
              if (!entry) continue
              const draft = sanitizeString(c.semanticLabel, MAX_TITLE_CHARS)
              if (draft) {
                entry.suggestion.title = draft
                entry.meta.drafted = draft
              }
              ordered.push(entry)
              if (ordered.length >= MAX_LOCAL_CANDIDATES) break
            }
            if (ordered.length > 0) {
              finalBuilt = ordered
              localModelMode = 'ok'
            } else {
              localModelMode = 'degraded'
            }
          } else {
            localModelMode = 'degraded'
          }
        } catch (err) {
          localModelMode = 'degraded'
          console.log(`[Suggestion] local model optimization failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      /* ── t47 分级应用区（spec 决策 9）：批内去重 → 任务比对 → 分级 →
           L1 上限 → 展示 noop 落库 → L1 优先排序。本区是本票最后一次触碰
           suggestionEngine（t55 将重构），只改候选后处理，不动上游。 ── */

      // ① 批内去重（决策 9 两路）：本地模型开 → 语义键（草稿标题归一化相等）；
      //    关/降级 → 确定性指纹相等。合并保留先到者（优化器重排后的首位），
      //    败者字段吸收进胜者。落库/分级键在构建时已按各条自身应用集固定。
      const merges = dedupBatch(
        finalBuilt.map((b) => ({
          id: b.suggestion.id,
          fingerprint: recommendationFingerprint(b.meta.appRefs.map((a) => a.id), b.meta.segmentStartTs),
          semanticLabel: b.meta.drafted
        })),
        { semantic: localModelMode === 'ok' }
      )
      let dedupMerged = 0
      if (merges.size > 0) {
        const alive = new Set(finalBuilt.map((b) => b.suggestion.id))
        for (const [winnerId, loserIds] of merges) {
          const winner = finalBuilt.find((b) => b.suggestion.id === winnerId)
          if (!winner) continue
          for (const loserId of loserIds) {
            const loser = finalBuilt.find((b) => b.suggestion.id === loserId)
            if (!loser) continue
            absorbCandidate(winner, loser)
            alive.delete(loserId)
            dedupMerged++
          }
        }
        finalBuilt = finalBuilt.filter((b) => alive.has(b.suggestion.id))
      }

      // ② 任务比对（确定性，永远生效）：候选应用键集 × 现有任务应用集覆盖率
      //    ≥ 0.6 → 覆盖；任务活跃（running/waiting，或 lastActiveAt 在候选
      //    开始前 1h 内 = 时段重叠）→ 明显重复。归属目标 taskId 的任务只算
      //    覆盖不算活跃。命中触发 onPatternMatch（匹配信号沉淀进模式记忆）。
      const tasksNow = [...store.list()]
      const marginFloor = Math.max(0, getSettings().confidenceHigh - getSettings().confidenceLow)
      const history = options.history
      const patternMatches: PatternMatch[] = []
      // 同类历史（跨小时桶）按 recommendationPatternKey 累积：最近记录取
      // list() 最新在前的首个；模式得分按该模式全部记录推导（t47 消费 t46）。
      const lastByPattern = new Map<string, RecommendationRecord>()
      if (history) {
        for (const r of history.list()) {
          if (r.patternKey !== undefined && r.patternKey.length > 0 && !lastByPattern.has(r.patternKey)) {
            lastByPattern.set(r.patternKey, r)
          }
        }
      }
      const patternRecordsOf = (patternKey: string): RecommendationRecord[] =>
        history ? history.list().filter((r) => r.patternKey === patternKey) : []

      for (const b of finalBuilt) {
        const appKeys = b.meta.appRefs.map((a) => a.id)
        let coveredByTask = false
        let coveredByActiveTask = false
        let bestTask: Task | undefined
        let bestCoverage = 0
        for (const t of tasksNow) {
          const cov = appCoverage(appKeys, t)
          if (cov < TASK_COVERAGE_THRESHOLD) continue
          if (cov > bestCoverage) {
            bestCoverage = cov
            bestTask = t
          }
          if (t.id === b.suggestion.taskId) {
            coveredByTask = true
            continue
          }
          const active =
            t.status === 'running' ||
            t.status === 'waiting' ||
            t.lastActiveAt >= b.meta.segmentStartTs - TIME_OVERLAP_WINDOW_MS
          if (active) coveredByActiveTask = true
          else coveredByTask = true
        }
        b.meta.coveredByTask = coveredByTask
        b.meta.coveredByActiveTask = coveredByActiveTask
        if (bestTask) {
          patternMatches.push({
            taskTitle: bestTask.title,
            appCombination: b.suggestion.evidence.appCombination,
            appNames: b.suggestion.appNames,
            now: now()
          })
        }

        // ③ 分级（46 预留的 getLevel 注入点）：引擎组装确定性判据，决策函数
        //    （prod = proposalGrading.gradeProposal）返回 L1/L2/L3。无
        //    getLevel → 缺省 L1（既有行为；prod 始终注入真实分级）。
        const level: RecommendationLevel = options.getLevel
          ? options.getLevel({
              suggestion: b.suggestion,
              zone: b.meta.zone,
              margin: b.meta.margin,
              marginFloor,
              taskPoolSize: tasksNow.length,
              coveredByTask,
              coveredByActiveTask,
              fingerprint: b.meta.recordFingerprint,
              pattern: derivePatternScore(b.meta.recordPatternKey, patternRecordsOf(b.meta.recordPatternKey)),
              lastRecord: lastByPattern.get(b.meta.recordPatternKey),
              now: now()
            })
          : 1
        b.meta.level = level
        b.suggestion.level = level
      }

      // ④ L3 丢弃（不展示；noop L3 落库 → 该指纹 7 天冷却）+ 不变量 G：
      //    L1 数量 ≤ 上限（超出降回 L2 候选区，不丢弃）。
      interface GradedEntry {
        id: string
        suggestion: TaskProposal
        meta: TaskProposalMeta
        level: RecommendationLevel
        confidence: number
        segmentStartTs: number
      }
      const survivors: GradedEntry[] = []
      const dropped: Array<{ fingerprint: string; patternKey: string }> = []
      for (const b of finalBuilt) {
        if (b.meta.level === 3) {
          dropped.push({
            fingerprint: b.meta.recordFingerprint,
            patternKey: b.meta.recordPatternKey
          })
          continue
        }
        survivors.push({
          id: b.suggestion.id,
          suggestion: b.suggestion,
          meta: b.meta,
          level: b.meta.level,
          confidence: b.suggestion.confidence,
          segmentStartTs: b.meta.segmentStartTs
        })
      }
      const droppedByGrading = dropped.length
      capL1(survivors)
      for (const s of survivors) {
        s.meta.level = s.level
        s.suggestion.level = s.level
      }
      const l1Count = survivors.filter((s) => s.level === 1).length

      // ⑤ 展示：L1 优先（级别升序稳定分区，组内保持原序）；分级结果随 noop
      //    记录落 RecommendationRecord.level（展示时刻分级，冷却按指纹逐桶）。
      const ordered = [...survivors].sort((a, b) => a.level - b.level)
      pending = ordered.map((s) => s.suggestion)
      meta.clear()
      for (const s of ordered) meta.set(s.id, s.meta)
      if (history) {
        for (const s of ordered) {
          history.record({
            fingerprint: s.meta.recordFingerprint,
            patternKey: s.meta.recordPatternKey,
            level: s.level,
            outcome: 'noop'
          })
        }
        for (const d of dropped) {
          history.record({ fingerprint: d.fingerprint, patternKey: d.patternKey, level: 3, outcome: 'noop' })
        }
      }
      for (const pm of patternMatches) options.onPatternMatch?.(pm)

      const mode = llmOk ? 'llm' : 'algorithm'
      const ocrNote = ocrText ? `, ocr: ${ocrText.length} chars` : ''
      console.log(
        `[Suggestion] analysis: ${analysis.activities.length} activities -> ${pending.length} suggestions (mode: ${mode}${ocrNote}, L1: ${l1Count})`
      )
      log({
        kind: 'analysis',
        activities: analysis.activities.length,
        blockedByPrivacy,
        privacyBlocks,
        mode,
        localModelMode,
        ocrChars: ocrText?.length,
        dedupMerged,
        droppedByGrading,
        l1Count,
        segments: analysis.activities.map((a, idx) => ({
          apps: a.apps.slice(0, 5).map((app) => app.name),
          durationMs: a.endAt - a.startAt,
          windowTitles: analysis.details[idx].windowTitles.slice(0, 3),
          confidence: analysis.details[idx].confidence,
          zone: analysis.details[idx].zone,
          taskId: a.attribution?.taskId ?? null
        })),
        suggestions: survivors.map((s) => ({
          id: s.id,
          title: s.suggestion.title,
          llmTitle: llmOk,
          confidence: s.suggestion.confidence,
          level: s.level,
          apps: s.suggestion.appNames,
          clipboardRefs: s.suggestion.clipboardRefs?.length ?? 0,
          reason: s.suggestion.reason
        }))
      })
      onSuggestions(pending)
      return pending
    } finally {
      analyzing = false
    }
  }

  return {
    start(): void {
      if (running) return
      running = true
      // Baseline the ledger's trigger cursor at the newest timeline event;
      // anything before start() is history, never analyzed.
      ledger.baseline()
      console.log('[Suggestion] engine started')
    },
    stop(): void {
      if (!running) return
      running = false
      console.log('[Suggestion] engine stopped')
    },
    tick(): Promise<TaskProposal[]> | undefined {
      if (!running || analyzing) return undefined
      const settings = getSettings()
      if (ledger.pendingCount() < settings.suggestionMinEvents) return undefined
      const lastTs = ledger.pendingLastTs()
      if (lastTs === null || now() - lastTs < settings.suggestionSilenceSeconds * 1000) return undefined
      if (!ledger.hasPendingSwitches()) {
        // Only clipboard events since the last pass: nothing to cluster; mark them seen.
        ledger.markSeen()
        return undefined
      }
      return runAnalysis()
    },
    analyzeNow(): Promise<TaskProposal[]> {
      if (!ledger.hasPendingSwitches()) return Promise.resolve([])
      return runAnalysis()
    },
    suggestions(): readonly TaskProposal[] {
      return pending
    },
    propose(proposals: TaskProposal[]): void {
      // 控制器（56）的缓冲是决策提案的唯一事实源：上一批整体移除，新缓冲
      // 追加（其 ≤3 FIFO / 同 key 替换已在 handleDecisionOutputs 完成）。
      // t57 review BLOCK-1 双保险：已采纳/已忽略的决策提案即使仍在入站批
      // （在途推送）也不复活。
      const fresh = proposals.filter((p) => !consumedDecisionIds.has(p.id))
      pending = pending.filter((p) => !decisionProposalIds.has(p.id))
      for (const p of fresh) {
        if (!pending.some((x) => x.id === p.id)) pending.push(p)
      }
      decisionProposalIds = new Set(fresh.map((p) => p.id))
      onSuggestions(pending)
    },
    accept(id: string, opts?: AcceptOptions): Task['id'] | null {
      const suggestion = pending.find((s) => s.id === id)
      if (!suggestion) return null
      const m = meta.get(id)
      pending = pending.filter((s) => s.id !== id)
      meta.delete(id)
      // t57 review BLOCK-1：决策提案消费回流控制器缓冲（防下批复活）。
      if (suggestion.decisionId) {
        consumedDecisionIds.add(id)
        options.onProposalConsumed?.([id])
      }
      onSuggestions(pending)

      const title = opts?.title?.trim() || suggestion.title
      // t46 pattern learning: a user-edited title is the strongest signal
      // (intent tier user-edit) — detect it here, before the title lands.
      const titleEdited = title !== suggestion.title
      // t57: 决策提案无引擎 meta——apps 按卡自身身份数据兜底（appExePaths 平行
      // 数组优先，缺省按显示名归一化），与 Path A 卡的 meta.appRefs 同构。
      const apps = opts?.apps ?? m?.appRefs ?? appRefsFromProposal(suggestion)
      const resources = opts?.clipboardRefs ?? suggestion.clipboardRefs ?? []
      const emitMemoryCandidate = (): void => {
        // Feedback distillation (spec decision 7): a confirmed work pattern
        // becomes a suggested memory candidate — never live without the user.
        const candidate = buildMemoryCandidate(title)
        if (candidate) options.onMemorySuggestion?.(candidate)
      }
      // All landing decisions — new / update / merge — funnel through the
      // store's commit seam (t38); the engine only resolves the payload
      // and records the outcome.
      const existing = new Set(store.list().map((t) => t.id))
      const taskId = store.commit(suggestion, {
        title: opts?.title,
        note: opts?.note,
        apps,
        windowTitles: m?.windowTitles,
        clipboardRefs: resources
      })
      const merged = taskId !== null && existing.has(taskId)
      console.log(
        merged
          ? `[Suggestion] accepted ${id} -> merged into ${taskId}`
          : `[Suggestion] accepted ${id} -> new task ${taskId ?? '(none)'}`
      )
      emitMemoryCandidate()
      log({ kind: 'accept', suggestionId: id, title, taskId: taskId ?? null, merged, apps: apps.length, clipboardRefs: resources.length, titleEdited })
      // t46 record point: accepted outcome + actionReason (user_confirmed, or
      // user_edited_title when the user rewrote the title — strongest signal).
      // t47: level = 展示时刻分级（随 noop 落库后回填，分级结果落记录）；patternKey
      // 携带跨小时桶的"同类"键供评级消费。t57: 决策提案（无 meta）按卡自身
      // 身份数据推导指纹/分级键，其余语义与 Path A 一致。
      if (options.history) {
        const appKeys = m ? m.appRefs.map((a) => a.id) : appKeysFromProposal(suggestion)
        // 缺段起始时刻用当前时钟（t57 review NIT-4）：?? 0 落 epoch 小时桶
        // 会与所有缺字段卡共享冷却键，失真。
        const startTs = m ? m.segmentStartTs : (suggestion.segmentStartTs ?? now())
        options.history.record({
          fingerprint: recommendationFingerprint(appKeys, startTs),
          patternKey: recommendationPatternKey(appKeys),
          level: m?.level ?? suggestion.level ?? 1,
          outcome: 'accepted',
          actionReason: titleEdited ? 'user_edited_title' : 'user_confirmed'
        })
      }
      // t57 模式反馈（spec 决策 9）：采纳 → 调用方把匹配的 pattern 事实确认
      // 强化（意图档升档 + hitCount+1 + 权重上调）。
      options.onPatternFeedback?.({
        kind: 'accepted',
        actionReason: titleEdited ? 'user_edited_title' : 'user_confirmed',
        appCombination: suggestion.evidence.appCombination,
        appNames: suggestion.appNames,
        taskTitle: title,
        now: now()
      })
      // t57 决策链结果回填（spec 决策 8）：结果行与 observed/decision 共享
      // decisionId；Path A 卡（无 decisionId）不写（无链可回填）。
      if (options.trace && suggestion.decisionId) {
        const actionReason = titleEdited ? 'user_edited_title' : 'user_confirmed'
        options.trace.append({
          decisionId: suggestion.decisionId,
          kind: 'result',
          payload: { outcome: merged ? 'merged' : 'accepted', proposalId: id, taskId: taskId ?? undefined, actionReason },
          taskId: taskId ?? undefined
        })
      }
      return taskId
    },
    ignore(id: string, reason?: IgnoreReason): boolean {
      const suggestion = pending.find((s) => s.id === id)
      const m = meta.get(id)
      pending = pending.filter((s) => s.id !== id)
      meta.delete(id)
      // t57 review BLOCK-1：决策提案消费回流控制器缓冲（防下批复活）。
      if (suggestion?.decisionId) {
        consumedDecisionIds.add(id)
        options.onProposalConsumed?.([id])
      }
      if (m) {
        ledger.dismiss(m.signature)
      }
      // t46 record point: ignored outcome + actionReason（忽略原因，缺省
      // 视为不感兴趣）。忽略仍走既有 LRU（ledger.dismiss），行为不回归。
      // t47: level = 展示时刻分级（回填保持展示分级），patternKey 同类键。
      // t57: 决策提案（无 meta、无签名）同样落历史——指纹冷却防同类反复
      // 打扰（blockedSignatures 含历史冷却，建议构建与后续决策都受益）。
      if (options.history && suggestion) {
        const appKeys = m ? m.appRefs.map((a) => a.id) : appKeysFromProposal(suggestion)
        // 缺段起始时刻用当前时钟（t57 review NIT-4），理由同 accept。
        const startTs = m ? m.segmentStartTs : (suggestion.segmentStartTs ?? now())
        const actionReason = reason ? ignoreReasonToActionReason(reason) : 'user_manually_dismissed'
        options.history.record({
          fingerprint: recommendationFingerprint(appKeys, startTs),
          patternKey: recommendationPatternKey(appKeys),
          level: m?.level ?? suggestion.level ?? 1,
          outcome: 'ignored',
          actionReason
        })
        // t57 模式反馈（spec 决策 9）：忽略 → 调用方把匹配的 pattern 事实置
        // ignored（默认检索排除；原因级衰减在 t46 已按 ACTION_REASON_DECAY 兑现）。
        options.onPatternFeedback?.({
          kind: 'ignored',
          actionReason,
          appCombination: suggestion.evidence.appCombination,
          appNames: suggestion.appNames,
          now: now()
        })
        // t57 决策链结果回填（spec 决策 8）：结果行与决策链共享 decisionId。
        if (options.trace && suggestion.decisionId) {
          options.trace.append({
            decisionId: suggestion.decisionId,
            kind: 'result',
            payload: { outcome: 'ignored', proposalId: id, actionReason }
          })
        }
        if (m) log({ kind: 'ignore', suggestionId: id, signature: m.signature, actionReason })
        else log({ kind: 'ignore', suggestionId: id, actionReason })
      }
      onSuggestions(pending)
      return suggestion !== undefined
    },
    setChat(fn: ChatFn): void {
      chat = fn
    },
    setOcr(fn: OcrFn): void {
      ocr = fn
    }
  }
}

/** Fixed tick cadence for the production timer (index.ts). */
export { TICK_INTERVAL_MS }
