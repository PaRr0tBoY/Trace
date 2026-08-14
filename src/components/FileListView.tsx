/**
 * FileListView — the files view body (ADR-0004).
 *
 * 'all' renders the grouped entries — transfer station cards (ADR-0006)
 * first, then legacy stack file entries (reusing ClipboardItemCard); an
 * extension tab or 'other' renders single file *members* as rows with the
 * same interactions as the expanded stack: drag out the single path, click
 * to paste it, copy button → copy-subitem (never creates a new entry), pin
 * button → pins the parent entry.
 */
import { useMemo } from 'react'
import { useStore } from '../store/appStore'
import { useTranslation } from '../i18n'
import { useFileMembers } from '../hooks/useFilteredItems'
import { ClipboardItemCard } from './ClipboardItem'
import { StationEntryCard } from './StationEntryCard'
import { FileMemberRow } from './FileMemberRow'
import { EmptyState } from './EmptyState'
import { isImageItem } from '../lib/fileTabs'
import { basename } from '../lib/format'
import type { FileMember } from '../lib/fileTabs'
import type { StationEntryDto } from '../../shared/station'
import type { ClipboardItemDto } from '../../shared/types'

export function FileListView() {
  const { t } = useTranslation()
  const query = useStore((s) => s.query)
  const tutorialStep = useStore((s) => s.tutorialStep)
  const files = useFileMembers()

  // Grouped mode: station entries + every non-image file entry, pinned
  // first in each domain. Independent of the clipboard view's second-level
  // filter. Station entries are hidden during the onboarding tour.
  const fileItems = useStore((s) => s.items)
  const station = useStore((s) => s.station)
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
    const stationSearched = q
      ? station.filter((e) => e.paths.some((p) => basename(p).toLowerCase().includes(q)))
      : station
    const toStationRows = (entries: StationEntryDto[]): Row[] => entries.map((entry) => ({ kind: 'station' as const, entry }))
    const toItemRows = (items: ClipboardItemDto[]): Row[] => items.map((item) => ({ kind: 'item' as const, item }))
    return {
      pinned: [...toStationRows(stationVisible ? stationSearched.filter((e) => e.pinned) : []), ...toItemRows(searched.filter((it) => it.pinned))],
      recent: [...toStationRows(stationVisible ? stationSearched.filter((e) => !e.pinned) : []), ...toItemRows(searched.filter((it) => !it.pinned))]
    }
  }, [fileItems, station, query, tutorialStep])

  const renderRow = (row: { kind: 'station'; entry: StationEntryDto } | { kind: 'item'; item: ClipboardItemDto }) =>
    row.kind === 'station' ? <StationEntryCard key={row.entry.id} entry={row.entry} /> : <ClipboardItemCard key={row.item.id} item={row.item} instant={false} />

  if (files.tabMembers === null) {
    const total = groupedEntries.pinned.length + groupedEntries.recent.length
    if (total === 0) {
      return <EmptyState filtered={query.trim().length > 0} />
    }
    return (
      <div className="list">
        {groupedEntries.pinned.length > 0 && (
          <section className="pinned-section">
            <div className="section-label">{t('item.pinned')}</div>
            {groupedEntries.pinned.map(renderRow)}
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
  const members = files.tabMembers
  if (members.length === 0) {
    return <EmptyState filtered={query.trim().length > 0} />
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
