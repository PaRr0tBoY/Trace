/**
 * useFilteredItems — derives the visible, grouped item list from raw state.
 *
 * Serves three views (ADR-0004):
 * - clipboard: pinned/recent split, filtered by clipboardFilter ('all'
 *   excludes file entries — files live in the files view).
 * - files:    'all'/'clipboard' return flat file *members* (with the pinned
 *             shelf rendered by the caller); an extension tab or 'other'
 *             returns the tab's members.
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
  /** Every non-image file member (after search + route filter), in item order. */
  members: FileMember[]
  /**
   * Members under the active tab; null when the active filter is 'all' or
   * 'clipboard' (the caller renders the pinned shelf + flat member rows).
   */
  tabMembers: FileMember[] | null
  /** Extension tabs, count desc then alphabetical. */
  tabs: { ext: string; count: number }[]
  /** Number of extension-less members (the 'other' bucket). */
  otherCount: number
  /** The active filter — falls back to 'all' when the tab/route vanished. */
  activeFilter: FilesFilter
}

/**
 * Files-view data: extension tabs + the members under the active tab.
 * 'all' and 'clipboard' render flat member rows (feedback: files show as
 * members, not groups); a vanished tab or empty route falls back to 'all'.
 */
export function useFileMembers(): FileViewData {
  const items = useStore((s) => s.items)
  const station = useStore((s) => s.station)
  const query = useStore((s) => s.query)
  const filesFilter = useStore((s) => s.filesFilter)
  const setFilesFilter = useStore((s) => s.setFilesFilter)
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
    // Station members feed the same member list/tabs (ADR-0006); hidden
    // during the onboarding tour so the tutorial items stay uncluttered.
    // The route filter (T6, folded into FilesFilter) narrows the station
    // first; legacy stack file items only show under 'all'/ext tabs (they
    // have no route).
    const routeFilter = filesFilter === 'clipboard' ? 'clipboard' : 'all'
    const routeStation = filterStationByRoute(station, routeFilter)
    const stationMembers = tutorialStep <= 0 ? collectStationMembers(routeStation) : []
    const members = [
      ...(filesFilter === 'clipboard' ? [] : collectFileMembers(filteredByTutorial)),
      ...stationMembers
    ]
    const q = query.trim().toLowerCase()
    const searched = q ? members.filter((m) => m.name.toLowerCase().includes(q)) : members
    const tabs = deriveFileTabs(searched, MAX_EXT_TABS)
    const activeFilter =
      filesFilter === 'clipboard'
        ? routeStation.length > 0
          ? 'clipboard'
          : 'all'
        : isFileTabAlive(searched, filesFilter, MAX_EXT_TABS)
          ? filesFilter
          : 'all'
    return {
      members: searched,
      tabMembers: activeFilter === 'all' || activeFilter === 'clipboard' ? null : filterMembersByTab(searched, activeFilter),
      tabs: tabs.tabs,
      otherCount: tabs.otherCount,
      activeFilter
    }
  }, [items, station, query, filesFilter, tutorialStep])

  // A vanished tab or empty route falls back to 'all' (ADR-0004); sync the
  // store so the header highlight matches what is rendered.
  useEffect(() => {
    if (data.activeFilter !== filesFilter) setFilesFilter(data.activeFilter)
  }, [data.activeFilter, filesFilter, setFilesFilter])

  return data
}
