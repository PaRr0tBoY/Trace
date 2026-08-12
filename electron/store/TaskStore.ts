/**
 * TaskStore — in-memory + on-disk store for the task domain.
 *
 * Pure module: no Electron imports. Persistence, the clock and the item
 * liveness probe are injected, so vitest drives it with fake storage and a
 * fake clock. The main process assembles the real file adapter (PATHS +
 * safeStorage encryption) around this class.
 *
 * Rules only — no AI anywhere in this module. The state machine:
 *   - Active -> Paused: no attribution event for taskPauseThresholdMinutes.
 *   - Paused -> Active: attribution event (auto-resume).
 *   - Waiting / Completed: manual transitions only.
 *   - Multiple tasks may be Active at once; attribution picks the most
 *     recently active task when several share an app.
 */
import { createId } from './ids'
import type {
  AppRef,
  ClipboardItem,
  ResourceRef,
  ResourceSnapshot,
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

export const STORAGE_VERSION = 1
const TASK_ID_PREFIX = 't_'
const TEXT_PREVIEW_LENGTH = 200
const DEFAULT_PAUSE_THRESHOLD_MINUTES = 15
const MIN_PAUSE_THRESHOLD_MINUTES = 1
const MAX_PAUSE_THRESHOLD_MINUTES = 120
const VALID_STATUSES: readonly TaskStatus[] = ['active', 'paused', 'waiting', 'completed']
const STATUS_ORDER: Record<TaskStatus, number> = { active: 0, waiting: 1, paused: 2, completed: 3 }

function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (VALID_STATUSES as readonly string[]).includes(v)
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

  let status: TaskStatus = 'paused' // unknown status must never resurrect as active
  if (isTaskStatus(t.status)) status = t.status

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

  /** Active -> Paused for tasks idle past the threshold. Returns transitions. */
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
   * task (Active or Paused; Waiting/Completed are manual-only). Auto-resumes
   * Paused tasks and refreshes the matched AppRef's context. Returns the
   * attributed task id, or null when nothing matches.
   */
  applyAttribution(appKey: string, context?: AppRef['lastContext']): string | null {
    let best: Task | null = null
    for (const t of this.tasks) {
      if (t.status !== 'active' && t.status !== 'paused') continue
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
    best.status = 'active'
    best.lastActiveAt = this.now()
    best.updatedAt = this.now()
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
      status: 'active',
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
    if (patch.status !== undefined) {
      const now = this.now()
      // Leaving active settles the in-flight segment (ADR-0006); a resume
      // keeps the accumulated time and starts a fresh segment.
      if (task.status === 'active' && patch.status !== 'active') {
        this.settleActiveSegment(task, now)
      }
      task.status = patch.status
      // A manual resume is fresh activity; other transitions keep idle history.
      if (patch.status === 'active') task.lastActiveAt = now
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

  private applyIdleTimeout(): number {
    const now = this.now()
    const cutoff = now - this.pauseThresholdMinutes * 60_000
    let changed = 0
    for (const t of this.tasks) {
      // Elapsed >= threshold: idle exactly AT the threshold counts as overdue.
      if (t.status === 'active' && t.lastActiveAt <= cutoff) {
        this.settleActiveSegment(t, now)
        t.status = 'paused'
        t.updatedAt = now
        changed++
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
   * Fold the current active segment into activeMs (ADR-0006). Idempotent —
   * a task that already left active has nothing left to settle.
   */
  private settleActiveSegment(task: Task, now: number): void {
    if (task.status !== 'active' || task.lastActiveAt <= 0) return
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
