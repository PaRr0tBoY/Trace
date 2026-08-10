/**
 * Clusterer — pure event-batch → segment → task-attribution pipeline (t16).
 *
 * No Electron imports, no logging on the happy path: a deterministic,
 * reproducible assignment of app-switch events to tasks. The caller (t19)
 * owns settings injection, triggering and suggestion lifecycle; this module
 * only decides "which task does this segment belong to, and how sure are we".
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
 * layer), title generation / rationale text (LLM layer), persistence (t19).
 */
import type { AppRef, AppSwitchEvent, Task } from '../../shared/types'

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
function normalizeAppKey(s: string): string {
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
  const appDwell = new Map<string, number>()
  const appDisplay = new Map<string, string>()
  const titleDwell = new Map<string, number>()
  const tokenCount = new Map<string, number>()
  const appKeys = new Set<string>()
  const titleTokens = new Set<string>()
  for (let p = 0; p < range.length; p++) {
    const e = sorted[range[p]]
    const dwell = dwellAt(sorted, range[p])
    const key = eventAppKey(e)
    if (key) {
      appKeys.add(key)
      appDwell.set(key, (appDwell.get(key) ?? 0) + dwell)
      if (e.appName.trim().length > 0 && !appDisplay.has(key)) appDisplay.set(key, e.appName.trim())
    }
    const title = e.windowTitle.trim()
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
  const appNames = [...appDwell.entries()].sort(byDwellDesc).map(([k]) => appDisplay.get(k) ?? k)
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


