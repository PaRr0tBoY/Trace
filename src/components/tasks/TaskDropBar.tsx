/**
 * TaskDropBar — in-panel drop targets shown while a clipboard item is being
 * dragged (clipboard view only). Drop the item on a chip to link it into that
 * task; the link itself snapshots the item (main-side).
 *
 * Both drag kinds resolve here:
 *   - OLE drags (image/files) never fire DOM drag events — main probes the
 *     drop position after the native drag ends (`item:internal-drop`) and
 *     Panel resolves the chip via elementFromPoint, calling linkDraggedItem.
 *   - HTML5 drags (text) deliver dragover/drop straight to the chips.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../../store/appStore'
import { t } from '../../i18n'
import { DropIcon } from '../icons'
import type { DragRequest } from '../../../shared/types'

const MAX_CHIPS = 4

/** Link the item currently being dragged into the given task. Shared by the
 * chip drop handlers and Panel's internal-drop resolution. */
export async function linkDraggedItem(taskId: string, req: DragRequest): Promise<void> {
  await useStore.getState().linkItemToTask(taskId, req.id)
  useStore.getState().pushToast({
    id: `link-${Date.now()}`,
    message: t('tasks.linkToast'),
    tone: 'info'
  })
}

export function TaskDropBar() {
  const view = useStore((s) => s.view)
  const internalDragReq = useStore((s) => s.internalDragReq)
  const tasks = useStore((s) => s.tasks)
  const [overId, setOverId] = useState<string | null>(null)

  const visible = view === 'clipboard' && internalDragReq !== null && tasks.length > 0
  const chips = tasks.slice(0, MAX_CHIPS)

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="task-drop-bar"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="task-drop-label">
            <DropIcon width={12} height={12} />
            <span>{t('tasks.dropBarHint')}</span>
          </div>
          <div className="task-drop-chips">
            {chips.map((task) => (
              <div
                key={task.id}
                className={`task-drop-chip ${task.status}${overId === task.id ? ' over' : ''}`}
                data-task-id={task.id}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOverId(task.id)
                }}
                onDragLeave={() => setOverId((cur) => (cur === task.id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setOverId(null)
                  const req = useStore.getState().internalDragReq
                  if (req) {
                    useStore.getState().setInternalDragReq(null)
                    void linkDraggedItem(task.id, req)
                  }
                }}
              >
                <span className={`task-drop-dot ${task.status}`} />
                <span className="task-drop-title">{task.title}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
