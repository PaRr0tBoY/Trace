/**
 * Drop-to-bind actions shared by every drop surface (t25): the binding panel's
 * task rows / suggestion cards and Panel's internal-drop resolution (OLE
 * drags never fire DOM drop events, so main probes the drop position and
 * Panel calls these directly).
 *
 * `linkDraggedItem` lives here instead of TaskDropBar (deleted) so the
 * clipboard-item link path and the file-path link path share one home.
 */
import { useStore } from '../../store/appStore'
import { t } from '../../i18n'
import type { DragRequest } from '../../../shared/types'

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
