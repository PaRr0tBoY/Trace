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
 * Attribution itself (most-recently-active disambiguation, Paused auto-resume,
 * lastContext refresh) lives in TaskStore.applyAttribution; this module only
 * maps events to keys, calls it and nudges the renderer when a task changed.
 *
 * Privacy gates (task-capture / L0 switches, incognito) are enforced at the
 * collector (foreground.ts): no events leave it while disabled, so there is
 * nothing to re-check here.
 *
 * Clipboard auto-attribution (ticket 14) lives here as pure functions too:
 * buildClipboardEvent constructs the logged event, decideClipboardAttribution
 * is the link decision (event + tasks + switch -> task id). state.ts wires
 * them into the clipboard capture callback.
 */
import type { AppSwitchEvent, ClipboardEvent, Task, UsageEvent } from '../../shared/types'
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
    if (event.type !== 'app-switch') return // clipboard attribution is t14's job
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
 * app is the foreground snapshot read at capture time.
 */
export function buildClipboardEvent(
  snapshot: AppIdentity & { pid: number },
  ts: number
): ClipboardEvent {
  return { type: 'clipboard', appName: snapshot.appName, exePath: snapshot.exePath, pid: snapshot.pid, ts }
}

/**
 * Decide whether a captured clipboard item links to a task.
 *
 * Same rules as t13's app-switch attribution (spec decision 4): only Active
 * or Paused tasks qualify; the event's app identity must match a task AppRef
 * id; when several tasks share the app, the most recently active wins.
 * `enabled` is the "clipboard auto-attribution" setting — off degrades to
 * manual linking only. Pure: never mutates tasks or the store.
 */
export function decideClipboardAttribution(
  event: ClipboardEvent,
  tasks: readonly Task[],
  enabled: boolean
): string | null {
  if (!enabled) return null
  const key = appKeyFromEvent(event)
  if (key.length === 0) return null
  let best: Task | null = null
  for (const t of tasks) {
    if (t.status !== 'active' && t.status !== 'paused') continue
    if (t.apps.some((a) => a.id === key) && (!best || t.lastActiveAt > best.lastActiveAt)) {
      best = t
    }
  }
  return best ? best.id : null
}
