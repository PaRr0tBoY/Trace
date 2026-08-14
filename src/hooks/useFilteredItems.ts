/**
 * useFilteredItems — derives the visible, grouped item list from raw state.
 *
 * Serves three views (ADR-0004):
 * - clipboard: pinned/recent split, filtered by clipboardFilter ('all'
 *   excludes file entries — files live in the files view).
 * - files:    'all' keeps the grouped file entries; an extension tab or
 *             'other' returns single file *members* for the member list.
 *
 * Kept as a selector so components stay presentational.
 */
import { useEffect, useMemo } from 'react'
import { useStore } from '../store/appStore'
import type { ClipboardItemDto, ClipboardFilter, FilesFilter } from '../../shared/types'
import { basename } from '../lib/format'
import { collectFileMembers, collectStationMembers, deriveFileTabs, filterMembersByTab, isFileTabAlive, isImageItem, MAX_EXT_TABS, type FileMember } from '../lib/fileTabs'
import { filterStationByRoute } from '../lib/stationRoute'

function matches(it: ClipboardItemDto, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  switch (it.data.kind) {
    case 'text':
      return it.data.text.toLowerCase().includes(needle)
    case 'files':
      return it.data.paths.some((p) => basename(p).toLowerCase().includes(needle))
    case 'image':
    case 'image-collection':
      // images have no searchable text; hidden by query
      return false
  }
}

function matchesClipboardFilter(it: ClipboardItemDto, filter: ClipboardFilter): boolean {
  switch (filter) {
    case 'all':
      // 'all' never includes file entries (ADR-0004).
      return it.data.kind !== 'files' || isImageItem(it)
    case 'text':
      return it.data.kind === 'text' && !it.data.isUrl
    case 'links':
      return it.data.kind === 'text' && !!it.data.isUrl
    case 'images':
      return isImageItem(it)
  }
}

export interface GroupedItems {
  pinned: ClipboardItemDto[]
  recent: ClipboardItemDto[]
}

/** Clipboard-view filtering (grouped). */
export function useFilteredItems(): GroupedItems {
  const items = useStore((s) => s.items)
  const query = useStore((s) => s.query)
  const clipboardFilter = useStore((s) => s.clipboardFilter)
  const tutorialStep = useStore((s) => s.tutorialStep)

  return useMemo(() => {
    const pinned: ClipboardItemDto[] = []
    const recent: ClipboardItemDto[] = []

    const filteredByTutorial = items.filter((it) => {
      if (tutorialStep <= 0) return true
      switch (tutorialStep) {
        case 1:
          return it.id === 'onboarding-welcome'
        case 2:
          return false
        case 3:
          return it.id === 'onboarding-image' || !it.id.startsWith('onboarding-')
        case 4:
          // The files card lives in the files view (useFileMembers handles it).
          return false
        case 5:
          return true
        default:
          return true
      }
    })

    for (const it of filteredByTutorial) {
      if (!matches(it, query.trim())) continue
      if (!matchesClipboardFilter(it, clipboardFilter)) continue
      ;(it.pinned ? pinned : recent).push(it)
    }
    return { pinned, recent }
  }, [items, query, clipboardFilter, tutorialStep])
}

export interface FileViewData {
  /** Every non-image file member (after search), in item order. */
  members: FileMember[]
  /**
   * Members under the active tab; null when the active filter is 'all'
   * (the caller renders grouped entries instead).
   */
  tabMembers: FileMember[] | null
  /** Extension tabs, count desc then alphabetical. */
  tabs: { ext: string; count: number }[]
  /** Number of extension-less members (the 'other' bucket). */
  otherCount: number
  /**
   * File members in the FULL corpus (every file item + every station
   * entry, both routes, no search) — whether the files view has any
   * entries at all, regardless of the active route/tab. The header uses
   * it to keep the second row (route chips + tabs) alive when the route
   * filter empties the visible list — otherwise the route chips vanish
   * and the user cannot switch back (feedback trap).
   */
  corpusCount: number
  /** The active filter — falls back to 'all' when the tab vanished. */
  activeFilter: FilesFilter
}

/**
 * Files-view data: extension tabs + the members under the active tab.
 * A vanished tab (its files were deleted) falls back to 'all'.
 */
export function useFileMembers(): FileViewData {
  const items = useStore((s) => s.items)
  const station = useStore((s) => s.station)
  const query = useStore((s) => s.query)
  const filesFilter = useStore((s) => s.filesFilter)
  const setFilesFilter = useStore((s) => s.setFilesFilter)
  const stationRouteFilter = useStore((s) => s.stationRouteFilter)
  const tutorialStep = useStore((s) => s.tutorialStep)

  const data = useMemo(() => {
    const filteredByTutorial = items.filter((it) => {
      if (tutorialStep <= 0) return true
      switch (tutorialStep) {
        case 4:
          return it.id === 'onboarding-files'
        default:
          return true
      }
    })
    // Extension tabs come from the FULL corpus — every file item and every
    // station entry, both routes, no search — so switching 全部/剪贴板 or
    // typing a query never reshuffles the tab set (feedback: tabs must stay
    // stable). Content under the active tab still applies route + search.
    const corpus = tutorialStep <= 0
      ? [...collectFileMembers(items), ...collectStationMembers(station)]
      : collectFileMembers(filteredByTutorial)
    const tabs = deriveFileTabs(corpus, MAX_EXT_TABS)
    // Station members feed the same member list/tabs (ADR-0006); hidden
    // during the onboarding tour so the tutorial items stay uncluttered.
    // The route filter (T6) narrows the station first; legacy stack file
    // items only show under 'all' (they have no route).
    const stationMembers = tutorialStep <= 0 ? collectStationMembers(filterStationByRoute(station, stationRouteFilter)) : []
    const members = [
      ...(stationRouteFilter === 'clipboard' ? [] : collectFileMembers(filteredByTutorial)),
      ...stationMembers
    ]
    const q = query.trim().toLowerCase()
    const searched = q ? members.filter((m) => m.name.toLowerCase().includes(q)) : members
    const activeFilter = isFileTabAlive(corpus, filesFilter, MAX_EXT_TABS) ? filesFilter : 'all'
    return {
      members: searched,
      tabMembers: activeFilter === 'all' ? null : filterMembersByTab(searched, activeFilter),
      tabs: tabs.tabs,
      otherCount: tabs.otherCount,
      corpusCount: corpus.length,
      activeFilter
    }
  }, [items, station, query, filesFilter, stationRouteFilter, tutorialStep])

  // A vanished tab falls back to 'all' (ADR-0004); sync the store so the
  // header highlight matches what is rendered.
  useEffect(() => {
    if (data.activeFilter !== filesFilter) setFilesFilter(data.activeFilter)
  }, [data.activeFilter, filesFilter, setFilesFilter])

  return data
}
