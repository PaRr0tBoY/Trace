/**
 * TaskStore — in-memory + on-disk store for the task domain.
 *
 * Pure module: no Electron imports. Persistence, the clock and the item
 * liveness probe are injected, so vitest drives it with fake storage and a
 * fake clock. The main process assembles the real file adapter (PATHS +
 * safeStorage encryption) around this class.
 *
 * Rules only — no AI anywhere in this module. The state machine (spec
 * 实现决策 4, CONTEXT.md 任务词条):
 *   - RUNNING is globally unique: `transition` (and every path that changes
 *     status) enforces runningTaskCount <= 1. Switching = the old task
 *     leaves RUNNING (-> WAITING, auto_switch) + the new task enters
 *     RUNNING, atomically.
 *   - WAITING is the system-inferred rest state: the idle timeout moves an
 *     idle RUNNING task there (activity_lost) and attribution auto-resumes
 *     it. Users cannot fabricate WAITING.
 *   - PAUSED is a user-manual state, immune to auto-resume: the system
 *     never touches a paused task.
 *   - COMPLETED / ARCHIVED are user actions only; the system never revives
 *     them, and a user restore is the only way back to RUNNING.
 *   - Every transition records statusSource (user/system) + statusReason.
 *   - Legacy data: old multi-'active' indexes keep only the most recently
 *     active task RUNNING; the rest downgrade to WAITING (statusSource
 *     system, reason migration).
 */
import { createId } from './ids'
import type {
  AppRef,
  ClipboardItem,
  ResourceRef,
  ResourceSnapshot,
  StatusReason,
  StatusSource,
  Task,
  TaskDto,
  TaskPatch,
  TaskStatus,
  UnlinkTarget
} from '../../shared/types'

export interface TaskIndex {
  version: number
  tasks: Task[]
}

export interface TaskStoreDeps {
  load: () => TaskIndex | null
  save: (index: TaskIndex) => void
  now?: () => number
  /** Liveness probe for linked clipboard items (wired to ItemStore in main). */
  isItemAlive?: (itemId: string) => boolean
}

export const STORAGE_VERSION = 2
const TASK_ID_PREFIX = 't_'
const TEXT_PREVIEW_LENGTH = 200
const DEFAULT_PAUSE_THRESHOLD_MINUTES = 15
const MIN_PAUSE_THRESHOLD_MINUTES = 1
const MAX_PAUSE_THRESHOLD_MINUTES = 120
const VALID_STATUSES: readonly TaskStatus[] = ['running', 'waiting', 'paused', 'completed', 'archived']
const STATUS_ORDER: Record<TaskStatus, number> = { running: 0, waiting: 1, paused: 2, completed: 3, archived: 4 }
const VALID_REASONS: readonly StatusReason[] = [
  'activity_lost',
  'user_paused',
  'user_resumed',
  'auto_switch',
  'user_completed',
  'user_archived',
  'user_restored',
  'migration'
]

function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (VALID_STATUSES as readonly string[]).includes(v)
}

function isStatusReason(v: unknown): v is StatusReason {
  return typeof v === 'string' && (VALID_REASONS as readonly string[]).includes(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** Confidence is a 0-1 domain value; anything else is rejected at the boundary. */
function sanitizeConfidence(v: unknown): number | undefined {
  return isFiniteNumber(v) && v >= 0 && v <= 1 ? v : undefined
}

/** Trim, drop empties, dedupe — the windowTitles shape both on the way in and out. */
function dedupeStrings(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of list) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (s.length === 0 || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * Build the resource reference for a clipboard item, snapshotting at link
 * time. Text keeps a bounded preview (never the full body); images keep
 * identity + dimensions + byte count so a detail view survives eviction;
 * file items become a plain path list (disk files don't die with ItemStore).
 */
export function buildClipboardRef(item: Pick<ClipboardItem, 'id' | 'capturedAt' | 'data'>): ResourceRef {
  switch (item.data.kind) {
    case 'text':
      return {
        kind: 'clipboard',
        itemId: item.id,
        snapshot: { type: 'text', preview: item.data.text.slice(0, TEXT_PREVIEW_LENGTH), capturedAt: item.capturedAt }
      }
    case 'image':
      return {
        kind: 'clipboard',
        itemId: item.id,
        snapshot: {
          type: 'image',
          imageId: item.data.imageId,
          width: item.data.width,
          height: item.data.height,
          bytes: item.data.bytes,
          preview: imageSummary(item.data.width, item.data.height, item.data.bytes),
          capturedAt: item.capturedAt
        }
      }
    case 'image-collection': {
      const first = item.data.images[0]
      const totalBytes = item.data.images.reduce((sum, img) => sum + img.bytes, 0)
      return {
        kind: 'clipboard',
        itemId: item.id,
        snapshot: {
          type: 'image-collection',
          imageId: first?.imageId ?? '',
          width: first?.width ?? 0,
          height: first?.height ?? 0,
          bytes: totalBytes,
          preview: `${item.data.images.length} images`,
          capturedAt: item.capturedAt
        }
      }
    }
    case 'files':
      return { kind: 'files', paths: [...item.data.paths] }
  }
}

function imageSummary(width: number, height: number, bytes: number): string {
  return `${width}×${height} · ${formatBytes(bytes)}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Merge source resources into a target list, kind-wise, dedup by identity. */
function mergeResources(target: ResourceRef[], source: ResourceRef[]): ResourceRef[] {
  const out = [...target]
  const seenItemIds = new Set(target.flatMap((r) => (r.kind === 'clipboard' ? [r.itemId] : [])))
  const seenPaths = new Set(target.flatMap((r) => (r.kind === 'files' ? r.paths : [])))
  for (const ref of source) {
    if (ref.kind === 'clipboard') {
      if (!seenItemIds.has(ref.itemId)) {
        out.push(ref)
        seenItemIds.add(ref.itemId)
      }
    } else {
      const fresh = ref.paths.filter((p) => !seenPaths.has(p))
      if (fresh.length > 0) {
        out.push({ kind: 'files', paths: fresh })
        fresh.forEach((p) => seenPaths.add(p))
      }
    }
  }
  return out
}

/** Salvage a persisted index: drop structurally broken tasks, repair the rest. */
function sanitizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (!nonEmptyString(t.id) || !nonEmptyString(t.title)) return null

  // Legacy 'active' maps to RUNNING with a migration marker (sanitizeIndex
  // resolves the multi-active case); an unknown status must never resurrect
  // as running, so it defaults to the inert PAUSED.
  let status: TaskStatus = 'paused'
  let statusSource: StatusSource = t.statusSource === 'user' ? 'user' : 'system'
  let statusReason: StatusReason | undefined
  if (t.status === 'active') {
    status = 'running'
    statusSource = 'system'
    statusReason = 'migration'
  } else if (isTaskStatus(t.status)) {
    status = t.status
  }
  if (isStatusReason(t.statusReason)) statusReason = t.statusReason

  const apps: AppRef[] = []
  const seenAppIds = new Set<string>()
  if (Array.isArray(t.apps)) {
    for (const a of t.apps) {
      if (!a || typeof a !== 'object') continue
      const app = a as Record<string, unknown>
      if (!nonEmptyString(app.id) || !nonEmptyString(app.name)) continue
      if (seenAppIds.has(app.id)) continue
      seenAppIds.add(app.id)
      const ref: AppRef = { id: app.id, name: app.name }
      if (nonEmptyString(app.exePath)) ref.exePath = app.exePath
      if (app.lastContext && typeof app.lastContext === 'object') {
        const ctx = app.lastContext as Record<string, unknown>
        const lastContext: NonNullable<AppRef['lastContext']> = {}
        for (const key of ['windowTitle', 'url', 'workspace', 'cwd'] as const) {
          if (nonEmptyString(ctx[key])) lastContext[key] = ctx[key]
        }
        if (Object.keys(lastContext).length > 0) ref.lastContext = lastContext
      }
      if (app.linkedWindow && typeof app.linkedWindow === 'object') {
        const lw = app.linkedWindow as Record<string, unknown>
        if (isFiniteNumber(lw.pid) && isFiniteNumber(lw.ts) && lw.ts > 0) {
          ref.linkedWindow = { pid: lw.pid, title: typeof lw.title === 'string' ? lw.title : '', ts: lw.ts }
        }
      }
      apps.push(ref)
    }
  }

  const resources: ResourceRef[] = []
  const seenItemIds = new Set<string>()
  if (Array.isArray(t.resources)) {
    for (const r of t.resources) {
      if (!r || typeof r !== 'object') continue
      const ref = r as Record<string, unknown>
      if (ref.kind === 'clipboard') {
        if (!nonEmptyString(ref.itemId) || seenItemIds.has(ref.itemId)) continue
        const snap = ref.snapshot as Record<string, unknown> | undefined
        if (!snap || typeof snap !== 'object' || !isFiniteNumber(snap.capturedAt)) continue
        const base = {
          preview: typeof snap.preview === 'string' ? snap.preview : '',
          capturedAt: snap.capturedAt
        }
        let snapshot: ResourceSnapshot
        if (snap.type === 'image' || snap.type === 'image-collection') {
          snapshot = {
            ...base,
            type: snap.type,
            imageId: typeof snap.imageId === 'string' ? snap.imageId : '',
            width: isFiniteNumber(snap.width) ? snap.width : 0,
            height: isFiniteNumber(snap.height) ? snap.height : 0,
            bytes: isFiniteNumber(snap.bytes) ? snap.bytes : 0
          }
        } else if (snap.type === 'files') {
          snapshot = { ...base, type: 'files' }
        } else if (snap.type === 'text') {
          snapshot = { ...base, type: 'text' }
        } else {
          continue
        }
        seenItemIds.add(ref.itemId)
        resources.push({ kind: 'clipboard', itemId: ref.itemId, snapshot })
      } else if (ref.kind === 'files') {
        if (!Array.isArray(ref.paths)) continue
        const paths = ref.paths.filter(nonEmptyString)
        if (paths.length === 0) continue
        resources.push({ kind: 'files', paths })
      }
    }
  }

  return {
    id: t.id,
    title: t.title.trim(),
    status,
    statusSource,
    statusReason,
    note: typeof t.note === 'string' && t.note.trim() ? t.note.trim() : undefined,
    apps,
    resources,
    windowTitles: dedupeStrings(t.windowTitles),
    confidence: sanitizeConfidence(t.confidence),
    reason: typeof t.reason === 'string' && t.reason.trim() ? t.reason.trim() : undefined,
    createdAt: isFiniteNumber(t.createdAt) ? t.createdAt : 0,
    updatedAt: isFiniteNumber(t.updatedAt) ? t.updatedAt : 0,
    lastActiveAt: isFiniteNumber(t.lastActiveAt) ? t.lastActiveAt : 0,
    activeMs: isFiniteNumber(t.activeMs) ? Math.max(0, t.activeMs) : 0
  }
}

export class TaskStore {
  private tasks: Task[] = []
  private pauseThresholdMinutes = DEFAULT_PAUSE_THRESHOLD_MINUTES
  private readonly deps: TaskStoreDeps

  constructor(deps: TaskStoreDeps) {
    this.deps = deps
  }

  /** Load persisted state from disk. Called once at startup. */
  load(): void {
    this.tasks = sanitizeIndex(this.deps.load())
  }

  /** RUNNING -> WAITING for tasks idle past the threshold. Returns transitions. */
  sweep(): number {
    const changed = this.applyIdleTimeout()
    if (changed > 0) this.persist()
    return changed
  }

  setPauseThreshold(minutes: number): void {
    this.pauseThresholdMinutes = Math.min(
      MAX_PAUSE_THRESHOLD_MINUTES,
      Math.max(MIN_PAUSE_THRESHOLD_MINUTES, Math.round(Number(minutes) || DEFAULT_PAUSE_THRESHOLD_MINUTES))
    )
  }

  /**
   * Attribute a foreground-app event to the most recently active matching
   * task (RUNNING or WAITING). A WAITING task auto-resumes to RUNNING
   * (system, auto_switch); PAUSED is immune to auto-resume and
   * COMPLETED/ARCHIVED are never revived. Refreshes the matched AppRef's
   * context. Returns the attributed task id, or null when nothing matches.
   */
  applyAttribution(appKey: string, context?: AppRef['lastContext']): string | null {
    let best: Task | null = null
    for (const t of this.tasks) {
      if (t.status !== 'running' && t.status !== 'waiting') continue
      if (t.apps.some((a) => a.id === appKey) && (!best || t.lastActiveAt > best.lastActiveAt)) {
        best = t
      }
    }
    if (!best) return null

    const app = best.apps.find((a) => a.id === appKey)!
    if (context) {
      const merged: NonNullable<AppRef['lastContext']> = { ...app.lastContext }
      for (const key of ['windowTitle', 'url', 'workspace', 'cwd'] as const) {
        const v = context[key]
        if (v !== undefined) merged[key] = v
      }
      app.lastContext = merged
    }
    // Most-recently-used order: touched app first.
    best.apps = [app, ...best.apps.filter((a) => a !== app)]
    if (best.status === 'waiting') {
      // System auto-resume: WAITING is the only state the system may bring
      // back to RUNNING (displaces any current RUNNING task, atomically).
      this.applyTransition(best, 'running', 'system')
    } else {
      best.lastActiveAt = this.now()
      best.updatedAt = this.now()
    }
    this.finish()
    return best.id
  }

  create(
    title: string,
    opts?: { note?: string; apps?: AppRef[]; resources?: ResourceRef[]; windowTitles?: string[]; confidence?: number; reason?: string }
  ): Task | null {
    const clean = title.trim()
    if (!clean) return null
    const now = this.now()
    const task: Task = {
      id: `${TASK_ID_PREFIX}${createId()}`,
      title: clean,
      status: 'running',
      statusSource: 'system',
      statusReason: 'auto_switch',
      note: opts?.note?.trim() || undefined,
      apps: dedupeApps(opts?.apps ?? []),
      resources: dedupeResources(opts?.resources ?? []),
      windowTitles: dedupeStrings(opts?.windowTitles ?? []),
      confidence: sanitizeConfidence(opts?.confidence),
      reason: opts?.reason?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      activeMs: 0
    }
    this.tasks.push(task)
    // A new task takes RUNNING; the previous RUNNING task (if any) leaves
    // RUNNING for WAITING atomically — runningTaskCount stays <= 1.
    this.makeRunning(task, now)
    this.finish()
    return task
  }

  /**
   * Edit title/note/status, the t27 evidence fields (windowTitles/confidence/
   * reason), or the guided-form selections (ADR-0002): `apps` replaces the
   * whole app list; `clipboardRefs` replaces the clipboard resources
   * (files resources are kept) — refs are built by the IPC layer, which owns
   * the ItemStore. Returns false when invalid.
   */
  update(id: string, patch: TaskPatch & { clipboardRefs?: ResourceRef[] }): boolean {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return false
    if (patch.title !== undefined && !nonEmptyString(patch.title)) return false
    if (patch.status !== undefined && !isTaskStatus(patch.status)) return false
    if (patch.windowTitles !== undefined && !Array.isArray(patch.windowTitles)) return false
    if (patch.confidence !== undefined && sanitizeConfidence(patch.confidence) === undefined) return false
    if (patch.reason !== undefined && typeof patch.reason !== 'string') return false
    if (patch.apps !== undefined && !Array.isArray(patch.apps)) return false
    if (patch.clipboardRefs !== undefined && !Array.isArray(patch.clipboardRefs)) return false

    // Status changes go through the state machine as user-driven transitions
    // (illegal ones reject the whole update). Other patches apply below.
    if (patch.status !== undefined && !this.applyTransition(task, patch.status, 'user')) {
      return false
    }
    if (patch.title !== undefined) task.title = patch.title.trim()
    if (patch.note !== undefined) task.note = patch.note.trim() || undefined
    if (patch.windowTitles !== undefined) task.windowTitles = dedupeStrings(patch.windowTitles)
    if (patch.confidence !== undefined) task.confidence = patch.confidence
    if (patch.reason !== undefined) task.reason = patch.reason.trim() || undefined
    if (patch.apps !== undefined) task.apps = dedupeApps(patch.apps)
    if (patch.clipboardRefs !== undefined) {
      // The selection may include kind:'files' clipboard items — those build
      // files refs (buildClipboardRef), so merge them into the kept files
      // resources instead of dropping them.
      const selected = dedupeResources(patch.clipboardRefs)
      const clipboard = selected.filter((r) => r.kind === 'clipboard')
      const files = mergeResources(
        selected.filter((r) => r.kind === 'files'),
        task.resources.filter((r) => r.kind === 'files')
      )
      task.resources = [...clipboard, ...files]
    }
    task.updatedAt = this.now()
    this.finish()
    return true
  }

  /** Hard delete. Returns whether a task was removed. */
  delete(id: string): boolean {
    const before = this.tasks.length
    this.tasks = this.tasks.filter((t) => t.id !== id)
    if (this.tasks.length === before) return false
    this.finish()
    return true
  }

  /**
   * Merge source into target: app union (target wins on shared ids),
   * same-kind resource merge, timestamps combined. Source task is deleted.
   */
  merge(targetId: string, sourceId: string): boolean {
    if (targetId === sourceId) return false
    const target = this.tasks.find((t) => t.id === targetId)
    const source = this.tasks.find((t) => t.id === sourceId)
    if (!target || !source) return false

    const sourceApps = source.apps.filter((a) => !target.apps.some((b) => b.id === a.id))
    target.apps.push(...sourceApps)
    target.resources = mergeResources(target.resources, source.resources)
    target.lastActiveAt = Math.max(target.lastActiveAt, source.lastActiveAt)
    // Summing would double-count (a temp candidate task is ~0 anyway);
    // the larger settled value wins (ADR-0006).
    target.activeMs = Math.max(target.activeMs, source.activeMs)
    // A RUNNING source leaves RUNNING when it is absorbed — settle its
    // in-flight segment first (runningTaskCount only ever decreases here;
    // the target status is untouched by a merge).
    if (source.status === 'running') this.settleActiveSegment(source, this.now())
    target.updatedAt = this.now()
    this.tasks = this.tasks.filter((t) => t.id !== sourceId)
    this.finish()
    return true
  }

  /** Attach a resource reference (snapshot already built). Dedup; returns whether anything changed. */
  linkItem(taskId: string, ref: ResourceRef): boolean {
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return false

    if (ref.kind === 'clipboard') {
      if (task.resources.some((r) => r.kind === 'clipboard' && r.itemId === ref.itemId)) return false
      task.resources.push(ref)
    } else {
      const existing = new Set(task.resources.flatMap((r) => (r.kind === 'files' ? r.paths : [])))
      const fresh = ref.paths.filter((p) => !existing.has(p))
      if (fresh.length === 0) return false
      task.resources.push({ kind: 'files', paths: fresh })
    }

    task.updatedAt = this.now()
    this.finish()
    return true
  }

  /**
   * Link raw file paths (t25 drop-to-bind). Trims, drops empties and
   * in-list duplicates, then delegates to linkItem's dedup against the
   * task's existing file refs. Returns whether anything changed.
   */
  linkFiles(taskId: string, paths: string[]): boolean {
    const clean: string[] = []
    const seen = new Set<string>()
    for (const p of paths) {
      const s = p.trim()
      if (s.length === 0 || seen.has(s)) continue
      seen.add(s)
      clean.push(s)
    }
    if (clean.length === 0) return false
    return this.linkItem(taskId, { kind: 'files', paths: clean })
  }

  /** Remove a resource: clipboard by itemId, files by exact path list. Returns whether anything changed. */
  unlinkItem(taskId: string, target: UnlinkTarget): boolean {
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return false
    const before = task.resources.length

    if (target.kind === 'clipboard') {
      task.resources = task.resources.filter(
        (r) => !(r.kind === 'clipboard' && r.itemId === target.itemId)
      )
    } else {
      const targetPaths = [...target.paths].sort()
      task.resources = task.resources.filter(
        (r) => !(r.kind === 'files' && [...r.paths].sort().join('\u0000') === targetPaths.join('\u0000'))
      )
    }

    if (task.resources.length === before) return false
    task.updatedAt = this.now()
    this.finish()
    return true
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /** Tasks in display order: status groups, lastActiveAt descending within a group. */
  list(): readonly Task[] {
    return this.sorted()
  }

  /** Renderer-safe snapshot: sorted, resources flagged with ItemStore liveness. */
  toDto(): TaskDto[] {
    return this.sorted().map((t) => ({
      ...t,
      resources: t.resources.map((r) =>
        r.kind === 'clipboard'
          ? { ...r, alive: this.isItemAlive(r.itemId) }
          : { ...r, alive: true }
      )
    }))
  }

  /**
   * Domain-level transition seam (spec 实现决策 4): the only public way to
   * move a task between states with a source annotation, and the only path
   * that can change which task is RUNNING. The current-task controller
   * drives system transitions (auto-switch, activity loss) through this
   * method; user actions go through update({ status }) which delegates here
   * with source 'user'. Illegal transitions return false and change nothing.
   */
  transition(id: string, to: TaskStatus, source: StatusSource): boolean {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return false
    if (!this.applyTransition(task, to, source)) return false
    this.finish()
    return true
  }

  /* ------------------------------ internals ------------------------------ */

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private isItemAlive(itemId: string): boolean {
    return this.deps.isItemAlive ? this.deps.isItemAlive(itemId) : true
  }

  private sorted(): Task[] {
    return [...this.tasks].sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActiveAt - a.lastActiveAt
    )
  }

  /**
   * The single transition core — every status change in the store funnels
   * through here, so the runningTaskCount <= 1 invariant, PAUSED immunity,
   * the COMPLETED/ARCHIVED terminal rule and the source/reason bookkeeping
   * cannot be bypassed by any path.
   *
   * Legal table:
   *   user:   running -> paused | completed | archived
   *           waiting -> running | completed | archived
   *           paused  -> running | completed | archived
   *           completed -> running (restore) | archived
   *           archived  -> running (restore)
   *   system: running -> waiting (activity_lost), waiting -> running
   *           (auto_switch) — nothing else: PAUSED is immune, COMPLETED and
   *           ARCHIVED are never auto-revived.
   * Users cannot fabricate WAITING (it is the system's rest state) and a
   * manual pause only makes sense while RUNNING.
   */
  private applyTransition(task: Task, to: TaskStatus, source: StatusSource): boolean {
    if (task.status === to) return false
    const from = task.status
    const now = this.now()

    if (source === 'system') {
      // The system only rests an idle RUNNING task or brings a WAITING task
      // back. It never touches PAUSED (immune), COMPLETED or ARCHIVED.
      const systemLegal = (from === 'running' && to === 'waiting') || (from === 'waiting' && to === 'running')
      if (!systemLegal) return false
    } else {
      // WAITING is the system's rest state — users pause/resume/complete,
      // they don't fabricate waiting; pausing a non-RUNNING task is a no-op.
      if (to === 'waiting') return false
      if (to === 'paused' && from !== 'running') return false
      // COMPLETED/ARCHIVED are terminal: a user may restore them to RUNNING,
      // or move a COMPLETED task to ARCHIVED, but nothing else.
      if ((from === 'completed' || from === 'archived') && to !== 'running' && !(from === 'completed' && to === 'archived')) {
        return false
      }
    }

    // Leaving RUNNING settles the in-flight active segment (ADR-0006).
    if (from === 'running') this.settleActiveSegment(task, now)

    if (to === 'running') {
      // Switching = the old RUNNING task leaves (-> WAITING, auto_switch) +
      // this task enters RUNNING, atomically.
      this.makeRunning(task, now)
    } else {
      task.status = to
    }
    task.statusSource = source
    task.statusReason = this.reasonFor(from, to, source)
    task.updatedAt = now
    return true
  }

  /**
   * Make `task` RUNNING. The previous RUNNING task (if any) leaves RUNNING
   * for WAITING (system, auto_switch), settling its active segment — the
   * runningTaskCount <= 1 invariant holds on every path that enters RUNNING.
   */
  private makeRunning(task: Task, now: number): void {
    for (const other of this.tasks) {
      if (other.status !== 'running' || other.id === task.id) continue
      this.settleActiveSegment(other, now)
      other.status = 'waiting'
      other.statusSource = 'system'
      other.statusReason = 'auto_switch'
      other.updatedAt = now
    }
    task.status = 'running'
    task.lastActiveAt = now
  }

  /** The transition table's reason vocabulary (statusSource/statusReason contract). */
  private reasonFor(from: TaskStatus, to: TaskStatus, source: StatusSource): StatusReason {
    if (to === 'running') {
      if (source === 'user') return from === 'completed' || from === 'archived' ? 'user_restored' : 'user_resumed'
      return 'auto_switch'
    }
    if (to === 'waiting') return 'activity_lost'
    if (to === 'paused') return 'user_paused'
    if (to === 'completed') return 'user_completed'
    return 'user_archived'
  }

  private applyIdleTimeout(): number {
    const now = this.now()
    const cutoff = now - this.pauseThresholdMinutes * 60_000
    let changed = 0
    for (const t of this.tasks) {
      // Elapsed >= threshold: idle exactly AT the threshold counts as
      // overdue. Idle RUNNING tasks rest as WAITING (system, activity_lost).
      if (t.status === 'running' && t.lastActiveAt <= cutoff) {
        if (this.applyTransition(t, 'waiting', 'system')) changed++
      }
    }
    return changed
  }

  /** End of every mutation: re-evaluate the state machine, then persist once. */
  private finish(): void {
    this.applyIdleTimeout()
    this.persist()
  }

  /**
   * Fold the current RUNNING segment into activeMs (ADR-0006). Idempotent —
   * a task that already left RUNNING has nothing left to settle.
   */
  private settleActiveSegment(task: Task, now: number): void {
    if (task.status !== 'running' || task.lastActiveAt <= 0) return
    task.activeMs = Math.max(0, task.activeMs + (now - task.lastActiveAt))
  }

  private persist(): void {
    this.deps.save({ version: STORAGE_VERSION, tasks: this.tasks })
  }
}

function sanitizeIndex(index: TaskIndex | null): Task[] {
  if (!index || !Array.isArray(index.tasks)) return []
  const tasks: Task[] = []
  const seenIds = new Set<string>()
  for (const raw of index.tasks) {
    const task = sanitizeTask(raw)
    if (!task || seenIds.has(task.id)) continue
    seenIds.add(task.id)
    tasks.push(task)
  }
  // Migration + invariant repair (spec 实现决策 4): at most one RUNNING task
  // may survive a load. Legacy multi-'active' indexes (sanitizeTask marks
  // them with statusReason 'migration') and any corrupt index keep only the
  // most recently active task RUNNING; the rest rest as WAITING (system).
  const running = tasks.filter((t) => t.status === 'running')
  if (running.length > 1) {
    running.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    for (const t of running.slice(1)) {
      t.status = 'waiting'
      t.statusSource = 'system'
      // Keep the migration provenance; other repairs read as an auto-switch.
      if (t.statusReason !== 'migration') t.statusReason = 'auto_switch'
    }
  }
  return tasks
}

function dedupeApps(apps: AppRef[]): AppRef[] {
  const seen = new Set<string>()
  const out: AppRef[] = []
  for (const a of apps) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    out.push(a)
  }
  return out
}

function dedupeResources(resources: ResourceRef[]): ResourceRef[] {
  const seenItemIds = new Set<string>()
  const seenPaths = new Set<string>()
  const out: ResourceRef[] = []
  for (const r of resources) {
    if (r.kind === 'clipboard') {
      if (seenItemIds.has(r.itemId)) continue
      seenItemIds.add(r.itemId)
      out.push(r)
    } else {
      const fresh = r.paths.filter((p) => !seenPaths.has(p))
      if (fresh.length === 0) continue
      fresh.forEach((p) => seenPaths.add(p))
      out.push({ kind: 'files', paths: fresh })
    }
  }
  return out
}
