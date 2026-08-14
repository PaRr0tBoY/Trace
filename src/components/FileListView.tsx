/**
 * FileListView — the files view body (ADR-0004).
 *
 * 'all'/'clipboard' render the pinned shelf (station grid + pinned stack
 * cards) plus flat *member* rows below it (feedback: files show as members,
 * not group cards); an extension tab or 'other' renders single file members
 * as rows. Member rows carry the same interactions as the expanded stack:
 * drag out the single path, click to paste it, copy button → copy-subitem
 * (never creates a new entry), pin button → pins the parent entry, and
 * station rows get an entry-level delete (the group card no longer shows).
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/appStore'
import { useTranslation } from '../i18n'
import { useFileMembers } from '../hooks/useFilteredItems'
import { ClipboardItemCard } from './ClipboardItem'
import { StationEntryCard } from './StationEntryCard'
import { FileMemberRow } from './FileMemberRow'
import { PinnedTile } from './PinnedTile'
import { EmptyState } from './EmptyState'
import { isImageItem } from '../lib/fileTabs'
import { basename } from '../lib/format'
import { filterStationByRoute, countStale } from '../lib/stationRoute'
import { playDeleteSound } from '../lib/soundEffects'
import type { FileMember } from '../lib/fileTabs'
import type { StationEntryDto } from '../../shared/station'
import type { ClipboardItemDto } from '../../shared/types'

export function FileListView() {
  const { t } = useTranslation()
  const query = useStore((s) => s.query)
  const tutorialStep = useStore((s) => s.tutorialStep)
  const files = useFileMembers()
  // T6 pinned grid: the tile clicked expands into a full card above the grid.
  const [expandedGridId, setExpandedGridId] = useState<string | null>(null)

  // Pinned shelf: station entries + every non-image file entry, pinned
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
    // Route filter (T6, folded into FilesFilter): 'clipboard' keeps only
    // clipboard-captured station entries; stack file items have no route
    // and hide under it.
    const routeStation = stationVisible ? filterStationByRoute(station, filesFilter === 'clipboard' ? 'clipboard' : 'all') : []
    const stationSearched = q
      ? routeStation.filter((e) => e.paths.some((p) => basename(p).toLowerCase().includes(q)))
      : routeStation
    const toStationRows = (entries: StationEntryDto[]): Row[] => entries.map((entry) => ({ kind: 'station' as const, entry }))
    const toItemRows = (items: ClipboardItemDto[]): Row[] => items.map((item) => ({ kind: 'item' as const, item }))
    const visibleItems = filesFilter === 'clipboard' ? [] : searched
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

  // Flat mode ('all'/'clipboard'): pinned shelf above, then every member
  // of unpinned entries as rows (feedback: files show as members, not
  // group cards). Members of pinned entries are excluded — the shelf
  // already shows them at entry level.
  const pinnedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of groupedEntries.pinned) ids.add(r.kind === 'station' ? r.entry.id : r.item.id)
    return ids
  }, [groupedEntries])
  const flatMembers = useMemo(
    () => files.members.filter((m) => !pinnedIds.has(m.itemId)),
    [files.members, pinnedIds]
  )

  // Keep members of the same parent entry contiguous (the parent's order in
  // the list is preserved).
  const groupByEntry = (members: FileMember[]): { itemId: string; members: FileMember[] }[] => {
    const grouped: { itemId: string; members: FileMember[] }[] = []
    for (const m of members) {
      const last = grouped[grouped.length - 1]
      if (last && last.itemId === m.itemId) {
        last.members.push(m)
      } else {
        grouped.push({ itemId: m.itemId, members: [m] })
      }
    }
    return grouped
  }

  if (files.tabMembers === null) {
    const total = groupedEntries.pinned.length + groupedEntries.recent.length
    if (total === 0) {
      return <EmptyState filtered={query.trim().length > 0} />
    }
    return (
      <div className="list">
        {staleBanner}
        {groupedEntries.pinned.length > 0 && (
          <section className="pinned-section">
            <div className="section-label">{t('item.pinned')}</div>
            {expandedEntry && <StationEntryCard key={expandedEntry.id} entry={expandedEntry} defaultExpanded />}
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
        {flatMembers.length > 0 && (
          <section>
            {groupedEntries.pinned.length > 0 && <div className="section-label">{t('item.recent')}</div>}
            {groupByEntry(flatMembers).map((g) => (
              <section key={g.itemId} style={{ marginBottom: 8 }}>
                {g.members.map((m) => (
                  <FileMemberRow key={`${m.itemId}:${m.index}`} member={m} />
                ))}
              </section>
            ))}
          </section>
        )}
      </div>
    )
  }

  // Member mode: single rows under the active extension/'other' tab.
  const members = files.tabMembers
  if (members.length === 0) {
    return <EmptyState filtered={query.trim().length > 0} />
  }

  return (
    <div className="list">
      {staleBanner}
      {groupByEntry(members).map((g) => (
        <section key={g.itemId} style={{ marginBottom: 8 }}>
          {g.members.map((m) => (
            <FileMemberRow key={`${m.itemId}:${m.index}`} member={m} />
          ))}
        </section>
      ))}
    </div>
  )
}
