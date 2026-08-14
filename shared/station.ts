/**
 * Transfer Station types, renderer-facing (ADR-0006 / ADR-0007).
 *
 * The station domain module (electron/store/transferStation.ts) defines its
 * own structurally identical types; IPC payloads flow through these so the
 * web tsconfig (src + shared only) never imports from electron/.
 */

/** How an entry entered the station: 拖入 or 剪贴板捕获. */
export type StationRoute = 'drag-in' | 'clipboard'

/** Per-path view the renderer uses for the file member list. */
export interface StationMember {
  name: string
  ext: string
  size: number
  isImage: boolean
  /** False when the file is missing on disk (entry is stale). */
  exists: boolean
}

/** Serializable station entry pushed to the renderer (mirrors ClipboardItemDto). */
export interface StationEntryDto {
  id: string
  route: StationRoute
  pinned: boolean
  /** True while a move is staged (ADR-0007 M-a); immune to auto-pruning. */
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
