/**
 * App icon extraction glue (t26) — the Electron side of appIconCore.
 *
 * Feeds app.getFileIcon results into the shared cache and exposes the two
 * push-time batch attachment functions that pushState (state.ts) awaits
 * before broadcasting state:tasks / state:suggestions.
 */
import { app } from 'electron'
import type { Suggestion, TaskDto } from '../../shared/types'
import { createAppIconService } from './appIconCore'

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

const service = createAppIconService({ fetchIcon: fetchElectronIcon })

/** Fill TaskDto.apps[].iconUrl in place (fresh DTO objects only). */
export function attachAppIcons(tasks: TaskDto[]): Promise<TaskDto[]> {
  return service.attachToTasks(tasks)
}

/** Fill Suggestion.appIcons from the engine-provided appExePaths. */
export function attachSuggestionIcons(suggestions: Suggestion[]): Promise<Suggestion[]> {
  return service.attachToSuggestions(suggestions)
}

/** Resolve one exePath to a dataURL (cache-first, never rejects) — the app:icons IPC. */
export function resolveAppIcon(exePath: string): Promise<string | null> {
  return service.resolve(exePath)
}
