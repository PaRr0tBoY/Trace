/**
 * Transfer Station domain module (ADR-0006 / ADR-0007, ticket #3).
 *
 * Pure logic, zero Electron imports, vitest-tested. Owns the station entry
 * model — paths, route (drag-in | clipboard), pinned, inTransit, capturedAt —
 * and every lifecycle operation: enter (with batch chunking), remove,
 * pin/unpin, member split/merge, revive, retention pruning and the
 * first-launch migration of legacy clipboard-stack file items. Persistence,
 * OS file handling and the staging-area move (M-a) live in the main-process
 * layer that consumes this module.
 *
 * Terminology (CONTEXT.md): 文件中转站 / 途径 / 在途 / 文件成员.
 */
import { statSync } from 'node:fs'
import { extname, basename } from 'node:path'
import { MAX_STACK } from '../../shared/types'

/** How an entry entered the station (ADR-0006): 拖入 or 剪贴板捕获. */
export type StationRoute = 'drag-in' | 'clipboard'

/** Cached per-path stat snapshot used for staleness detection. */
export interface FileStat {
  exists: boolean
  size: number
}

/** A station entry: a group of file paths plus station lifecycle flags. */
export interface StationEntry {
  id: string
  paths: string[]
  route: StationRoute
  pinned: boolean
  /**
   * True while a move is staged (ADR-0007 M-a): the original files have been
   * renamed into the station staging area and are held here. In-transit
   * entries are immune to auto-pruning and can only be disposed of manually
   * (drag out again or delete).
   */
  inTransit: boolean
  /** Unix epoch ms when the entry entered the station (or was last refreshed). */
  capturedAt: number
  /** Per-path stat cache; a missing path marks the whole entry stale. */
  stats: Record<string, FileStat>
}

/** Per-path view the renderer uses for the file member list. */
export interface StationMember {
  name: string
  ext: string
  size: number
  isImage: boolean
  exists: boolean
}

/** Serializable shape pushed to the renderer (mirrors ClipboardItemDto). */
export interface StationEntryDto {
  id: string
  route: StationRoute
  pinned: boolean
  inTransit: boolean
  capturedAt: number
  /** True when at least one path is missing on disk. */
  stale: boolean
  paths: string[]
  members: StationMember[]
}

export type StationMergeResult =
  | { ok: true }
  | { ok: false; reason: 'notfound' | 'self' | 'full' | 'in-transit' }

export type StationSplitResult =
  | { ok: true }
  | { ok: false; reason: 'notfound' | 'in-transit' | 'no-paths' }

/** Minimal legacy clipboard-stack item shape the migration consumes. */
export interface StationMigrationInput {
  id: string
  capturedAt: number
  pinned: boolean
  data: { kind: string; paths?: string[] }
}

export interface StationMigrationResult {
  /** Station entries, 1:1 for legacy `files` items, order preserved. */
  entries: StationEntry[]
  /** ids of the migrated legacy items; the caller removes these from the stack. */
  migratedIds: string[]
}

/** Same extension set as ItemStore.isImageExt; duplicated because it is not exported. */
function isImageExt(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|jfif|pjpeg|pjp)$/i.test(p)
}

function defaultStat(p: string): FileStat {
  try {
    const s = statSync(p)
    return { exists: true, size: s.size }
  } catch {
    return { exists: false, size: 0 }
  }
}

function defaultCreateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class TransferStation {
  private entries: StationEntry[] = []
  private readonly now: () => number
  private readonly stat: (p: string) => FileStat | undefined
  private readonly createId: () => string

  constructor(opts?: {
    /** Clock for capturedAt / pruning; injectable for tests. */
    now?: () => number
    /** Path statter; injectable for tests. undefined = stat failed, treated as missing. */
    stat?: (p: string) => FileStat | undefined
    createId?: () => string
  }) {
    this.now = opts?.now ?? Date.now
    this.stat = opts?.stat ?? defaultStat
    this.createId = opts?.createId ?? defaultCreateId
  }

  private statPaths(paths: string[]): Record<string, FileStat> {
    const stats: Record<string, FileStat> = {}
    for (const p of paths) {
      // Any stat failure (missing, unreadable, disconnected drive) counts as
      // missing — the cache must never throw into a caller.
      let s: FileStat | undefined
      try {
        s = this.stat(p)
      } catch {
        s = undefined
      }
      stats[p] = s ?? { exists: false, size: 0 }
    }
    return stats
  }

  private indexOf(id: string): number {
    return this.entries.findIndex((e) => e.id === id)
  }

  /**
   * Enter paths into the station (most recent first). A batch of more than
   * MAX_STACK paths chunks into multiple entries of at most MAX_STACK paths,
   * preserving relative order. Re-entering the exact same path list (order
   * insensitive) bumps the existing entry to the top, refreshes its
   * capturedAt and route, and creates nothing.
   */
  enter(paths: string[], route: StationRoute): StationEntry[] {
    if (paths.length === 0) return []
    const created: StationEntry[] = []
    const now = this.now()
    for (const chunk of this.chunks(paths)) {
      const sig = [...chunk].sort().join('\n')
      const existing = this.entries.find((e) => [...e.paths].sort().join('\n') === sig)
      if (existing) {
        this.entries.splice(this.indexOf(existing.id), 1)
        this.entries.unshift({ ...existing, route, capturedAt: now })
        continue
      }
      const entry: StationEntry = {
        id: this.createId(),
        paths: chunk,
        route,
        pinned: false,
        inTransit: false,
        capturedAt: now,
        stats: this.statPaths(chunk)
      }
      this.entries.unshift(entry)
      created.push(entry)
    }
    return created
  }

  private chunks(paths: string[]): string[][] {
    const out: string[][] = []
    for (let i = 0; i < paths.length; i += MAX_STACK) {
      out.push(paths.slice(i, i + MAX_STACK))
    }
    return out
  }

  /** Remove an entry (any state, including in-transit) and return it so the
   * caller can dispose of the files (e.g. move a staged copy to the recycle bin). */
  remove(id: string): StationEntry | undefined {
    const idx = this.indexOf(id)
    if (idx < 0) return undefined
    const [removed] = this.entries.splice(idx, 1)
    return removed
  }

  pin(id: string, pinned: boolean): boolean {
    const idx = this.indexOf(id)
    if (idx < 0) return false
    this.entries[idx] = { ...this.entries[idx], pinned }
    return true
  }

  /** Flag an entry as in-transit (ADR-0007 M-a staging) or clear the flag. */
  setInTransit(id: string, inTransit: boolean): boolean {
    const idx = this.indexOf(id)
    if (idx < 0) return false
    this.entries[idx] = { ...this.entries[idx], inTransit }
    return true
  }

  /** Replace an entry's paths (used by the staged move to retarget at the
   * staging-area paths) and refresh their stat cache. */
  retarget(id: string, paths: string[]): boolean {
    const idx = this.indexOf(id)
    if (idx < 0) return false
    this.entries[idx] = { ...this.entries[idx], paths: [...paths], stats: this.statPaths(paths) }
    return true
  }

  /**
   * Split the given members out of an entry into a new entry placed right
   * after it. The new entry inherits route, pinned and capturedAt from the
   * source; splitting an in-transit entry is rejected (those can only be
   * dragged out again or deleted, ADR-0007). An emptied source is removed.
   */
  split(id: string, paths: string[]): StationSplitResult {
    const idx = this.indexOf(id)
    if (idx < 0) return { ok: false, reason: 'notfound' }
    const src = this.entries[idx]
    if (src.inTransit) return { ok: false, reason: 'in-transit' }
    const wanted = new Set(paths)
    const targetPaths = src.paths.filter((p) => wanted.has(p))
    if (targetPaths.length === 0) return { ok: false, reason: 'no-paths' }
    const kept = src.paths.filter((p) => !wanted.has(p))
    if (kept.length === 0) {
      // Source dissolves entirely; the split still yields a standalone entry.
      this.entries.splice(idx, 1)
      this.entries.splice(idx, 0, {
        ...src,
        id: this.createId(),
        paths: targetPaths,
        stats: this.statPaths(targetPaths)
      })
      return { ok: true }
    }
    const splitEntry: StationEntry = {
      id: this.createId(),
      paths: targetPaths,
      route: src.route,
      pinned: src.pinned,
      inTransit: false,
      capturedAt: src.capturedAt,
      stats: this.statPaths(targetPaths)
    }
    this.entries[idx] = { ...src, paths: kept, stats: this.statPaths(kept) }
    this.entries.splice(idx + 1, 0, splitEntry)
    return { ok: true }
  }

  /**
   * Merge the source entry's paths into the target (deduplicated) and remove
   * the source. The target keeps its own flags; it becomes pinned when either
   * side was pinned. Merging in-transit entries is rejected, and the combined
   * entry may not exceed MAX_STACK paths.
   */
  merge(sourceId: string, targetId: string): StationMergeResult {
    if (sourceId === targetId) return { ok: false, reason: 'self' }
    const srcIdx = this.indexOf(sourceId)
    const tgtIdx = this.indexOf(targetId)
    if (srcIdx < 0 || tgtIdx < 0) return { ok: false, reason: 'notfound' }
    const src = this.entries[srcIdx]
    const tgt = this.entries[tgtIdx]
    if (src.inTransit || tgt.inTransit) return { ok: false, reason: 'in-transit' }
    const seen = new Set(tgt.paths)
    const combined = [...tgt.paths, ...src.paths.filter((p) => !seen.has(p))]
    if (combined.length > MAX_STACK) return { ok: false, reason: 'full' }
    this.entries[tgtIdx] = {
      ...tgt,
      paths: combined,
      pinned: tgt.pinned || src.pinned,
      capturedAt: this.now(),
      stats: this.statPaths(combined)
    }
    this.entries.splice(srcIdx, 1)
    return { ok: true }
  }

  /**
   * Re-stat every path of an entry. Returns true when the entry flipped from
   * stale to live (a missing file came back), so callers can push state.
   */
  revive(id: string): boolean {
    const idx = this.indexOf(id)
    if (idx < 0) return false
    const entry = this.entries[idx]
    const wasStale = entry.paths.some((p) => !entry.stats[p]?.exists)
    const stats = this.statPaths(entry.paths)
    this.entries[idx] = { ...entry, stats }
    const isStale = entry.paths.some((p) => !stats[p]?.exists)
    return wasStale && !isStale
  }

  /** Re-stat every entry; returns how many flipped stale -> live. */
  refreshAll(): number {
    let revived = 0
    for (const e of this.entries) {
      if (this.revive(e.id)) revived++
    }
    return revived
  }

  /** Staleness from the current cache: at least one path missing. */
  isStale(id: string): boolean {
    const entry = this.entries[this.indexOf(id)]
    if (!entry) return false
    return entry.paths.some((p) => !entry.stats[p]?.exists)
  }

  /**
   * Prune entries older than autoDeleteHours (0 = never). Pinned and
   * in-transit entries are exempt. Returns the pruned entries so the caller
   * can dispose of their files.
   */
  prune(autoDeleteHours: number): StationEntry[] {
    if (!autoDeleteHours || autoDeleteHours <= 0) return []
    const cutoff = this.now() - autoDeleteHours * 3600 * 1000
    const pruned: StationEntry[] = []
    const kept: StationEntry[] = []
    for (const e of this.entries) {
      if (!e.pinned && !e.inTransit && e.capturedAt < cutoff) {
        pruned.push(e)
      } else {
        kept.push(e)
      }
    }
    if (pruned.length > 0) this.entries = kept
    return pruned
  }

  /**
   * First-launch migration (ADR-0006): legacy clipboard-stack `files` items
   * become station entries with route = 剪贴板, keeping id / capturedAt /
   * pinned. Image and other items are left untouched (they stay in the
   * stack). Entries without paths are skipped.
   */
  migrateLegacyFileItems(items: StationMigrationInput[]): StationMigrationResult {
    const entries: StationEntry[] = []
    const migratedIds: string[] = []
    for (const it of items) {
      if (it.data.kind !== 'files' || !it.data.paths || it.data.paths.length === 0) continue
      migratedIds.push(it.id)
      entries.push({
        id: it.id,
        paths: it.data.paths,
        route: 'clipboard',
        pinned: it.pinned,
        inTransit: false,
        capturedAt: it.capturedAt,
        stats: this.statPaths(it.data.paths)
      })
    }
    this.entries.unshift(...entries)
    return { entries, migratedIds }
  }

  get(id: string): StationEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  list(): readonly StationEntry[] {
    return this.entries
  }

  /** Snapshot as renderer DTOs, newest first. */
  toDto(): StationEntryDto[] {
    return this.entries.map((e) => ({
      id: e.id,
      route: e.route,
      pinned: e.pinned,
      inTransit: e.inTransit,
      capturedAt: e.capturedAt,
      stale: e.paths.some((p) => !e.stats[p]?.exists),
      paths: e.paths,
      members: e.paths.map((p) => {
        const st = e.stats[p]
        return {
          name: basename(p),
          ext: extname(p).slice(1).toLowerCase(),
          size: st?.exists ? st.size : 0,
          isImage: isImageExt(p),
          exists: st?.exists ?? false
        }
      })
    }))
  }
}
