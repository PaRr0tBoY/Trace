/**
 * File-view tab derivation (ADR-0004).
 *
 * Extension tabs are derived from the *members* (single paths) of every
 * non-image file entry. `path.extname` semantics: '.gitignore' has no
 * extension, 'archive.tar.gz' has '.gz'. Extension-less members only appear
 * under 'all' and 'other'. Tabs are sorted by member count (desc), ties by
 * alphabetical order, and truncated from the tail while 'all' + 'other'
 * always survive.
 */
import type { ClipboardItemDto, FilesFilter } from '../../shared/types'
import { basename, isImagePath } from './format'
import type { StationEntryDto } from '../../shared/station'

/**
 * Max extension tabs in the files second row ('all' + 'other' always
 * survive). Derivation stays truncation-safe by keeping the top N tabs.
 */
export const MAX_EXT_TABS = 4

/** Node `path.extname` semantics: dot-leading names and trailing dots have no extension. */
export function extname(p: string): string {
  const name = basename(p)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot).toLowerCase()
}

/**
 * A `files` entry counts as an image (clipboard view) when every path is an
 * image path; such entries never appear in the files view.
 */
export function isImageItem(it: ClipboardItemDto): boolean {
  if (it.data.kind === 'image' || it.data.kind === 'image-collection') return true
  if (it.data.kind === 'files' && it.data.paths.length > 0) {
    return it.data.paths.every((p) => isImagePath(p))
  }
  return false
}

/** One renderable row in the files view: a single member of a file entry. */
/** One renderable row in the files view: a single member of a file entry. */
export interface FileMember {
  itemId: string
  /** Raw member path. */
  path: string
  /** Index into the parent entry's paths[] (parallel to entries[]). */
  index: number
  /** Lowercased extname of this member, or null when extension-less. */
  ext: string | null
  name: string
  size: number
  isImage: boolean
  /** False when the file is missing on disk (station entries; the entry is stale). */
  exists?: boolean
  preview?: string
}

/** Extension tab shown in the files view's second row (label = ext without the dot). */
export interface ExtTab {
  /** Lowercased extname including the dot ('.pdf'). */
  ext: string
  /** Number of members under this extension. */
  count: number
}

export interface FileTabs {
  /** Extension tabs, count desc then alphabetical. */
  tabs: ExtTab[]
  /** Number of extension-less members (the 'other' bucket). */
  otherCount: number
}

/** All non-image file members across the item list, in item order. */
export function collectFileMembers(items: ClipboardItemDto[]): FileMember[] {
  const out: FileMember[] = []
  for (const it of items) {
    if (it.data.kind !== 'files' || isImageItem(it)) continue
    const paths = it.data.paths
    const entries = it.data.entries
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]
      const entry = entries?.[i]
      const ext = extname(path)
      out.push({
        itemId: it.id,
        path,
        index: i,
        ext: ext || null,
        name: entry?.name ?? basename(path),
        size: entry?.size ?? 0,
        isImage: entry?.isImage ?? false,
        ...(entry?.isImage && entry.preview ? { preview: entry.preview } : {})
      })
    }
  }
  return out
}

/**
 * All file members across the transfer station (ADR-0006), in entry order.
 * Parallel to collectFileMembers; station entries carry their own per-path
 * metadata (stats cache) instead of FileEntry records.
 */
export function collectStationMembers(entries: StationEntryDto[]): FileMember[] {
  const out: FileMember[] = []
  for (const it of entries) {
    const paths = it.paths
    for (let i = 0; i < paths.length; i++) {
      const m = it.members[i]
      const path = paths[i]
      out.push({
        itemId: it.id,
        path,
        index: i,
        ext: extname(path) || null,
        name: m?.name ?? basename(path),
        size: m?.size ?? 0,
        isImage: m?.isImage ?? false,
        exists: m?.exists,
        ...(m?.isImage && m.exists ? { preview: `tracelocal://thumb/${encodeURIComponent(path)}` } : {})
      })
    }
  }
  return out
}

/**
 * Derive the extension-tab set: count members per extension, sort by count
 * desc (ties alphabetical), keep the top `maxTabs`. The 'other' bucket is
 * never truncated.
 */
export function deriveFileTabs(members: FileMember[], maxTabs: number): FileTabs {
  const counts = new Map<string, number>()
  let otherCount = 0
  for (const m of members) {
    if (m.ext === null) {
      otherCount++
    } else {
      counts.set(m.ext, (counts.get(m.ext) ?? 0) + 1)
    }
  }
  const tabs = [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => (b.count - a.count) || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0))
    .slice(0, maxTabs)
  return { tabs, otherCount }
}

/**
 * Members shown under one tab. 'all' returns every member (the caller groups
 * them by item); 'other' returns extension-less members; an ext string
 * returns its members.
 */
export function filterMembersByTab(members: FileMember[], filter: FilesFilter): FileMember[] {
  if (filter === 'all') return members
  if (filter === 'other') return members.filter((m) => m.ext === null)
  return members.filter((m) => m.ext === filter)
}

/**
 * True when the filter still points at a real tab. A tab that vanishes (its
 * files were deleted) must fall back to 'all'.
 */
export function isFileTabAlive(members: FileMember[], filter: FilesFilter, maxTabs: number): boolean {
  if (filter === 'all' || filter === 'other') return true
  return deriveFileTabs(members, maxTabs).tabs.some((t) => t.ext === filter)
}
