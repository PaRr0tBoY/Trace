/**
 * Station route filtering (T6) — pure projections over station entries.
 *
 * The route filter narrows the files view to clipboard-captured entries;
 * the transfer station is the only domain with routes, so stack file items
 * are excluded in that mode.
 */
import type { StationEntryDto, StationRoute } from '../../shared/station'

/** The route filter state: 'all' shows every entry, 'clipboard' only clipboard captures. */
export type StationRouteFilter = 'all' | StationRoute

/** Keep station entries that survive the route filter. */
export function filterStationByRoute(entries: StationEntryDto[], filter: StationRouteFilter): StationEntryDto[] {
  if (filter === 'all') return entries
  return entries.filter((e) => e.route === filter)
}

/** Number of stale entries (the cleanup banner count). */
export function countStale(entries: StationEntryDto[]): number {
  return entries.reduce((n, e) => n + (e.stale ? 1 : 0), 0)
}
