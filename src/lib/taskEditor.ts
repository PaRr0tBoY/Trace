/**
 * TaskEditor pure model (ADR-0002) — clipboard candidate building, previews
 * and save gating. No React, no Electron: vitest drives it directly.
 *
 * The clipboard list starts with the 3 most recent items (anchors); selecting
 * apps expands the candidate set with those apps' items, single list, newest
 * first, deduped (anchor wins). "Show more" reveals +3 at a time, 15 cap.
 */
import type { ClipboardItemDto, ResourceSnapshot } from '../../shared/types'
import { appKeyFromIdentity } from '../../shared/appKey'
import { algorithmicTitle, MAX_TITLE_CHARS } from '../../shared/titles'
import { previewText, formatImageDisplayName } from './format'

/** Initial reveal: the 3 most recent items, any process. */
export const CLIPBOARD_ANCHOR_COUNT = 3
/** Hard cap for the revealed clipboard list (user-answered "15 封顶"). */
export const CLIPBOARD_MAX_ROWS = 15

/** One row of the clipboard list: a live item, or a dead linked snapshot. */
export interface ClipboardRow {
  /** Stable React key = itemId. */
  key: string
  /** Live shelf item; null for a linked snapshot whose item was evicted. */
  item: ClipboardItemDto | null
  /** Evicted-item snapshot (dead linked resource); null for live rows. */
  dead: ResourceSnapshot | null
  /** Linked to the task (pre-checked in edit mode, checkable live rows). */
  checked: boolean
}

/**
 * Build the clipboard candidate list: the anchor items (3 most recent,
 * any process) plus every item attributed to a selected app (ADR-0001
 * sourceApp, matched by the shared AppRef.id rule) plus every live item the
 * task already links (edit mode — a linked item must stay visible and
 * uncheckable even when its app is not selected). Dedup keeps the first
 * occurrence; the result is newest-first. `selected` drives the checkmark
 * (create mode starts empty; edit mode is seeded from the task's refs).
 * Linked-but-evicted snapshots become non-interactive dead rows at the end.
 */
export function buildClipboardRows(
  items: readonly ClipboardItemDto[],
  selectedAppIds: ReadonlySet<string>,
  linked: ReadonlyMap<string, ResourceSnapshot>,
  selected: ReadonlySet<string>
): ClipboardRow[] {
  const anchors = items.slice(0, CLIPBOARD_ANCHOR_COUNT)
  const fromApps =
    selectedAppIds.size > 0
      ? items.filter((it) => it.sourceApp && selectedAppIds.has(appKeyFromIdentity(it.sourceApp)))
      : []
  const linkedLive = items.filter((it) => linked.has(it.id))
  const seen = new Set<string>()
  const live: ClipboardRow[] = []
  for (const it of [...anchors, ...fromApps, ...linkedLive]) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    live.push({ key: it.id, item: it, dead: null, checked: selected.has(it.id) })
  }
  live.sort((a, b) => b.item!.capturedAt - a.item!.capturedAt)

  const liveIds = new Set(live.map((r) => r.key))
  const dead: ClipboardRow[] = []
  for (const [itemId, snapshot] of linked) {
    if (liveIds.has(itemId)) continue
    dead.push({ key: itemId, item: null, dead: snapshot, checked: true })
  }
  return [...live, ...dead]
}

/**
 * How many rows to reveal for a selection: 3 anchors, one +3 step per
 * selected app (selection produces more choices — progressive disclosure),
 * capped at 15. "Show more" then adds +3 from here.
 */
export function revealStepForApps(selectedAppCount: number): number {
  return Math.min(CLIPBOARD_MAX_ROWS, CLIPBOARD_ANCHOR_COUNT + 3 * selectedAppCount)
}

/** The ADR-0003 save gate: nothing to go on at all (no title, no context) → disabled. */
export function canSaveTaskForm(title: string, hasApps: boolean, hasItems: boolean, note: string): boolean {
  return title.trim().length > 0 || hasApps || hasItems || note.trim().length > 0
}

/**
 * ADR-0003 fallback title when AI generation fails: the app-based algorithm
 * title ("X + Y task") when apps are selected; otherwise the note or the
 * first checked item's preview. The flow guarantees context exists (the save
 * gate), so "Untitled task" is unreachable here.
 */
export function fallbackTaskTitle(appNames: string[], note: string, previews: string[]): string {
  if (appNames.length > 0) return algorithmicTitle(appNames)
  const basis = note.trim() || previews[0] || ''
  return basis.slice(0, MAX_TITLE_CHARS) || 'Untitled task'
}

/** Display + LLM-context preview of a live clipboard item. */
export function clipboardPreview(item: ClipboardItemDto): string {
  switch (item.data.kind) {
    case 'text':
      return previewText(item.data.text, 60)
    case 'image':
      return `${item.data.width}×${item.data.height}`
    case 'image-collection':
      return `${item.data.images.length} images`
    case 'files':
      return item.data.paths.map((p) => formatImageDisplayName(p, item.capturedAt)).join(', ')
  }
}
