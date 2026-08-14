/**
 * Drop-to-bind actions shared by every drop surface (t25): the binding panel's
 * task rows / suggestion cards and Panel's internal-drop resolution (OLE
 * drags never fire DOM drop events, so main probes the drop position and
 * Panel calls these directly).
 *
 * `linkDraggedItem` lives here instead of TaskDropBar (deleted) so the
 * clipboard-item link path and the file-path link path share one home.
 *
 * Save-zone routing (T5): the drop bar is a labelled landing surface, not a
 * split surface. External content enters the transfer station; internal
 * clipboard/station drags are contextual no-ops.
 */
import { useStore } from '../../store/appStore'
import { t } from '../../i18n'
import type { DragRequest } from '../../../shared/types'

/** Which save-zone context the current drag is in (T5). */
export type SaveZoneContext = 'external' | 'clipboard' | 'station'

/**
 * Classify the current drag for the save zone. Pure: the station id set is
 * passed in so the decision is testable without the store.
 */
export function saveZoneContext(
  isExternal: boolean,
  reqId: string | undefined,
  stationIds: string[]
): SaveZoneContext {
  if (isExternal) return 'external'
  if (reqId && stationIds.includes(reqId)) return 'station'
  return 'clipboard'
}

/** i18n keys for the contextual save-zone copy (T5). */
export function saveZoneCopy(ctx: SaveZoneContext): { title: string; hint?: string } {
  switch (ctx) {
    case 'external':
      return { title: 'tasks.saveZoneExternal', hint: 'tasks.saveZoneExternalHint' }
    case 'clipboard':
      return { title: 'tasks.saveZoneClipboard' }
    case 'station':
      return { title: 'tasks.saveZoneStation' }
  }
}

/**
 * Resolve a drop on the save zone. External file drops enter the station;
 * internal drags are no-ops (the item is already in the panel).
 */
export async function dropOnSaveZone(req: DragRequest | null, paths?: string[]): Promise<void> {
  if (req) return
  if (paths && paths.length > 0) {
    await useStore.getState().stationEnter(paths)
  }
}

/** Toast that a drop-to-task succeeded. */
function linkToast(): void {
  useStore.getState().pushToast({
    id: `link-${Date.now()}`,
    message: t('tasks.linkToast'),
    tone: 'info'
  })
}

/**
 * Link the item currently being dragged into the given task. File subitem
 * drags (req.paths) link just those paths; everything else links by item id
 * (main snapshots the content at link time).
 */
export async function linkDraggedItem(taskId: string, req: DragRequest): Promise<void> {
  if (req.paths && req.paths.length > 0) {
    await useStore.getState().linkFilesToTask(taskId, req.paths)
  } else if (req.id) {
    await useStore.getState().linkItemToTask(taskId, req.id)
  }
  linkToast()
}

/**
 * Drop the dragged item onto a suggestion card: main accepts the suggestion
 * (creates/merges the real task) and links the item in one step.
 */
export async function acceptSuggestionDrop(suggestionId: string, req: DragRequest): Promise<void> {
  await useStore.getState().acceptSuggestionWithResource(suggestionId, undefined, {
    kind: 'clipboard',
    itemId: req.id
  })
  useStore.getState().pushToast({
    id: `sug-${Date.now()}`,
    message: t('tasks.suggestionCreated'),
    tone: 'info'
  })
}
