/**
 * StationStore — persistence + lifecycle wrapper around TransferStation.
 *
 * Pure module (no Electron imports): the JSON index adapter, the clock and
 * the stat probe are injected, so vitest drives it with fake storage. Every
 * mutation persists and notifies the push hook, mirroring the TaskStore
 * pattern. The main process wires the real file adapter (PATHS + safeStorage
 * envelope) and pushState.station() around this class.
 *
 * Terminology (CONTEXT.md): 文件中转站 / 途径 / 在途 / 文件成员.
 */
import {
  TransferStation,
  appOwnedPathsFor,
  type FileStat,
  type StationEntry,
  type StationEntryDto,
  type StationMigrationInput,
  type StationRoute
} from './transferStation'

export interface StationIndex {
  version: number
  entries: StationEntry[]
}

export const STATION_STORAGE_VERSION = 1

export interface StationStoreDeps {
  loadIndex: () => StationIndex | null
  saveIndex: (index: StationIndex) => void
  /** Fired after every persisted mutation so the caller can broadcast. */
  onChange?: () => void
  now?: () => number
  stat?: (p: string) => FileStat | undefined
  createId?: () => string
  /**
   * Path of the app-owned station content dir (T7 staged drops). Entries
   * referencing files inside it have those files recycled on delete/prune;
   * user-original paths are never disposed. Omit to disable disposal
   * entirely (tests that don't exercise file lifecycle). May be a lazy
   * getter — the value is only resolved when a mutation needs it, so main
   * can pass `() => PATHS.stationContentDir()` without forcing a userData
   * lookup at module import time (which breaks tests importing state.ts
   * without a full electron mock).
   */
  contentDir?: string | (() => string)
  /**
   * Dispose app-owned files (Recycle Bin in main). Return false to keep the
   * entry so the user can retry — nothing is ever permanently deleted
   * (ADR-0008). Defaults to a permissive no-op for callers without a
   * disposer.
   */
  disposeFiles?: (paths: string[]) => boolean
}

export class StationStore {
  private readonly station: TransferStation
  private readonly loadIndex: () => StationIndex | null
  private readonly saveIndex: (index: StationIndex) => void
  private readonly onChange: () => void
  private readonly contentDir: string | (() => string)
  private readonly disposeFiles: (paths: string[]) => boolean

  constructor(deps: StationStoreDeps) {
    this.station = new TransferStation({
      now: deps.now,
      stat: deps.stat,
      createId: deps.createId
    })
    this.loadIndex = deps.loadIndex
    this.saveIndex = deps.saveIndex
    this.onChange = deps.onChange ?? (() => {})
    this.contentDir = deps.contentDir ?? ''
    this.disposeFiles = deps.disposeFiles ?? (() => true)
  }

  private contentDirValue(): string {
    return typeof this.contentDir === 'function' ? this.contentDir() : this.contentDir
  }

  /** Hydrate from the persisted index. Safe to call once at startup. */
  load(): void {
    const index = this.loadIndex()
    this.station.hydrate(index?.entries ?? [])
  }

  private persist(): void {
    this.saveIndex({ version: STATION_STORAGE_VERSION, entries: [...this.station.list()] })
    this.onChange()
  }

  /* --------------------------- lifecycle ops --------------------------- */

  /** Enter paths (chunked at MAX_STACK); returns the created entries. */
  enter(paths: string[], route: StationRoute): StationEntry[] {
    const created = this.station.enter(paths, route)
    // Empty input mutates nothing (the dedup bump still returns [] but *does*
    // change state, so the guard is on input, not on the result).
    if (paths.length > 0) this.persist()
    return created
  }

  /**
   * Remove an entry (any state). App-owned files (in-transit staged copies
   * and T7 content-dir drops) are recycled first; a failed disposal keeps
   * the entry and returns undefined so the caller can tell the user to
   * retry — user-original files are never touched.
   */
  remove(id: string): StationEntry | undefined {
    const entry = this.station.get(id)
    if (!entry) return undefined
    const owned = appOwnedPathsFor(entry, this.contentDirValue())
    if (owned.length > 0 && !this.disposeFiles(owned)) return undefined
    const removed = this.station.remove(id)
    if (removed) this.persist()
    return removed
  }

  pin(id: string, pinned: boolean): boolean {
    const ok = this.station.pin(id, pinned)
    if (ok) this.persist()
    return ok
  }

  /** Flag an entry in-transit (ADR-0008 M-a) or clear the flag. */
  setInTransit(id: string, inTransit: boolean): boolean {
    const ok = this.station.setInTransit(id, inTransit)
    if (ok) this.persist()
    return ok
  }

  /** Replace an entry's paths (staged move retarget) and refresh stats. */
  retarget(id: string, paths: string[]): boolean {
    const ok = this.station.retarget(id, paths)
    if (ok) this.persist()
    return ok
  }

  /** Re-stat one entry; returns whether it flipped stale -> live. */
  revive(id: string): boolean {
    return this.station.revive(id)
  }

  /** Re-stat every entry; returns how many flipped stale -> live. */
  refreshAll(): number {
    return this.station.refreshAll()
  }

  /**
   * Prune entries older than autoDeleteHours (pinned/in-transit exempt).
   * App-owned files of pruned entries (T7 content drops) are recycled first;
   * an entry whose disposal failed stays in the station and is retried by
   * the next sweep. Returns only the entries that were actually pruned.
   */
  prune(autoDeleteHours: number): StationEntry[] {
    const pruned = this.station.prune(autoDeleteHours)
    const ok: StationEntry[] = []
    const kept: StationEntry[] = []
    const contentDir = this.contentDirValue()
    for (const e of pruned) {
      const owned = appOwnedPathsFor(e, contentDir)
      if (owned.length > 0 && !this.disposeFiles(owned)) {
        kept.push(e)
      } else {
        ok.push(e)
      }
    }
    for (const e of kept) this.station.restore(e)
    if (ok.length > 0) this.persist()
    return ok
  }

  /**
   * First-launch migration (ADR-0008): legacy clipboard-stack `files` items
   * become station entries (route = 剪贴板). Returns the migrated item ids
   * so the caller removes them from the stack.
   */
  migrateLegacy(items: StationMigrationInput[]): string[] {
    const { migratedIds } = this.station.migrateLegacyFileItems(items)
    if (migratedIds.length > 0) this.persist()
    return migratedIds
  }

  /* ------------------------------ queries ------------------------------ */

  get(id: string): StationEntry | undefined {
    return this.station.get(id)
  }

  list(): readonly StationEntry[] {
    return this.station.list()
  }

  toDto(): StationEntryDto[] {
    return this.station.toDto()
  }
}
