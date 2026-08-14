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
  type FileStat,
  type StationEntry,
  type StationEntryDto,
  type StationMergeResult,
  type StationMigrationInput,
  type StationRoute,
  type StationSplitResult
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
}

export class StationStore {
  private readonly station: TransferStation
  private readonly loadIndex: () => StationIndex | null
  private readonly saveIndex: (index: StationIndex) => void
  private readonly onChange: () => void

  constructor(deps: StationStoreDeps) {
    this.station = new TransferStation({
      now: deps.now,
      stat: deps.stat,
      createId: deps.createId
    })
    this.loadIndex = deps.loadIndex
    this.saveIndex = deps.saveIndex
    this.onChange = deps.onChange ?? (() => {})
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

  /** Remove an entry (any state) and return it so the caller can dispose. */
  remove(id: string): StationEntry | undefined {
    const removed = this.station.remove(id)
    if (removed) this.persist()
    return removed
  }

  pin(id: string, pinned: boolean): boolean {
    const ok = this.station.pin(id, pinned)
    if (ok) this.persist()
    return ok
  }

  /** Flag an entry in-transit (ADR-0007 M-a) or clear the flag. */
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

  split(id: string, paths: string[]): StationSplitResult {
    const result = this.station.split(id, paths)
    if (result.ok) this.persist()
    return result
  }

  merge(sourceId: string, targetId: string): StationMergeResult {
    const result = this.station.merge(sourceId, targetId)
    if (result.ok) this.persist()
    return result
  }

  /** Re-stat one entry; returns whether it flipped stale -> live. */
  revive(id: string): boolean {
    return this.station.revive(id)
  }

  /** Re-stat every entry; returns how many flipped stale -> live. */
  refreshAll(): number {
    return this.station.refreshAll()
  }

  /** Prune entries older than autoDeleteHours (pinned/in-transit exempt). */
  prune(autoDeleteHours: number): StationEntry[] {
    const pruned = this.station.prune(autoDeleteHours)
    if (pruned.length > 0) this.persist()
    return pruned
  }

  /**
   * First-launch migration (ADR-0006): legacy clipboard-stack `files` items
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
