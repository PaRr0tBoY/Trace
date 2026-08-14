/**
 * App icon extraction glue (t26) — the Electron side of appIconCore.
 *
 * Feeds app.getFileIcon results into the shared cache and exposes the two
 * push-time batch attachment functions that pushState (state.ts) awaits
 * before broadcasting state:tasks / state:suggestions.
 *
 * Persistence: successful extractions are written to a debounced JSON file
 * under userData and restored on startup, so icons survive restarts and the
 * UI never shows the letter fallback while extraction catches up. Failed
 * extractions are never persisted (the in-memory negative cache has its own
 * TTL in appIconCore).
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import type { TaskProposal, TaskDto } from '../../shared/types'
import { createAppIconService, normalizeIconKey } from './appIconCore'
import { PATHS } from '../store/paths'

/** Disk entries older than this are re-extracted in the background on startup. */
const DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60_000
/** Debounce window for writing the snapshot to disk. */
const PERSIST_DEBOUNCE_MS = 800

interface DiskEntry {
  url: string
  ts: number
}

/** Resolve an exePath to a PNG dataURL, or null on any failure (missing file, empty icon). */
async function fetchElectronIcon(exePath: string): Promise<string | null> {
  try {
    const icon = await app.getFileIcon(exePath, { size: 'normal' })
    if (icon.isEmpty()) return null
    return icon.toDataURL()
  } catch {
    return null
  }
}

const service = createAppIconService({ fetchIcon: fetchElectronIcon }, undefined, schedulePersist)

let persistTimer: NodeJS.Timeout | null = null
function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      const now = Date.now()
      const payload: Record<string, DiskEntry> = {}
      for (const [key, url] of service.snapshot()) payload[key] = { url, ts: now }
      const file = PATHS.appIconsFile()
      writeFileSync(file + '.tmp', JSON.stringify(payload), 'utf8')
      renameSync(file + '.tmp', file)
    } catch {
      /* icon cache is cosmetic — a failed write is never fatal */
    }
  }, PERSIST_DEBOUNCE_MS)
}

/** Restore the disk cache before the first push attaches icons. */
export function loadAppIconCacheFromDisk(): void {
  try {
    const file = PATHS.appIconsFile()
    if (!existsSync(file)) return
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, DiskEntry>
    const now = Date.now()
    const entries = new Map<string, string>()
    for (const [key, entry] of Object.entries(raw)) {
      if (typeof entry?.url === 'string' && now - entry.ts < DISK_CACHE_TTL_MS) {
        entries.set(key, entry.url)
      }
    }
    service.seed(entries)
  } catch {
    /* corrupt or absent cache: start empty, the prewarm refetches */
  }
}

/**
 * Background prewarm: extract icons for every app that currently has a
 * window (the Alt+Tab ring — exactly the set the switcher, task editor and
 * suggestion cards can show). Apps not running right now are covered by the
 * disk cache from earlier sessions, and by the incremental extraction on
 * foreground events (see the subscribeEvents wiring in index.ts). Never
 * rejects; failures just stay out of the cache until re-probed.
 */
export async function prewarmAppIcons(windows: readonly { exePath: string }[]): Promise<void> {
  const paths = new Set<string>()
  for (const w of windows) {
    if (w.exePath && (/[\\/]/.test(w.exePath) || /\.exe$/i.test(w.exePath))) {
      paths.add(normalizeIconKey(w.exePath))
    }
  }
  await Promise.all([...paths].map((p) => service.resolve(p)))
}

/** Fill TaskDto.apps[].iconUrl in place (fresh DTO objects only). */
export function attachAppIcons(tasks: TaskDto[]): Promise<TaskDto[]> {
  return service.attachToTasks(tasks)
}

/** Fill TaskProposal.appIcons from the engine-provided appExePaths. */
export function attachSuggestionIcons(suggestions: TaskProposal[]): Promise<TaskProposal[]> {
  return service.attachToSuggestions(suggestions)
}

/** Resolve one exePath to a dataURL (cache-first, never rejects) — the app:icons IPC. */
export function resolveAppIcon(exePath: string): Promise<string | null> {
  return service.resolve(exePath)
}
