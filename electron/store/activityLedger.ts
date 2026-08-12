/**
 * ActivityLedger — the clustering module (t40, spec 实现决策 3).
 *
 * The suggestion clustering pipeline (t16) moved here wholesale: trigger
 * cursor, segmentation params, attribution, signature generation and the
 * ignored-table gate. It turns the evidence timeline (t39) into observed
 * Activity objects — app set, window titles, dwell, clipboard material and
 * attribution target, stamped with classifier version. Activities are
 * observations and are never persisted; every activity can be traced back to
 * the events that constitute it (eventsOf / the [startAt, endAt] window).
 *
 * No Electron imports: the timeline, the task list, the clustering params and
 * the ignored table are all injected, so vitest drives it with the memory
 * evidence store. Behavior of the algorithm path is unchanged from t16 — the
 * migrated clusterer tests are the proof.
 *
 * Pipeline (spec 实现决策 5 / research 10):
 *   1. Segmenting. Hard split on gaps ≥ hardGapMs. Gaps < transientMs are
 *      transients (mis-clicks, rapid switching) and merge into the preceding
 *      events — no boundary at all. Gaps in between are soft boundaries that
 *      survive only when neighbouring candidate segments share <
 *      overlapThreshold of their apps. Pure timeouts are not enough
 *      (SIGIR 2020): app-overlap is the second signal.
 *   2. Rule prefilter. Only tasks sharing ≥1 app with the batch are
 *      candidates; clustering never reaches outside this pool.
 *   3. Incremental assignment. Per-task summaries (app set + title tokens)
 *      are re-derived from the Task[] on every run — the store is the source
 *      of truth across runs, this module stays a pure function of its inputs.
 *      A merged segment's apps are absorbed into the winning summary (set
 *      union), so later segments in the same batch see the updated app
 *      centroid (BIRCH/CluStream-style incremental absorption). Title
 *      similarity always compares against the task's canonical title —
 *      window titles are per-run evidence, not centroid material, and this
 *      keeps the token and embedding paths identical by construction.
 *   4. Confidence. best = top similarity, margin = best − second. Zones:
 *        best < θ_low                            → 'new'  (new candidate)
 *        best ≥ θ_high ∧ margin ≥ θ_high − θ_low → 'high' (merge)
 *        otherwise                               → 'low'  (merge, pending confirm)
 *      The margin floor is the width of the ambiguous band: a segment that
 *      nearly ties two tasks is never high-confidence even when its best
 *      score clears θ_high.
 *
 * Embedding is an optional channel. When present, title similarity is
 * cosine over one batched embed call; when absent — or when the channel
 * throws or returns malformed rows — the pipeline silently degrades to
 * token Jaccard (research 10 §7.4.4: embedding outage must not block
 * analysis, and never in the user's face).
 *
 * Scoring: 0.7 · Jaccard(app sets) + 0.3 · title similarity. Apps dominate
 * because L0 window titles are the noisier signal (research 10 risk 1).
 * App identity is the display name, falling back to the exePath-normalized
 * id; name collisions between distinct executables are accepted for V1.
 *
 * Out of scope by contract: cross-batch summaries, time decay (memory
 * layer), title generation / rationale text (LLM layer), persistence (t19),
 * sessions (t37 — the ledger observes, it does not interpret).
 */
import type { AppRef, AppSwitchEvent, Task } from '../../shared/types'
import type { EvidenceEvent, EvidenceStore } from './evidenceStore'
import { MAX_EVIDENCE_QUERY_LIMIT } from './evidenceStore'
import { createId } from './ids'
import type { IgnoredTable } from '../main/ignored'

/** All thresholds come from the caller (settings values in prod, t19). */
export interface ClusterParams {
  /** Gap ≥ this splits segments unconditionally (ms). */
  hardGapMs: number
  /** Gap < this is a transient switch, merged into the preceding events (ms). */
  transientMs: number
  /** Adjacent candidate segments sharing less of their apps than this split. */
  overlapThreshold: number
  /** θ_high: at/above this a segment merges unconditionally (0-1, > θ_low). */
  confidenceHigh: number
  /** θ_low: below this a segment starts a new candidate (0-1). */
  confidenceLow: number
}

/**
 * Segmentation defaults only — the confidence thresholds are settings
 * values and deliberately have no default here (t19 injects them).
 */
export const DEFAULT_SEGMENT_PARAMS = {
  hardGapMs: 600_000, // ~10 min
  transientMs: 2_500, // ~2-3 s
  overlapThreshold: 0.3
} as const

/** Optional embedding backend (t19 wires it up; missing = token fallback). */
export interface EmbeddingChannel {
  /** Batch embed; resolves one row per input text, in input order. */
  embed(texts: string[]): Promise<number[][]>
}

export type ConfidenceZone = 'high' | 'low' | 'new'

/** One dwell segment of the event batch. */
export interface SegmentInfo {
  startTs: number
  endTs: number
  durationMs: number
  eventCount: number
  /** App display names, most-dwelled first. */
  appNames: string[]
  /**
   * App identity keys (lowercase exePath, fallback appName), most-dwelled
   * first and index-aligned with appNames. Exposed for the suggestion
   * engine (t19) to build AppRefs and ignore signatures — the clusterer's
   * own matching keeps its name-first internal keys.
   */
  appKeys: string[]
  /** Dwell per app identity (ms), index-aligned with appKeys — Activity apps material. */
  appDurationsMs: number[]
  /** Unique window titles per app identity, most-dwelled first, index-aligned with appKeys. */
  appWindows: string[][]
  /** Unique window titles, most-dwelled first (LLM/evidence material). */
  windowTitles: string[]
  /** Noise-filtered title tokens (deterministic order). */
  titleTokens: string[]
}

/** Per-segment attribution outcome. */
export interface Attribution {
  segment: SegmentInfo
  /** Merged task id; null = new candidate. */
  taskId: string | null
  zone: ConfidenceZone
  /** The similarity score against the best candidate (0-1). */
  confidence: number
  bestScore: number
  secondScore: number
  /** best − second (0 with a single candidate). */
  margin: number
  /** Algorithmic evidence for the suggestion card (t19 renders it). */
  evidence: {
    appCombination: string
    durationMs: number
    overlappingTasks: string[]
    bestScore: number
    margin: number
  }
}

export interface ClusterResult {
  attributions: Attribution[]
}

const APP_WEIGHT = 0.7
const TITLE_WEIGHT = 1 - APP_WEIGHT
const MAX_EVIDENCE_APPS = 5
const MAX_OVERLAPPING_TASKS = 3
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'with',
  'by', 'from', 'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that', 'as',
  'into', 'over', 'under', 'about'
])

/** Internal per-segment working view. */
interface InternalSegment {
  info: SegmentInfo
  appKeys: Set<string>
  titleTokens: Set<string>
  /** Unique window titles joined in dwell order; '' when titles are empty. */
  titleText: string
}

/** Per-task centroid summary for one run. */
interface TaskSummary {
  taskId: string
  title: string
  appKeys: Set<string>
  titleTokens: Set<string>
}

export function validateParams(params: ClusterParams): void {
  const { hardGapMs, transientMs, overlapThreshold, confidenceHigh, confidenceLow } = params
  const finite = (v: number) => typeof v === 'number' && Number.isFinite(v)
  const problems: string[] = []
  if (!finite(hardGapMs) || hardGapMs <= 0) problems.push('hardGapMs must be a finite number > 0')
  if (!finite(transientMs) || transientMs <= 0) problems.push('transientMs must be a finite number > 0')
  if (finite(hardGapMs) && finite(transientMs) && hardGapMs <= transientMs) {
    problems.push('hardGapMs must be greater than transientMs')
  }
  if (!finite(overlapThreshold) || overlapThreshold < 0 || overlapThreshold > 1) {
    problems.push('overlapThreshold must be in [0, 1]')
  }
  if (!finite(confidenceHigh) || confidenceHigh <= 0 || confidenceHigh > 1) {
    problems.push('confidenceHigh must be in (0, 1]')
  }
  if (!finite(confidenceLow) || confidenceLow <= 0 || confidenceLow >= 1) {
    problems.push('confidenceLow must be in (0, 1)')
  }
  if (finite(confidenceHigh) && finite(confidenceLow) && confidenceHigh <= confidenceLow) {
    problems.push('confidenceHigh must be greater than confidenceLow')
  }
  if (problems.length > 0) throw new Error(`[Cluster] invalid params: ${problems.join('; ')}`)
}

/**
 * Window-title tokens: ASCII words (min 2 chars, no pure digits, no
 * stopwords) plus overlapping CJK bigrams — Chinese titles have no spaces
 * to split on, and bigrams are the cheapest usable unit (research 10 risk 1:
 * drop version-number noise, keep the rest).
 */
export function tokenizeTitle(title: string): string[] {
  const tokens: string[] = []
  const lower = title.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    const t = m[0]
    if (t.length >= 2 && !/^[0-9]+$/.test(t) && !STOPWORDS.has(t)) tokens.push(t)
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    if (run.length === 1) tokens.push(run)
    else for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

/** Lowercase + slash-normalize an app identity string. */
export function normalizeAppKey(s: string): string {
  return s.trim().toLowerCase().replace(/\\/g, '/')
}

/** Display name first — events and AppRefs meet on the name; exePath is the fallback. */
function eventAppKey(e: AppSwitchEvent): string | null {
  const k = normalizeAppKey(e.appName) || normalizeAppKey(e.exePath)
  return k.length > 0 ? k : null
}

function refAppKey(ref: AppRef): string | null {
  const k = normalizeAppKey(ref.name) || normalizeAppKey(ref.id)
  return k.length > 0 ? k : null
}

/** Jaccard similarity over two key sets; empty ∪ empty scores 0. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const k of a) if (b.has(k)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** Cosine similarity, clipped to [0, 1]; zero vectors score 0. */
function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return Math.min(1, Math.max(0, dot / Math.sqrt(na * nb)))
}

/**
 * Dwell time of the event at global index i: time until the next switch in
 * the whole batch; the batch's final event has none. Computed against the
 * global order so a segment's closing event still carries the boundary gap.
 */
function dwellAt(sorted: AppSwitchEvent[], i: number): number {
  return i + 1 < sorted.length ? sorted[i + 1].ts - sorted[i].ts : 0
}

function toInternalSegment(sorted: AppSwitchEvent[], range: number[]): InternalSegment {
  const identDwell = new Map<string, number>()
  const identDisplay = new Map<string, string>()
  const identTitleDwell = new Map<string, Map<string, number>>()
  const titleDwell = new Map<string, number>()
  const tokenCount = new Map<string, number>()
  const appKeys = new Set<string>()
  const titleTokens = new Set<string>()
  for (let p = 0; p < range.length; p++) {
    const e = sorted[range[p]]
    const dwell = dwellAt(sorted, range[p])
    const title = e.windowTitle.trim()
    const key = eventAppKey(e)
    if (key) appKeys.add(key)
    const ident = normalizeAppKey(e.exePath) || normalizeAppKey(e.appName)
    if (ident.length > 0) {
      identDwell.set(ident, (identDwell.get(ident) ?? 0) + dwell)
      const name = e.appName.trim()
      if (name.length > 0 && !identDisplay.has(ident)) identDisplay.set(ident, name)
      if (title.length > 0) {
        const perApp = identTitleDwell.get(ident) ?? new Map<string, number>()
        perApp.set(title, (perApp.get(title) ?? 0) + dwell)
        identTitleDwell.set(ident, perApp)
      }
    }
    if (title.length > 0) {
      titleDwell.set(title, (titleDwell.get(title) ?? 0) + dwell)
      for (const t of tokenizeTitle(title)) {
        titleTokens.add(t)
        tokenCount.set(t, (tokenCount.get(t) ?? 0) + 1)
      }
    }
  }
  const byDwellDesc = (a: [string, number], b: [string, number]) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : 1)
  // appKeys (ident space, exePath-first) is THE ordered key list; display
  // names are looked up per ident key in the same order — an independent
  // sort in the name key space could tie-break differently and misalign
  // the Activity.apps pairing (t40 review #3).
  const appIdentKeys = [...identDwell.entries()].sort(byDwellDesc).map(([k]) => k)
  const appNames = appIdentKeys.map((k) => identDisplay.get(k) ?? k)
  const windowTitles = [...titleDwell.entries()].sort(byDwellDesc).map(([t]) => t)
  const tokens = [...tokenCount.entries()].sort(byDwellDesc).map(([t]) => t)
  const first = sorted[range[0]].ts
  const last = sorted[range[range.length - 1]].ts
  return {
    info: {
      startTs: first,
      endTs: last,
      durationMs: Math.max(0, last - first),
      eventCount: range.length,
      appNames,
      appKeys: appIdentKeys,
      appDurationsMs: appIdentKeys.map((k) => identDwell.get(k) ?? 0),
      appWindows: appIdentKeys.map((k) => {
        const perApp = identTitleDwell.get(k)
        return perApp ? [...perApp.entries()].sort(byDwellDesc).map(([t]) => t) : []
      }),
      windowTitles,
      titleTokens: tokens
    },
    appKeys,
    titleTokens,
    titleText: windowTitles.join(' ')
  }
}

/**
 * Split an ascending event batch into dwell segments.
 * 1. Candidate boundaries where gap ≥ transientMs (transients never split).
 * 2. Adjacent candidates merge back when the gap is below hardGapMs and
 *    their app overlap is at least overlapThreshold — the soft signal.
 */
function buildSegments(events: AppSwitchEvent[], params: ClusterParams): InternalSegment[] {
  validateParams(params)
  if (events.length === 0) return []
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const candidates: number[][] = []
  let cur: number[] = [0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].ts - sorted[i - 1].ts >= params.transientMs) {
      candidates.push(cur)
      cur = []
    }
    cur.push(i)
  }
  candidates.push(cur)
  const appKeysOf = (range: number[]) => toInternalSegment(sorted, range).appKeys
  const merged: number[][] = [candidates[0]]
  for (let i = 1; i < candidates.length; i++) {
    const prev = merged[merged.length - 1]
    const next = candidates[i]
    const gap = sorted[next[0]].ts - sorted[prev[prev.length - 1]].ts
    if (gap < params.hardGapMs && jaccard(appKeysOf(prev), appKeysOf(next)) >= params.overlapThreshold) {
      merged[merged.length - 1] = prev.concat(next)
    } else {
      merged.push(next)
    }
  }
  return merged.map((range) => toInternalSegment(sorted, range))
}

/** Public stage: same pipeline, public segment views only. */
export function segmentEvents(events: AppSwitchEvent[], params: ClusterParams): SegmentInfo[] {
  return buildSegments(events, params).map((s) => s.info)
}

/**
 * Rule prefilter: tasks sharing at least one app with the batch. Runs
 * before any clustering — a segment can never attach to a task whose apps
 * are absent from the batch, no matter how similar the titles are.
 * Matches on display name OR normalized exePath/id (either may be missing
 * on one side); this is a superset gate, the similarity scoring still
 * decides the actual assignment.
 */
export function prefilterTasks(events: AppSwitchEvent[], tasks: Task[]): Task[] {
  const batchKeys = new Set<string>()
  for (const e of events) {
    const name = normalizeAppKey(e.appName)
    if (name) batchKeys.add(name)
    const exe = normalizeAppKey(e.exePath)
    if (exe) batchKeys.add(exe)
  }
  if (batchKeys.size === 0) return []
  return tasks.filter((t) => t.apps.some((ref) => {
    const name = normalizeAppKey(ref.name)
    const id = normalizeAppKey(ref.id)
    const exe = normalizeAppKey(ref.exePath ?? '')
    return (
      (name.length > 0 && batchKeys.has(name)) ||
      (id.length > 0 && batchKeys.has(id)) ||
      (exe.length > 0 && batchKeys.has(exe))
    )
  }))
}

function summarizeTask(task: Task): TaskSummary {
  const appKeys = new Set<string>()
  for (const ref of task.apps) {
    const k = refAppKey(ref)
    if (k) appKeys.add(k)
  }
  return {
    taskId: task.id,
    title: task.title,
    appKeys,
    titleTokens: new Set(tokenizeTitle(task.title))
  }
}

/**
 * Run the full pipeline: segment → prefilter → incremental attribution.
 * `embed` is optional; on any channel failure the run silently degrades to
 * the token path and the result is identical to calling without a channel.
 */
export async function clusterEvents(
  events: AppSwitchEvent[],
  tasks: Task[],
  params: ClusterParams,
  embed?: EmbeddingChannel
): Promise<ClusterResult> {
  validateParams(params)
  const internals = buildSegments(events, params)
  if (internals.length === 0) return { attributions: [] }
  const pool = prefilterTasks(events, tasks)
  const summaries = pool.map(summarizeTask)

  // One batched embed call for all texts (segments first, then summaries);
  // anything wrong with the channel = token path, silently.
  let embedRows: number[][] | null = null
  if (embed) {
    const texts = [...internals.map((s) => s.titleText), ...summaries.map((s) => s.title)]
    try {
      const rows = await embed.embed(texts)
      if (
        rows.length === texts.length &&
        rows.every((r) => Array.isArray(r) && r.length > 0 && r.length === rows[0].length && r.every(Number.isFinite))
      ) {
        embedRows = rows
      }
    } catch {
      embedRows = null
    }
  }

  const titleScore = (segIdx: number, sumIdx: number): number => {
    const seg = internals[segIdx]
    const sum = summaries[sumIdx]
    if (embedRows) {
      if (seg.titleText.length === 0 || sum.title.length === 0) return 0
      return cosine(embedRows[segIdx], embedRows[internals.length + sumIdx])
    }
    return jaccard(seg.titleTokens, sum.titleTokens)
  }

  const attributions: Attribution[] = []
  for (let segIdx = 0; segIdx < internals.length; segIdx++) {
    const seg = internals[segIdx]
    const scores = summaries.map((sum, sumIdx) => ({
      taskId: sum.taskId,
      title: sum.title,
      score: APP_WEIGHT * jaccard(seg.appKeys, sum.appKeys) + TITLE_WEIGHT * titleScore(segIdx, sumIdx)
    }))
    scores.sort((a, b) => b.score - a.score || (a.taskId < b.taskId ? -1 : 1))

    const best = scores[0]
    const bestScore = best?.score ?? 0
    const secondScore = scores[1]?.score ?? 0
    const margin = bestScore - secondScore
    const marginFloor = params.confidenceHigh - params.confidenceLow
    let zone: ConfidenceZone
    if (bestScore < params.confidenceLow) zone = 'new'
    else if (bestScore >= params.confidenceHigh && margin >= marginFloor) zone = 'high'
    else zone = 'low'

    const winner = zone === 'new' ? null : best ?? null
    if (winner) {
      const win = summaries.find((s) => s.taskId === winner.taskId)!
      for (const k of seg.appKeys) win.appKeys.add(k)
    }

    const overlapping = scores
      .filter((s) => s.score > 0 && s.taskId !== winner?.taskId)
      .slice(0, MAX_OVERLAPPING_TASKS)
      .map((s) => s.title)
    const apps = seg.info.appNames
    const appCombination =
      apps.slice(0, MAX_EVIDENCE_APPS).join(', ') +
      (apps.length > MAX_EVIDENCE_APPS ? ` (+${apps.length - MAX_EVIDENCE_APPS})` : '')

    attributions.push({
      segment: seg.info,
      taskId: winner?.taskId ?? null,
      zone,
      confidence: bestScore,
      bestScore,
      secondScore,
      margin,
      evidence: {
        appCombination,
        durationMs: seg.info.durationMs,
        overlappingTasks: overlapping,
        bestScore,
        margin
      }
    })
  }
  return { attributions }
}

/* ------------------------------------------------------------------ */
/*  Activity contract (spec 实现决策 3) + ledger entry point (t40)      */
/* ------------------------------------------------------------------ */

/**
 * FNV-1a over `sorted-app-keys#hour-bucket`, hex-encoded. Deterministic and
 * stable across runs: the key material is the app identity keys (lowercase
 * exePath, fallback appName) sorted ascending plus the hour the segment
 * started in — the same app combination in a later hour is a new session and
 * may be suggested again. Migrated verbatim from the suggestion engine's
 * ignore logic (t19); the ledger stamps it on every activity.
 */
export function suggestionSignature(appKeys: string[], segmentStartTs: number, bucketMs = 3_600_000): string {
  const keys = [...appKeys]
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .sort()
  const bucket = Math.floor(segmentStartTs / bucketMs)
  const material = `${keys.join('|')}#${bucket}`
  let hash = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0 // FNV prime, keep as uint32
  }
  return hash.toString(16)
}

/**
 * Semantic recommendation fingerprint (spec 决策 9: 语义簇 + 关键实体 + 时段).
 * v1 以活动签名为基础：语义簇与关键实体 = 排序应用键集合，时段 = 小时桶。
 * 版本前缀保证未来语义聚类指纹（semantic@2，本地模型开时）与 v1 不冲突；
 * 同活动重复生成同指纹（确定性，冷却/去重键）。t46 推荐历史模块以此为键，
 * 并在其模块中 re-export。
 */
export const FINGERPRINT_VERSION = 'semantic@1'
export function recommendationFingerprint(appKeys: string[], segmentStartTs: number, bucketMs = 3_600_000): string {
  return `${FINGERPRINT_VERSION}:${suggestionSignature(appKeys, segmentStartTs, bucketMs)}`
}

/**
 * 模式键（spec 决策 9 的"同类"）：排序应用键集合的语义簇散列，无时段成分。
 * 与 recommendationFingerprint 同源（同 FNV 材料、去掉小时桶），因此同一应用
 * 组合跨小时桶映射到同一模式键；冷却仍按指纹（含时段）逐小时桶生效，而级别/
 * 拒绝历史按模式键跨桶累积 —— L1 只能从 L2 升级、近期同类拒绝都以此为键
 * （t47 评级接入）。t46 推荐历史模块 re-export 本函数与指纹。
 */
export function recommendationPatternKey(appKeys: string[], bucketMs = 3_600_000): string {
  return `${FINGERPRINT_VERSION}:${suggestionSignature(appKeys, 0, bucketMs)}`
}

/** Version of the attribution classifier stamped on every activity (t40). */
export const CLASSIFIER_VERSION = 'clusterer@1'

/**
 * One app of an activity (spec 实现决策 3): identity key + display name +
 * dwell + the window titles seen on it, dwell-weighted.
 */
export interface ActivityApp {
  /** Normalized app identity key (lowercase exePath, fallback appName). */
  id: string
  /** Display name as observed on the switch events. */
  name: string
  /** Dwell inside the activity (ms). */
  durationMs: number
  /** Unique window titles on this app, most-dwelled first. */
  windows: string[]
}

/**
 * Activity — the observed object of the pipeline (spec 实现决策 3). Never
 * persisted; 1:N into TaskSessions later. Traceable: the events that
 * constitute it are `ledger.eventsOf(id)` while it is the most recent
 * analysis. For older activities, reconstruct the event set from the
 * evidence timeline: app-switch rows with capturedAt in [startAt, endAt]
 * (segments partition the batch, so the window is exact) plus clipboard
 * rows in the activity's window [startAt, next activity's startAt), or
 * [startAt, ∞) for the last activity — the same rule assignClipboardEvents
 * applies.
 */
export interface Activity {
  id: string
  startAt: number
  endAt: number
  apps: ActivityApp[]
  /** itemId refs of the copies made during the activity's window (source app via the evidence row). */
  clipboardRefs: string[]
  /** Present when the activity was attributed to a task (zones high/low). */
  attribution?: { taskId: string; confidence: number }
  /** App combination × time-slot signature (ignore/cooldown table material). */
  signature: string
  classifierVersion: string
  promptVersion?: string
  sessionId?: string
}

/**
 * Engine-side material for one activity the contract shape does not carry
 * (zone, evidence strings, window titles). Index-aligned with the
 * activities of an ActivityAnalysis; the suggestion engine (t19) renders
 * the proposal card from it.
 */
export interface ActivityDetail {
  /** Attribution zone ('high' | 'low' | 'new') — the low-confidence flag. */
  zone: ConfidenceZone
  /** Top similarity against the best candidate (0-1); attribution.confidence when attributed. */
  confidence: number
  /** Unique window titles, most-dwelled first (LLM/evidence material). */
  windowTitles: string[]
  /** Algorithmic evidence for the suggestion card. */
  evidence: {
    appCombination: string
    durationMs: number
    overlappingTasks: string[]
    /** best − second 聚类边距（t47 评级证据稳定判据；卡片不渲染）。 */
    margin: number
  }
}

/** One analysis pass: the observable activities plus engine-side detail. */
export interface ActivityAnalysis {
  /** Non-ignored activities in time order. */
  activities: Activity[]
  /** Index-aligned with activities. */
  details: ActivityDetail[]
}

export interface ActivityLedgerOptions {
  /** Evidence timeline (SQLite in prod, memory impl in tests). */
  evidence: EvidenceStore
  /** Live task list — the attribution pool is re-derived on every run. */
  getTasks: () => readonly Task[]
  /** Clustering params (settings in prod): segmentation + confidence thresholds. */
  getParams: () => ClusterParams
  /** Dismissal table; activities whose signature is present are skipped. */
  ignored: IgnoredTable
  /**
   * Cooldown gate (t46): given a recommendation fingerprint (semantic@1:
   * app combination × hour bucket), true = suppress the activity this pass.
   * Consulted after the ignored table — both must pass for an activity to
   * become a suggestion. Absent = cooldown disabled (existing behavior).
   */
  cooling?: (fingerprint: string) => boolean
  /** Optional embedding channel (title similarity); absent = token path. */
  embed?: EmbeddingChannel
  /** Classifier version stamped on activities; defaults to CLASSIFIER_VERSION. */
  classifierVersion?: string
  /** Prompt version stamped on activities (absent for the pure-algorithm path). */
  promptVersion?: string
}

/**
 * The ActivityLedger — owns the trigger cursor over the evidence timeline,
 * the clustering pipeline and the ignored-table gate (t40). Pure module:
 * the store, tasks, params and table are injected.
 */
export interface ActivityLedger {
  /** Baseline the trigger cursor at the newest timeline event (idempotent). */
  baseline(): void
  /** Unanalyzed events since the cursor (live timeline query, no stale cache). */
  pendingCount(): number
  /** True when any unanalyzed event is an app-switch (a clusterable batch). */
  hasPendingSwitches(): boolean
  /** Newest unanalyzed event timestamp, or null when nothing is pending. */
  pendingLastTs(): number | null
  /** Mark all pending events seen without clustering (clipboard-only pass). */
  markSeen(): void
  /**
   * Cluster the pending batch into activities and advance the cursor.
   * Activities whose signature is on the ignored table are dropped. On
   * failure (invalid params, unexpected store error) the cursor is left
   * untouched — the batch stays pending and the next pass retries it.
   */
  analyze(): Promise<ActivityAnalysis>
  /**
   * Traceability: the events that constitute one activity (copy of the
   * rows). Scope: the most recent analysis pass only — the trace map is
   * replaced on every pass and cleared on clipboard-only passes. Older
   * activities are reconstructable from the timeline via the [startAt,
   * endAt] switch window + clipboard window rule (see Activity docs).
   */
  eventsOf(activityId: string): EvidenceEvent[]
  /** Record a user dismissal into the ignored table. */
  dismiss(signature: string): void
}

/** Map an app-switch evidence row back to the clusterer's event shape. */
function toAppSwitchEvent(row: EvidenceEvent): AppSwitchEvent {
  const payload = row.payload ?? {}
  const rawName = payload.appName
  const appName = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName : row.source
  const rawExe = payload.exePath
  const exePath = typeof rawExe === 'string' ? rawExe : ''
  const pid = typeof payload.pid === 'number' ? payload.pid : 0
  return {
    type: 'app-switch',
    appName,
    exePath,
    pid,
    windowTitle: row.windowTitle ?? '',
    ts: row.capturedAt
  }
}

/**
 * Assign clipboard rows to the segment whose window contains the copy:
 * each segment owns [startTs, next segment's startTs); copies after the
 * final app switch stay with the last segment (no new switch means the
 * session never visibly ended). Migrated verbatim from the suggestion
 * engine (t19); returns the itemId refs and the rows for traceability.
 */
function assignClipboardEvents(
  segments: SegmentInfo[],
  clips: EvidenceEvent[]
): Array<{ itemIds: string[]; rows: EvidenceEvent[] }> {
  const out: Array<{ itemIds: string[]; rows: EvidenceEvent[] }> = segments.map(() => ({ itemIds: [], rows: [] }))
  if (clips.length === 0 || segments.length === 0) return out
  for (const e of clips) {
    let idx = segments.length - 1
    for (let i = 0; i < segments.length; i++) {
      if (e.capturedAt < segments[i].startTs) {
        idx = Math.max(0, i - 1)
        break
      }
    }
    out[idx].rows.push(e)
    const itemId = e.payload?.itemId
    if (typeof itemId === 'string' && itemId.length > 0) out[idx].itemIds.push(itemId)
  }
  return out
}

function buildActivity(
  attr: Attribution,
  clipboardItemIds: string[],
  classifierVersion: string,
  promptVersion?: string
): { activity: Activity; detail: ActivityDetail } {
  const seg = attr.segment
  const apps: ActivityApp[] = seg.appKeys.map((id, i) => ({
    id,
    name: seg.appNames[i] ?? id,
    durationMs: seg.appDurationsMs[i] ?? 0,
    windows: seg.appWindows[i] ?? []
  }))
  const activity: Activity = {
    id: createId(),
    startAt: seg.startTs,
    endAt: seg.endTs,
    apps,
    clipboardRefs: clipboardItemIds,
    ...(attr.taskId !== null ? { attribution: { taskId: attr.taskId, confidence: attr.confidence } } : {}),
    signature: suggestionSignature(seg.appKeys, seg.startTs),
    classifierVersion,
    ...(promptVersion !== undefined ? { promptVersion } : {})
  }
  const detail: ActivityDetail = {
    zone: attr.zone,
    confidence: attr.confidence,
    windowTitles: seg.windowTitles,
    evidence: {
      appCombination: attr.evidence.appCombination,
      durationMs: attr.evidence.durationMs,
      overlappingTasks: attr.evidence.overlappingTasks,
      margin: attr.evidence.margin
    }
  }
  return { activity, detail }
}

export function createActivityLedger(options: ActivityLedgerOptions): ActivityLedger {
  const { evidence, getTasks, getParams, ignored } = options
  const classifierVersion = options.classifierVersion ?? CLASSIFIER_VERSION
  const promptVersion = options.promptVersion
  /** Max event ts covered by the last pass; only newer events re-trigger. */
  let cursor = 0
  /** activity id → constituent events of the last analysis. */
  let trace = new Map<string, EvidenceEvent[]>()

  /**
   * Fetch every unanalyzed row (newest-first pages, deduped by id, ascending).
   * No cross-tick cache: the timeline grows between ticks, and a stale
   * snapshot would permanently starve the trigger after a below-threshold
   * pass. Query cost is bounded (one page per tick in practice).
   */
  function loadPending(): EvidenceEvent[] {
    const seen = new Map<string, EvidenceEvent>()
    let offset = 0
    for (;;) {
      const page = evidence.query({ from: cursor + 1, limit: MAX_EVIDENCE_QUERY_LIMIT, offset })
      for (const row of page) if (!seen.has(row.id)) seen.set(row.id, row)
      if (page.length < MAX_EVIDENCE_QUERY_LIMIT) break
      offset += page.length
    }
    return [...seen.values()].sort((a, b) => a.capturedAt - b.capturedAt)
  }

  function advanceTo(rows: EvidenceEvent[]): void {
    if (rows.length > 0) {
      let max = rows[0].capturedAt
      for (let i = 1; i < rows.length; i++) if (rows[i].capturedAt > max) max = rows[i].capturedAt
      cursor = max
    }
  }

  return {
    baseline(): void {
      const newest = evidence.query({ limit: 1, offset: 0 })
      cursor = newest.length > 0 ? newest[0].capturedAt : 0
    },
    pendingCount(): number {
      return loadPending().length
    },
    hasPendingSwitches(): boolean {
      return loadPending().some((r) => r.kind === 'app-switch')
    },
    pendingLastTs(): number | null {
      const rows = loadPending()
      if (rows.length === 0) return null
      let max = rows[0].capturedAt
      for (let i = 1; i < rows.length; i++) if (rows[i].capturedAt > max) max = rows[i].capturedAt
      return max
    },
    markSeen(): void {
      advanceTo(loadPending())
    },
    async analyze(): Promise<ActivityAnalysis> {
      const rows = loadPending()
      const appSwitches = rows.filter((r) => r.kind === 'app-switch').map(toAppSwitchEvent)
      if (appSwitches.length === 0) {
        // Clipboard-only batch: nothing to cluster — consume it (markSeen
        // semantics, matches the engine's clipboard-only tick path).
        advanceTo(rows)
        trace = new Map()
        return { activities: [], details: [] }
      }
      const clips = rows.filter((r) => r.kind === 'clipboard')
      // Cluster BEFORE advancing the cursor: a failure (invalid params,
      // unexpected store error) must leave the batch pending for retry.
      const result = await clusterEvents(appSwitches, [...getTasks()], getParams(), options.embed)
      advanceTo(rows)
      const clipAssignments = assignClipboardEvents(
        result.attributions.map((a) => a.segment),
        clips
      )
      const traceNext = new Map<string, EvidenceEvent[]>()
      const activities: Activity[] = []
      const details: ActivityDetail[] = []
      for (let i = 0; i < result.attributions.length; i++) {
        const attr = result.attributions[i]
        if (ignored.has(suggestionSignature(attr.segment.appKeys, attr.segment.startTs))) continue
        if (options.cooling && options.cooling(recommendationFingerprint(attr.segment.appKeys, attr.segment.startTs))) continue
        const { activity, detail } = buildActivity(attr, clipAssignments[i].itemIds, classifierVersion, promptVersion)
        // The app-switch rows inside [startAt, endAt] — segments partition the
        // batch, so the window is exact — plus the clipboard rows assigned
        // here, time-ordered (stable for equal timestamps).
        traceNext.set(activity.id, [
          ...rows.filter((r) => r.kind === 'app-switch' && r.capturedAt >= activity.startAt && r.capturedAt <= activity.endAt),
          ...clipAssignments[i].rows
        ].sort((a, b) => a.capturedAt - b.capturedAt))
        activities.push(activity)
        details.push(detail)
      }
      trace = traceNext
      return { activities, details }
    },
    eventsOf(activityId: string): EvidenceEvent[] {
      const rows = trace.get(activityId)
      return rows ? rows.map((r) => ({ ...r, payload: r.payload ? { ...r.payload } : undefined })) : []
    },
    dismiss(signature: string): void {
      ignored.add(signature)
    }
  }
}
