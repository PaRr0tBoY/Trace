/**
 * FileListView — the files view body (ADR-0004).
 *
 * 'all' renders the grouped entries — transfer station cards (ADR-0006)
 * first, then legacy stack file entries (reusing ClipboardItemCard).
 * Station entries are single-file since the grouping removal (2026-08-14)
 * and render as the clipboard card style with station routing. An
 * extension tab or 'other' renders single file *members* as rows with the
 * same interactions as the expanded stack: drag out the single path, click
 * to paste it, copy button → copy-subitem (never creates a new entry),
 * pin button → pins the parent entry.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useStore } from '../store/appStore'
import { useTranslation } from '../i18n'
import { useFileMembers } from '../hooks/useFilteredItems'
import { ClipboardItemCard } from './ClipboardItem'
import { FileMemberRow } from './FileMemberRow'
import { PinnedTile } from './PinnedTile'
import { EmptyState } from './EmptyState'
import { IncognitoBanner } from './IncognitoBanner'
import type { ViewFooterState } from './ViewFooter'
import { isImageItem } from '../lib/fileTabs'
import { basename } from '../lib/format'
import { filterStationByRoute, countStale } from '../lib/stationRoute'
import { playDeleteSound } from '../lib/soundEffects'
import type { FileMember } from '../lib/fileTabs'
import type { StationEntryDto } from '../../shared/station'
import type { ClipboardItemDto } from '../../shared/types'

/** Display conversion of a station entry into a clipboard item (station
 *  entries are single-file since the grouping removal — feedback 2026-08-14).
 *  `id` stays the entry's id so the card can route actions back to the
 *  station. */
function stationToItem(entry: StationEntryDto): ClipboardItemDto {
  const member = entry.members[0]
  const isImage = !!member?.isImage
  return {
    id: entry.id,
    capturedAt: entry.capturedAt,
    hitCount: 0,
    pinned: entry.pinned,
    data: {
      kind: 'files',
      paths: [entry.paths[0]],
      entries: member
        ? [
            {
              name: member.name,
              ext: member.ext,
              size: member.size,
              isImage,
              ...(isImage && member.exists ? { preview: `tracelocal://thumb/${encodeURIComponent(entry.paths[0])}` } : {})
            }
          ]
        : undefined
    }
  }
}

interface Props {
  /** Report this view's footer state up to Panel (the toolbar lives outside
   *  the view-transition animation and is rendered once, at Panel level). */
  onFooterChange: (footer: ViewFooterState | null) => void
}

export function FileListView({ onFooterChange }: Props) {
  const { t } = useTranslation()
  const query = useStore((s) => s.query)
  const tutorialStep = useStore((s) => s.tutorialStep)
  const files = useFileMembers()
  // T6 pinned grid: the tile clicked expands into a full card above the grid.
  const [expandedGridId, setExpandedGridId] = useState<string | null>(null)

  // Grouped mode: station entries + every non-image file entry, pinned
  // first in each domain. Independent of the clipboard view's second-level
  // filter. Station entries are hidden during the onboarding tour.
  const fileItems = useStore((s) => s.items)
  const station = useStore((s) => s.station)
  const filesFilter = useStore((s) => s.filesFilter)
  const groupedEntries = useMemo(() => {
    type Row = { kind: 'station'; entry: StationEntryDto } | { kind: 'item'; item: ClipboardItemDto }
    const filtered = fileItems.filter((it) => {
      if (tutorialStep <= 0) return it.data.kind === 'files' && !isImageItem(it)
      if (tutorialStep === 4) return it.id === 'onboarding-files'
      return it.data.kind === 'files' && !isImageItem(it)
    })
    const q = query.trim().toLowerCase()
    const searched = q
      ? filtered.filter((it) => it.data.kind === 'files' && it.data.paths.some((p) => basename(p).toLowerCase().includes(q)))
      : filtered
    const stationVisible = tutorialStep <= 0
    // The 'clipboard' pseudo-tab (T6): station entries narrow to
    // clipboard-captured entries; stack file items have no route and hide
    // under it.
    const clipboardOnly = filesFilter === 'clipboard'
    const routeStation = stationVisible ? filterStationByRoute(station, clipboardOnly ? 'clipboard' : 'all') : []
    const stationSearched = q
      ? routeStation.filter((e) => e.paths.some((p) => basename(p).toLowerCase().includes(q)))
      : routeStation
    const toStationRows = (entries: StationEntryDto[]): Row[] => entries.map((entry) => ({ kind: 'station' as const, entry }))
    const toItemRows = (items: ClipboardItemDto[]): Row[] => items.map((item) => ({ kind: 'item' as const, item }))
    const visibleItems = clipboardOnly ? [] : searched
    return {
      pinned: [...toStationRows(stationSearched.filter((e) => e.pinned)), ...toItemRows(visibleItems.filter((it) => it.pinned))],
      recent: [...toStationRows(stationSearched.filter((e) => !e.pinned)), ...toItemRows(visibleItems.filter((it) => !it.pinned))]
    }
  }, [fileItems, station, query, tutorialStep, filesFilter])

  const staleCount = useMemo(() => countStale(station), [station])
  const stationPinned = useMemo(
    () => groupedEntries.pinned.filter((r): r is { kind: 'station'; entry: StationEntryDto } => r.kind === 'station'),
    [groupedEntries]
  )
  // The expanded card leaves the grid; a stale id (entry unpinned meanwhile)
  // simply renders nothing.
  const gridEntries = stationPinned.filter((r) => r.entry.id !== expandedGridId).map((r) => r.entry)
  const expandedEntry = stationPinned.find((r) => r.entry.id === expandedGridId)?.entry ?? null
  const itemPinned = groupedEntries.pinned.filter((r): r is { kind: 'item'; item: ClipboardItemDto } => r.kind === 'item')

  // An unpinned (or deleted/filtered-out) expanded entry goes back to the
  // grid — re-pinning must not resurrect the expanded card.
  useEffect(() => {
    if (expandedGridId !== null && !expandedEntry) setExpandedGridId(null)
  }, [expandedGridId, expandedEntry])

  const staleBanner = staleCount > 0 && tutorialStep <= 0 ? (
    <div className="stale-banner">
      <span className="stale-banner-text">{t('item.missingFilesBanner', { count: staleCount })}</span>
      <button
        className="stale-banner-btn"
        onClick={(e) => {
          e.currentTarget.blur()
          playDeleteSound()
          void useStore.getState().stationClearStale()
        }}
      >
        {t('item.clearMissing')}
      </button>
    </div>
  ) : null

  const renderRow = (row: { kind: 'station'; entry: StationEntryDto } | { kind: 'item'; item: ClipboardItemDto }) =>
    row.kind === 'station'
      ? <ClipboardItemCard key={row.entry.id} item={stationToItem(row.entry)} stationEntry={row.entry} instant={false} />
      : <ClipboardItemCard key={row.item.id} item={row.item} instant={false} />

  /**
   * One-click clear (mirrors the clipboard view's footer): remove every
   * unpinned file in the current route view — station entries and legacy
   * file items alike, pinned files stay (user feedback 2026-08-14). The
   * 'clipboard' pseudo-tab clears only clipboard-captured station entries;
   * 'all' clears every unpinned file entry.
   */
  const clearScopedFiles = useCallback((): void => {
    const state = useStore.getState()
    const filter = state.filesFilter || 'all'
    const routeEntries = filterStationByRoute(state.station, filter === 'clipboard' ? 'clipboard' : 'all')
    const unpinnedStation = routeEntries.filter((e) => !e.pinned)
    // Legacy file items hide under the clipboard pseudo-tab — only 'all' clears them.
    const unpinnedItems = filter === 'clipboard'
      ? []
      : state.items.filter((it) => it.data.kind === 'files' && !isImageItem(it) && !it.pinned)
    void (async () => {
      for (const e of unpinnedStation) {
        await state.stationDelete(e.id)
      }
      if (unpinnedItems.length > 0) {
        await state.clear(unpinnedItems.map((it) => it.id))
      }
    })()
  }, [])

  /**
   * Member-mode clear: remove every unpinned parent entry of the members
   * shown under the active extension/'other' tab (the current view's
   * content only). Station membership wins over item membership (same rule
   * as FileMemberRow).
   */
  const clearScopedMembers = useCallback((): void => {
    const state = useStore.getState()
    const memberIds = [...new Set((files.tabMembers ?? []).map((m) => m.itemId))]
    const stationIds = memberIds.filter((id) => state.station.some((e) => e.id === id && !e.pinned))
    const itemIds = memberIds.filter((id) => state.items.some((it) => it.id === id && !it.pinned) && !state.station.some((e) => e.id === id))
    void (async () => {
      for (const id of stationIds) {
        await state.stationDelete(id)
      }
      if (itemIds.length > 0) {
        await state.clear(itemIds)
      }
    })()
  }, [files])

  // Footer data, hoisted so the shared toolbar (rendered by Panel outside
  // the view-transition animation) gets it before the browser paints.
  const groupedMode = files.tabMembers === null
  const members = files.tabMembers ?? []
  const total = groupedMode ? groupedEntries.pinned.length + groupedEntries.recent.length : members.length
  // Clear scope is the whole route view (ignores the search query, which
  // only narrows the visible list).
  const scopeCount = groupedMode
    ? (filesFilter === 'clipboard' ? [] : fileItems.filter((it) => it.data.kind === 'files' && !isImageItem(it) && !it.pinned)).length +
      filterStationByRoute(station, filesFilter === 'clipboard' ? 'clipboard' : 'all').filter((e) => !e.pinned).length
    : 0
  const memberScopeClearable = groupedMode
    ? false
    : members.some((m) => {
        const st = useStore.getState().station.find((e) => e.id === m.itemId)
        if (st) return !st.pinned
        const it = useStore.getState().items.find((i) => i.id === m.itemId)
        return it ? !it.pinned : false
      })

  useLayoutEffect(() => {
    onFooterChange(groupedMode
      ? {
          count: total,
          noun: 'item',
          clearLabel: t('item.clear'),
          clearTitle: t('item.clearScoped'),
          clearDisabled: scopeCount === 0,
          onClear: clearScopedFiles
        }
      : {
          count: total,
          noun: 'item',
          clearLabel: t('item.clear'),
          clearTitle: t('item.clearScoped'),
          clearDisabled: !memberScopeClearable,
          onClear: clearScopedMembers
        })
  }, [groupedMode, total, scopeCount, memberScopeClearable, clearScopedFiles, clearScopedMembers, onFooterChange, t])

  if (groupedMode) {
    if (total === 0) {
      return (
        <>
          <EmptyState filtered={query.trim().length > 0} />
        </>
      )
    }
    return (
      <div className="list">
        {staleBanner}
        {/* The clipboard pseudo-tab shows clipboard-captured files — the
            incognito notice belongs here, next to the content it affects. */}
        {filesFilter === 'clipboard' && <IncognitoBanner />}
        {groupedEntries.pinned.length > 0 && (
          <section className="pinned-section">
            <div className="section-label">{t('item.pinned')}</div>
            {expandedEntry && (
              <ClipboardItemCard key={expandedEntry.id} item={stationToItem(expandedEntry)} stationEntry={expandedEntry} instant={false} />
            )}
            {gridEntries.length > 0 && (
              <div className="pinned-grid">
                {gridEntries.map((e) => (
                  <PinnedTile key={e.id} entry={e} onExpand={setExpandedGridId} />
                ))}
              </div>
            )}
            {itemPinned.map((r) => (
              <ClipboardItemCard key={r.item.id} item={r.item} instant={false} />
            ))}
          </section>
        )}
        {groupedEntries.recent.length > 0 && (
          <section>
            {groupedEntries.pinned.length > 0 && <div className="section-label">{t('item.recent')}</div>}
            {groupedEntries.recent.map(renderRow)}
          </section>
        )}
      </div>
    )
  }

  // Member mode: single rows under the active extension/'other' tab.
  if (members.length === 0) {
    return (
      <EmptyState filtered={query.trim().length > 0} />
    )
  }

  // Keep members of the same parent entry contiguous (the parent's order in
  // the list is preserved).
  const grouped: { itemId: string; members: FileMember[] }[] = []
  for (const m of members) {
    const last = grouped[grouped.length - 1]
    if (last && last.itemId === m.itemId) {
      last.members.push(m)
    } else {
      grouped.push({ itemId: m.itemId, members: [m] })
    }
  }

  return (
    <div className="list">
      {staleBanner}
      {grouped.map((g) => (
        <section key={g.itemId} style={{ marginBottom: 8 }}>
          {g.members.map((m) => (
            <FileMemberRow key={`${m.itemId}:${m.index}`} member={m} />
          ))}
        </section>
      ))}
    </div>
  )
}
