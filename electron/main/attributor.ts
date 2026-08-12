/**
 * Attributor (ticket 13) — routes L0 foreground events to tasks.
 *
 * Pure module: no Electron imports, no shared singletons. The event bus
 * subscription, the TaskStore and the renderer push callback are injected so
 * vitest can drive it end to end with a real TaskStore and a fake bus.
 *
 * Matching contract (spec decision 2): an event's app identity is the
 * lowercase, slash-normalized exePath — or the process name when no exePath
 * is known. That key must equal the AppRef.id of the task (t11 convention).
 * Attribution itself (most-recently-active disambiguation, WAITING auto-resume,
 * PAUSED immunity, lastContext refresh) lives in TaskStore.applyAttribution;
 * this module only maps events to keys, calls it and nudges the renderer
 * when a task changed.
 *
 * Privacy gates (task-capture / L0 switches, incognito) are enforced at the
 * collector (foreground.ts): no events leave it while disabled, so there is
 * nothing to re-check here.
 *
 * Clipboard capture events (t14) are logged here via buildClipboardEvent for
 * the suggestion engine; they are never auto-linked to tasks — a task's
 * clipboard content is fixed at creation and only changes by explicit user
 * action (drop-to-bind, task:link-item / unlink).
 */
import type { AppSwitchEvent, ClipboardEvent, UsageEvent } from '../../shared/types'
import { appKeyFromIdentity } from '../../shared/appKey'
import type { TaskStore } from '../store/TaskStore'

/** App identity carried by L0 events; app-switch and clipboard events share it. */
type AppIdentity = Pick<AppSwitchEvent, 'appName' | 'exePath'>

/** App identity key for an L0 event (AppRef.id semantics, shared rule). */
function appKeyFromEvent(event: AppIdentity): string {
  return appKeyFromIdentity({ name: event.appName, exePath: event.exePath })
}

export interface AttributorOptions {
  /** Task attribution entry point (t11). */
  store: Pick<TaskStore, 'applyAttribution'>
  /** Event bus subscription; injectable for tests. */
  subscribe: (listener: (event: UsageEvent) => void) => () => void
  /** Called after a task was attributed (wired to pushState.tasks in main). */
  onAttributed?: (taskId: string) => void
}

export interface Attributor {
  dispose(): void
}

export function createAttributor(options: AttributorOptions): Attributor {
  const { store, subscribe, onAttributed } = options
  let unsubscribe: (() => void) | null = null

  const handleEvent = (event: UsageEvent): void => {
    if (event.type !== 'app-switch') return // clipboard events feed the suggestion engine only
    const key = appKeyFromEvent(event)
    if (key.length === 0) return
    const taskId = store.applyAttribution(key, { windowTitle: event.windowTitle })
    if (taskId !== null) onAttributed?.(taskId)
  }

  unsubscribe = subscribe(handleEvent)
  console.log('[Attributor] started')

  return {
    dispose(): void {
      unsubscribe?.()
      unsubscribe = null
      console.log('[Attributor] stopped')
    }
  }
}

/* ------------------ clipboard attribution (ticket 14) ------------------- */

/**
 * Build the clipboard event logged when new content is captured. The source
 * app is the foreground snapshot read at capture time; itemId links the
 * event to the captured item (the suggestion engine resolves refs from it).
 */
export function buildClipboardEvent(
  snapshot: AppIdentity & { pid: number },
  ts: number,
  itemId?: string
): ClipboardEvent {
  return { type: 'clipboard', appName: snapshot.appName, exePath: snapshot.exePath, pid: snapshot.pid, ts, itemId }
}
