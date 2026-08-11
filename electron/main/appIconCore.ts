/**
 * App icon resolution core (t26) — pure module, no Electron imports.
 *
 * The Electron glue (app.getFileIcon) lives in appIcons.ts and is injected as
 * the fetcher, so vitest can drive the cache and batch-assembly logic without
 * an Electron runtime (same split as geometry/power).
 */
import type { Suggestion, TaskDto } from '../../shared/types'

/** Resolve one exePath to a dataURL, or null when extraction fails. */
export interface IconFetcher {
  fetchIcon(exePath: string): Promise<string | null>
}

export interface AppIconService {
  /** Synchronous for cached paths, async fetch on miss; never rejects. */
  resolve(exePath: string): Promise<string | null>
  attachToTasks(tasks: TaskDto[]): Promise<TaskDto[]>
  attachToSuggestions(suggestions: Suggestion[]): Promise<Suggestion[]>
}

export const APP_ICON_CACHE_MAX = 128

/** Windows paths are case-insensitive; one cache entry per file, not per casing. */
export function normalizeIconKey(exePath: string): string {
  return exePath.toLowerCase()
}

export function createAppIconService(fetcher: IconFetcher, max = APP_ICON_CACHE_MAX): AppIconService {
  // exePath (normalized) -> dataURL, or null for a failed extraction (negative
  // cache: a dead path must not be re-probed on every push).
  const cache = new Map<string, string | null>()

  async function resolve(exePath: string): Promise<string | null> {
    const key = normalizeIconKey(exePath)
    if (cache.has(key)) {
      const hit = cache.get(key)!
      cache.delete(key)
      cache.set(key, hit) // refresh LRU recency
      return hit
    }
    let value: string | null
    try {
      value = await fetcher.fetchIcon(exePath)
    } catch {
      value = null
    }
    cache.set(key, value)
    if (cache.size > max) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return value
  }

  /** Unique exePaths across a batch, normalized; returns original-cased path per key. */
  function collectPaths(tasks: TaskDto[], suggestions: Suggestion[]): Map<string, string> {
    const paths = new Map<string, string>()
    for (const task of tasks) {
      for (const app of task.apps) {
        if (app.exePath) paths.set(normalizeIconKey(app.exePath), app.exePath)
      }
    }
    for (const s of suggestions) {
      for (const p of s.appExePaths ?? []) {
        if (p) paths.set(normalizeIconKey(p), p)
      }
    }
    return paths
  }

  async function attachToTasks(tasks: TaskDto[]): Promise<TaskDto[]> {
    if (tasks.length === 0) return tasks
    const paths = collectPaths(tasks, [])
    if (paths.size === 0) return tasks
    const entries = await Promise.all([...paths.values()].map(async (p) => [p, await resolve(p)] as const))
    const byPath = new Map(entries)
    for (const task of tasks) {
      if (task.apps.length === 0) continue
      task.apps = task.apps.map((app) => {
        if (!app.exePath) return app
        const iconUrl = byPath.get(app.exePath)
        return iconUrl ? { ...app, iconUrl } : app
      })
    }
    return tasks
  }

  async function attachToSuggestions(suggestions: Suggestion[]): Promise<Suggestion[]> {
    if (suggestions.length === 0) return suggestions
    const paths = collectPaths([], suggestions)
    if (paths.size === 0) return suggestions
    const entries = await Promise.all([...paths.values()].map(async (p) => [p, await resolve(p)] as const))
    const byPath = new Map(entries)
    for (const s of suggestions) {
      const exePaths = s.appExePaths ?? []
      if (exePaths.length === 0) continue
      const icons: { name: string; iconUrl: string }[] = []
      for (let i = 0; i < exePaths.length; i++) {
        const iconUrl = byPath.get(exePaths[i])
        if (iconUrl) icons.push({ name: s.appNames[i] ?? exePaths[i], iconUrl })
      }
      if (icons.length > 0) s.appIcons = icons
    }
    return suggestions
  }

  return { resolve, attachToTasks, attachToSuggestions }
}
