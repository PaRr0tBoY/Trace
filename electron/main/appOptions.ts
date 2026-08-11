/**
 * App options for the task editor (ADR-0002) — pure module, no Electron
 * imports, directly unit-testable.
 *
 * The selectable set is the union of two views of the same foreground
 * tracker: apps seen by L0 window tracking (the event bus holds app-switch
 * AND clipboard events) and apps that produced clipboard items (persisted
 * sourceApp). Same identity rule, so ids never collide. The bus is in-memory
 * and cleared on restart; sourceApp is persistent, so the set degrades
 * gracefully to just the clipboard-proven apps until events accumulate.
 */
import type { AppRef, ClipboardItem, UsageEvent } from '../../shared/types'
import { appKeyFromIdentity } from '../../shared/appKey'

export function mergeAppOptions(events: readonly UsageEvent[], items: readonly ClipboardItem[]): AppRef[] {
  const byKey = new Map<string, AppRef>()
  const add = (name: string, exePath: string | undefined): void => {
    const id = appKeyFromIdentity({ name, exePath })
    if (id.length === 0) return
    if (!byKey.has(id)) byKey.set(id, { id, name, exePath })
  }
  for (const e of events) add(e.appName, e.exePath)
  for (const it of items) {
    if (it.sourceApp) add(it.sourceApp.name, it.sourceApp.exePath)
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}
