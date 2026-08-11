/**
 * Drop-to-bind composition (t25): accept a suggestion and attach the dragged
 * resource to the resulting task in one main-side step.
 *
 * Kept out of suggestionEngine (finalized) and out of the IPC layer (untested
 * by convention) so the composition is unit-testable with injected pieces:
 * the engine's `accept` and the TaskStore both come in as dependencies.
 * The clipboard ref is built by the caller (ItemStore access lives there);
 * files paths are sanitized here before they touch the store.
 */
import type { ResourceRef, Task } from '../../shared/types'
import type { TaskStore } from '../store/TaskStore'
import type { SuggestionEngine } from './suggestionEngine'

/** Trim, drop empties and in-list duplicates — the files-ref boundary shape. */
function cleanPaths(paths: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    const s = p.trim()
    if (s.length === 0 || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * Accept the suggestion (merge into its candidate task or create a new one),
 * then link the resource onto the accepted task. Returns the accepted task
 * id, or null when the suggestion is stale — in which case nothing is linked.
 */
export function acceptWithResource(
  engine: Pick<SuggestionEngine, 'accept'>,
  store: TaskStore,
  id: string,
  titleOverride: string | undefined,
  resource: ResourceRef
): Task['id'] | null {
  const taskId = engine.accept(id, titleOverride)
  if (!taskId) return null

  const ref: ResourceRef =
    resource.kind === 'files' ? { kind: 'files', paths: cleanPaths(resource.paths) } : resource
  store.linkItem(taskId, ref)
  return taskId
}
