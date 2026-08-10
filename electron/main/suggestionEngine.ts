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
 *      becomes a Suggestion unless its signature is on the ignored table.
 *   3. LLM annotation — only for low-confidence and new-candidate
 *      suggestions, and only for title + rationale (never the attribution
 *      decision). One batched call for the whole analysis; when no provider
 *      is configured or the chain fails, the pass degrades silently to pure
 *      algorithm: temporary titles like "Code + Chrome task", no rationale.
 *
 * Suggestion lifecycle: pending suggestions are transient and in-memory
 * only — never persisted (restart clears them). Accept merges into the
 * candidate task (type-safe, TaskStore.merge) or creates a new one; ignore
 * writes the signature into the ignored table and drops the card. A new
 * analysis replaces the whole pending list.
 *
 * Privacy (spec 铁律): the LLM call carries the event-batch summary (app
 * names, window titles, durations) and similar task titles — only to the
 * configured provider chain; cloud endpoints are explicit in settings (t15).
 *
 * Logging: `[Suggestion]` tag, one line per analysis (with mode), one line
 * per accept/ignore. No per-event noise.
 */
import { clusterEvents, type ClusterParams } from './clusterer'
import type { ChatRequest, ChatResult } from './provider'
import { createId } from '../store/ids'
import { suggestionSignature, type IgnoredTable } from './ignored'
import type { TaskStore } from '../store/TaskStore'
import type { AppRef, AppSwitchEvent, Suggestion, Task, UsageEvent } from '../../shared/types'

/** Segmenting defaults are fixed for V1 (settings carry only the confidence thresholds). */
const SEGMENT_PARAMS = { hardGapMs: 600_000, transientMs: 2_500, overlapThreshold: 0.3 } as const

const MAX_TITLE_CHARS = 60
const MAX_REASON_CHARS = 300
const MAX_LLM_CANDIDATES = 8
const TICK_INTERVAL_MS = 2_000
const LLM_TIMEOUT_MS = 20_000

/** The subset of settings the engine reads live on every tick. */
export interface SuggestionSettings {
  suggestionMinEvents: number
  suggestionSilenceSeconds: number
  confidenceHigh: number
  confidenceLow: number
}

/** Chat surface of the provider chain (injected; absent = algorithmic only). */
export type ChatFn = (req: ChatRequest) => Promise<ChatResult>

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
  onSuggestions: (suggestions: Suggestion[]) => void
}

/** Per-suggestion engine-side material the renderer never needs. */
interface SuggestionMeta {
  appRefs: AppRef[]
  segmentStartTs: number
  signature: string
  /** Window titles of the source segment (LLM material only). */
  windowTitles: string[]
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
  tick(): Promise<Suggestion[]> | undefined
  /** Run one analysis pass immediately (tests). Returns the pushed list. */
  analyzeNow(): Promise<Suggestion[]>
  /** Pending suggestions (transient). */
  suggestions(): readonly Suggestion[]
  /**
   * Accept: merge into the candidate task (title override renames it first)
   * or create a new task. Returns the accepted task id; null when the id
   * is stale (already replaced by a newer analysis).
   */
  accept(id: string, titleOverride?: string): Task['id'] | null
  /** Ignore: drop the card and write its signature into the table. */
  ignore(id: string): boolean
  /** Wire the provider chain after construction (index.ts). */
  setChat(chat: ChatFn): void
}

export function createSuggestionEngine(options: SuggestionEngineOptions): SuggestionEngine {
  const { now, readEvents, store, getSettings, ignored, onSuggestions } = options
  let chat: ChatFn | undefined = options.chat
  let running = false
  let analyzing = false
  /** Max event ts covered by the last analysis; only newer events re-trigger. */
  let lastAnalyzedTs = 0
  let pending: Suggestion[] = []
  const meta = new Map<string, SuggestionMeta>()

  function buildParams(settings: SuggestionSettings): ClusterParams {
    return {
      ...SEGMENT_PARAMS,
      confidenceHigh: settings.confidenceHigh,
      confidenceLow: settings.confidenceLow
    }
  }

  /** AppRefs from a segment: id = normalized exePath (attributor key space), name = display name. */
  function appRefsFromSegment(appKeys: string[], appNames: string[]): AppRef[] {
    const refs: AppRef[] = []
    for (let i = 0; i < appKeys.length; i++) {
      refs.push({ id: appKeys[i], name: appNames[i] ?? appKeys[i] })
    }
    return refs
  }

  function algorithmicTitle(appNames: string[]): string {
    const names = appNames.slice(0, 2).join(' + ')
    return names.length > 0 ? `${names} task` : 'Untitled task'
  }

  function algorithmReason(attr: { zone: string; confidence: number; evidence: { appCombination: string; durationMs: number; overlappingTasks: string[] } }, target: Task | undefined): string {
    const minutes = Math.max(1, Math.round(attr.evidence.durationMs / 60_000))
    const basis = attr.zone === 'new'
      ? `New activity pattern: ${attr.evidence.appCombination}, ${minutes} min, no matching task`
      : `Similar to "${target?.title ?? 'unknown'}" — ${attr.evidence.appCombination}, ${minutes} min`
    const overlaps = attr.evidence.overlappingTasks.slice(0, 2)
    return overlaps.length > 0 ? `${basis}; also near ${overlaps.join(', ')}` : basis
  }

  /** Batched LLM annotation for low-confidence + new-candidate suggestions. */
  async function annotateWithLlm(candidates: Array<{ suggestion: Suggestion; meta: SuggestionMeta }>): Promise<boolean> {
    if (!chat || candidates.length === 0) return false
    const segments = candidates.map((c) => ({
      apps: c.suggestion.appNames,
      windowTitles: c.meta.windowTitles,
      similarTasks: c.suggestion.evidence.overlappingTasks
    }))
    const req: ChatRequest = {
      messages: [
        {
          role: 'system',
          content:
            'You name short work sessions for a task tracker. Given a JSON list of activity segments, reply with JSON only: ' +
            '{"items": [{"title": "...", "reason": "..."}]}, one item per segment in the same order. ' +
            'title: a concise task title, at most 8 words, no quotes, written in the same language as the window titles. ' +
            'reason: one plain sentence explaining what this session looks like.'
        },
        { role: 'user', content: `Segments: ${JSON.stringify(segments)}` }
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

  /** One analysis pass: cluster the new batch, dedupe, annotate, push. */
  async function runAnalysis(newEvents: AppSwitchEvent[]): Promise<Suggestion[]> {
    analyzing = true
    try {
      const settings = getSettings()
      const tasks = [...store.list()]
      const result = await clusterEvents(newEvents, tasks, buildParams(settings))

      const built: Array<{ suggestion: Suggestion; meta: SuggestionMeta }> = []
      for (const attr of result.attributions) {
        const appRefs = appRefsFromSegment(attr.segment.appKeys, attr.segment.appNames)
        if (appRefs.length === 0) continue
        const signature = suggestionSignature(attr.segment.appKeys, attr.segment.startTs)
        if (ignored.has(signature)) continue

        const target = attr.taskId ? tasks.find((t) => t.id === attr.taskId) : undefined
        const suggestion: Suggestion = {
          id: `s_${createId()}`,
          title: target ? target.title : algorithmicTitle(attr.segment.appNames),
          appNames: attr.segment.appNames.slice(0, 5),
          confidence: attr.confidence,
          lowConfidence: attr.zone === 'low',
          algorithmReason: algorithmReason(attr, target),
          evidence: {
            appCombination: attr.evidence.appCombination,
            durationMs: attr.evidence.durationMs,
            overlappingTasks: attr.evidence.overlappingTasks
          },
          taskId: attr.taskId ?? undefined
        }
        built.push({ suggestion, meta: { appRefs, segmentStartTs: attr.segment.startTs, signature, windowTitles: attr.segment.windowTitles.slice(0, 3) } })
      }

      const llmCandidates = built.filter((b) => b.suggestion.taskId === undefined || b.suggestion.lowConfidence)
      const llmOk = llmCandidates.length > 0 ? await annotateWithLlm(llmCandidates.slice(0, MAX_LLM_CANDIDATES)) : false

      pending = built.map((b) => b.suggestion)
      meta.clear()
      for (const b of built) meta.set(b.suggestion.id, b.meta)
      lastAnalyzedTs = newEvents.length > 0 ? newEvents[newEvents.length - 1].ts : lastAnalyzedTs

      const mode = llmCandidates.length === 0 ? 'algorithm' : llmOk ? 'llm' : 'algorithm'
      console.log(
        `[Suggestion] analysis: ${newEvents.length} events -> ${result.attributions.length} segments -> ${pending.length} suggestions (mode: ${mode})`
      )
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
    tick(): Promise<Suggestion[]> | undefined {
      if (!running || analyzing) return undefined
      const settings = getSettings()
      const events = readEvents().filter((e) => e.ts > lastAnalyzedTs)
      if (events.length < settings.suggestionMinEvents) return undefined
      const lastTs = events[events.length - 1].ts
      if (now() - lastTs < settings.suggestionSilenceSeconds * 1000) return undefined
      const batch = events.filter((e): e is AppSwitchEvent => e.type === 'app-switch')
      if (batch.length === 0) {
        // Only clipboard events since the last pass: nothing to cluster; mark them seen.
        lastAnalyzedTs = events[events.length - 1].ts
        return undefined
      }
      return runAnalysis(batch)
    },
    analyzeNow(): Promise<Suggestion[]> {
      const events = readEvents().filter((e) => e.ts > lastAnalyzedTs)
      const batch = events.filter((e): e is AppSwitchEvent => e.type === 'app-switch')
      if (batch.length === 0) return Promise.resolve([])
      return runAnalysis(batch)
    },
    suggestions(): readonly Suggestion[] {
      return pending
    },
    accept(id: string, titleOverride?: string): Task['id'] | null {
      const suggestion = pending.find((s) => s.id === id)
      if (!suggestion) return null
      const m = meta.get(id)
      pending = pending.filter((s) => s.id !== id)
      meta.delete(id)
      onSuggestions(pending)

      const title = titleOverride?.trim() || suggestion.title
      if (suggestion.taskId && store.get(suggestion.taskId)) {
        if (titleOverride?.trim()) store.update(suggestion.taskId, { title })
        // Absorb the segment's apps through the type-safe merge path: create a
        // temp task carrying them, then merge it into the candidate (source is
        // deleted; apps/timestamps are combined by TaskStore.merge).
        const temp = store.create(title, { apps: m?.appRefs ?? [] })
        if (temp) store.merge(suggestion.taskId, temp.id)
        console.log(`[Suggestion] accepted ${id} -> merged into ${suggestion.taskId}`)
        return suggestion.taskId
      }
      const created = store.create(title, { apps: m?.appRefs ?? [] })
      console.log(`[Suggestion] accepted ${id} -> new task ${created?.id ?? '(none)'}`)
      return created?.id ?? null
    },
    ignore(id: string): boolean {
      const m = meta.get(id)
      pending = pending.filter((s) => s.id !== id)
      meta.delete(id)
      if (m) ignored.add(m.signature)
      onSuggestions(pending)
      return m !== undefined
    },
    setChat(fn: ChatFn): void {
      chat = fn
    }
  }
}

/** Fixed tick cadence for the production timer (index.ts). */
export { TICK_INTERVAL_MS }
