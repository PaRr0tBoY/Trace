/**
 * SuggestionEngine — quiet-period trigger + suggestion lifecycle (t19).
 *
 * The glue between the event bus (t12), the clustering pipeline (t16) and
 * the provider chain (t15). Pure module: no Electron imports, everything the
 * engine needs is injected so vitest drives it with a fake clock, a fake bus
 * and a real TaskStore.
 *
 * Pipeline per analysis (spec 实现决策 5):
 *   1. Trigger — at least `suggestionMinEvents` events arrived since the
 *      last analysis AND no new event for `suggestionSilenceSeconds`.
 *   2. clusterEvents (t16) attributes segments to tasks; each attribution
 *      becomes a TaskProposal unless its signature is on the ignored table.
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
 *      suggestions, and only for title + rationale (never the attribution
 *      decision). One batched call for the whole analysis; when no provider
 *      is configured or the chain fails, the pass degrades silently to pure
 *      algorithm: temporary titles like "Code + Chrome task", no rationale.
 *
 * TaskProposal lifecycle: pending proposals are transient and in-memory
 * only — never persisted (restart clears them). Accept merges into the
 * candidate task (type-safe, TaskStore.merge) or creates a new one; ignore
 * writes the signature into the ignored table and drops the card. A new
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
import { clusterEvents, normalizeAppKey, type ClusterParams, type SegmentInfo } from './clusterer'
import type { ChatRequest, ChatResult } from './provider'
import type { SuggestTitleContext } from '../../shared/ipc'
import { algorithmicTitle } from '../../shared/titles'
import { createId } from '../store/ids'
import { suggestionSignature, type IgnoredTable } from './ignored'
import { buildClipboardRef, type TaskStore } from '../store/TaskStore'
import type {
  AppRef,
  AppSwitchEvent,
  ClipboardEvent,
  ClipboardItem,
  Memory,
  MemoryType,
  ResourceRef,
  TaskProposal,
  Task,
  TaskPatch,
  UsageEvent
} from '../../shared/types'

/** Segmenting defaults are fixed for V1 (settings carry only the confidence thresholds). */
const SEGMENT_PARAMS = { hardGapMs: 600_000, transientMs: 2_500, overlapThreshold: 0.3 } as const

const MAX_TITLE_CHARS = 60
const MAX_REASON_CHARS = 300
const MAX_LLM_CANDIDATES = 8
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

/** The subset of settings the engine reads live on every tick. */
export interface SuggestionSettings {
  suggestionMinEvents: number
  suggestionSilenceSeconds: number
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
  ignored: IgnoredTable
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
}

/** Per-suggestion engine-side material the renderer never needs. */
interface TaskProposalMeta {
  appRefs: AppRef[]
  segmentStartTs: number
  signature: string
  /** Window titles of the source segment (LLM material only). */
  windowTitles: string[]
  /** Confirmed project/workflow memories this segment matched (LLM material). */
  memoryContext: string[]
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
  /** Ignore: drop the card and write its signature into the table. */
  ignore(id: string): boolean
  /** Wire the provider chain after construction (index.ts). */
  setChat(chat: ChatFn): void
  /** Wire the OCR capture after construction (index.ts); optional, silent when absent. */
  setOcr(ocr: OcrFn): void
  /**
   * Ask the provider chain for 1-3 title candidates for a task draft
   * (task:suggest-title). Null when no provider is configured, the chain
   * fails, or the reply doesn't validate.
   */
  suggestTitle(ctx: SuggestTitleContext): Promise<string[] | null>
}

export function createSuggestionEngine(options: SuggestionEngineOptions): SuggestionEngine {
  const { now, readEvents, store, getSettings, ignored, onSuggestions } = options
  const log = options.log ?? (() => {})
  let chat: ChatFn | undefined = options.chat
  let ocr: OcrFn | undefined = undefined
  let running = false
  let analyzing = false
  /** Max event ts covered by the last analysis; only newer events re-trigger. */
  let lastAnalyzedTs = 0
  let pending: TaskProposal[] = []
  const meta = new Map<string, TaskProposalMeta>()

  function buildParams(settings: SuggestionSettings): ClusterParams {
    return {
      ...SEGMENT_PARAMS,
      confidenceHigh: settings.confidenceHigh,
      confidenceLow: settings.confidenceLow
    }
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
   * Assign clipboard events to the segment whose window contains the copy:
   * each segment owns [startTs, next segment's startTs); copies after the
   * final app switch stay with the last segment (no new switch means the
   * session never visibly ended). Resolves refs through `readItem`; items
   * evicted between copy and analysis are skipped.
   */
  function clipboardRefsBySegment(
    segments: SegmentInfo[],
    events: ClipboardEvent[]
  ): ResourceRef[][] {
    const out: ResourceRef[][] = segments.map(() => [])
    if (!options.readItem || events.length === 0 || segments.length === 0) return out
    for (const e of events) {
      let idx = segments.length - 1
      for (let i = 0; i < segments.length; i++) {
        if (e.ts < segments[i].startTs) {
          idx = Math.max(0, i - 1)
          break
        }
      }
      if (!e.itemId) continue
      const item = options.readItem(e.itemId)
      if (!item) continue
      out[idx].push(buildClipboardRef(item))
    }
    return out
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

  /** One analysis pass: cluster the new batch, dedupe, annotate, push. */
  async function runAnalysis(newEvents: UsageEvent[]): Promise<TaskProposal[]> {
    analyzing = true
    try {
      const settings = getSettings()
      const tasks = [...store.list()]
      const appSwitches = newEvents.filter((e): e is AppSwitchEvent => e.type === 'app-switch')
      const clipEvents = newEvents.filter((e): e is ClipboardEvent => e.type === 'clipboard')
      // OCR only when a provider exists to consume it — no AI config means
      // no screen capture at all (performance guard, t30).
      const [result, ocrText] = await Promise.all([
        clusterEvents(appSwitches, tasks, buildParams(settings)),
        chat ? runOcrOnce() : Promise.resolve(null)
      ])
      const refsBySegment = clipboardRefsBySegment(result.attributions.map((a) => a.segment), clipEvents)

      const built: Array<{ suggestion: TaskProposal; meta: TaskProposalMeta }> = []
      for (let i = 0; i < result.attributions.length; i++) {
        const attr = result.attributions[i]
        const appRefs = appRefsFromSegment(attr.segment.appKeys, attr.segment.appNames)
        if (appRefs.length === 0) continue
        const signature = suggestionSignature(attr.segment.appKeys, attr.segment.startTs)
        if (ignored.has(signature)) continue

        const target = attr.taskId ? tasks.find((t) => t.id === attr.taskId) : undefined
        // Icon extraction prefers original-case exePaths; the normalized
        // identity key is the fallback when no raw path is known.
        const appExePaths = attr.segment.appKeys.slice(0, 5).map((key) => latestSwitchFor(key)?.exePath ?? key)
        const suggestion: TaskProposal = {
          id: `s_${createId()}`,
          title: target ? target.title : algorithmicTitle(attr.segment.appNames),
          appNames: attr.segment.appNames.slice(0, 5),
          appExePaths,
          confidence: attr.confidence,
          lowConfidence: attr.zone === 'low',
          algorithmReason: algorithmReason(attr, target),
          evidence: {
            appCombination: attr.evidence.appCombination,
            durationMs: attr.evidence.durationMs,
            overlappingTasks: attr.evidence.overlappingTasks
          },
          taskId: attr.taskId ?? undefined,
          // The material copied during the segment's window (isomorphic with
          // a task's resources — the card and the convert panel show these).
          clipboardRefs: refsBySegment[i]
        }
        built.push({ suggestion, meta: { appRefs, segmentStartTs: attr.segment.startTs, signature, windowTitles: attr.segment.windowTitles.slice(0, 3), memoryContext: [] } })
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

      pending = built.map((b) => b.suggestion)
      meta.clear()
      for (const b of built) meta.set(b.suggestion.id, b.meta)
      lastAnalyzedTs = newEvents.length > 0 ? newEvents[newEvents.length - 1].ts : lastAnalyzedTs

      const mode = llmOk ? 'llm' : 'algorithm'
      const ocrNote = ocrText ? `, ocr: ${ocrText.length} chars` : ''
      console.log(
        `[Suggestion] analysis: ${newEvents.length} events -> ${result.attributions.length} segments -> ${pending.length} suggestions (mode: ${mode}${ocrNote})`
      )
      log({
        kind: 'analysis',
        events: newEvents.length,
        mode,
        ocrChars: ocrText?.length,
        segments: result.attributions.map((a) => ({
          apps: a.segment.appNames.slice(0, 5),
          durationMs: a.segment.durationMs,
          windowTitles: a.segment.windowTitles.slice(0, 3),
          confidence: a.confidence,
          zone: a.zone,
          taskId: a.taskId
        })),
        suggestions: built.map((b) => ({
          id: b.suggestion.id,
          title: b.suggestion.title,
          llmTitle: llmOk,
          confidence: b.suggestion.confidence,
          apps: b.suggestion.appNames,
          clipboardRefs: b.suggestion.clipboardRefs?.length ?? 0,
          reason: b.suggestion.reason
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
      const events = readEvents()
      if (events.length > 0) lastAnalyzedTs = events[events.length - 1].ts
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
      const events = readEvents().filter((e) => e.ts > lastAnalyzedTs)
      if (events.length < settings.suggestionMinEvents) return undefined
      const lastTs = events[events.length - 1].ts
      if (now() - lastTs < settings.suggestionSilenceSeconds * 1000) return undefined
      const switches = events.filter((e): e is AppSwitchEvent => e.type === 'app-switch')
      if (switches.length === 0) {
        // Only clipboard events since the last pass: nothing to cluster; mark them seen.
        lastAnalyzedTs = events[events.length - 1].ts
        return undefined
      }
      // The full batch travels into the analysis — clipboard events carry the
      // material for the suggestions' clipboardRefs.
      return runAnalysis(events)
    },
    analyzeNow(): Promise<TaskProposal[]> {
      const events = readEvents().filter((e) => e.ts > lastAnalyzedTs)
      const switches = events.filter((e): e is AppSwitchEvent => e.type === 'app-switch')
      if (switches.length === 0) return Promise.resolve([])
      return runAnalysis(events)
    },
    suggestions(): readonly TaskProposal[] {
      return pending
    },
    accept(id: string, opts?: AcceptOptions): Task['id'] | null {
      const suggestion = pending.find((s) => s.id === id)
      if (!suggestion) return null
      const m = meta.get(id)
      pending = pending.filter((s) => s.id !== id)
      meta.delete(id)
      onSuggestions(pending)

      const title = opts?.title?.trim() || suggestion.title
      const apps = opts?.apps ?? m?.appRefs ?? []
      const resources = opts?.clipboardRefs ?? suggestion.clipboardRefs ?? []
      // Evidence captured at accept time (t27): the segment's recent window
      // titles, the confidence shown on the card, and a human-readable reason
      // — LLM rationale when present, else the algorithm evidence summary.
      const evidence: TaskPatch = {
        windowTitles: m?.windowTitles ?? [],
        confidence: suggestion.confidence,
        reason: suggestion.reason?.trim() || suggestion.algorithmReason,
        ...(opts?.note !== undefined ? { note: opts.note } : {})
      }
      const emitMemoryCandidate = (): void => {
        // Feedback distillation (spec decision 7): a confirmed work pattern
        // becomes a suggested memory candidate — never live without the user.
        const candidate = buildMemoryCandidate(title)
        if (candidate) options.onMemorySuggestion?.(candidate)
      }
      if (suggestion.taskId && store.get(suggestion.taskId)) {
        if (opts?.title?.trim()) evidence.title = opts.title.trim()
        store.update(suggestion.taskId, evidence)
        // Absorb the segment's apps + clipboard material through the type-safe
        // merge path: create a temp task carrying them, then merge it into the
        // candidate (source is deleted; apps/resources/timestamps are combined
        // by TaskStore.merge).
        const temp = store.create(title, { apps, resources })
        if (temp) store.merge(suggestion.taskId, temp.id)
        console.log(`[Suggestion] accepted ${id} -> merged into ${suggestion.taskId}`)
        emitMemoryCandidate()
        log({ kind: 'accept', suggestionId: id, title, taskId: suggestion.taskId, merged: true, apps: apps.length, clipboardRefs: resources.length })
        return suggestion.taskId
      }
      const created = store.create(title, { apps, resources, ...evidence })
      console.log(`[Suggestion] accepted ${id} -> new task ${created?.id ?? '(none)'}`)
      emitMemoryCandidate()
      log({ kind: 'accept', suggestionId: id, title, taskId: created?.id ?? null, merged: false, apps: apps.length, clipboardRefs: resources.length })
      return created?.id ?? null
    },
    ignore(id: string): boolean {
      const m = meta.get(id)
      pending = pending.filter((s) => s.id !== id)
      meta.delete(id)
      if (m) ignored.add(m.signature)
      onSuggestions(pending)
      if (m) log({ kind: 'ignore', suggestionId: id, signature: m.signature })
      return m !== undefined
    },
    setChat(fn: ChatFn): void {
      chat = fn
    },
    setOcr(fn: OcrFn): void {
      ocr = fn
    },
    async suggestTitle(ctx: SuggestTitleContext): Promise<string[] | null> {
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
        const hits = matchMemories(
          [{ appNames: ctx.appNames, windowTitles: draftParts }],
          options.readMemories()
        )
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
        timeoutMs: LLM_TIMEOUT_MS
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
        const title = sanitizeString(raw, MAX_TITLE_CHARS)
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

/** Fixed tick cadence for the production timer (index.ts). */
export { TICK_INTERVAL_MS }
