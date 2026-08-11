/**
 * TaskDropPanel — full-blade drop-binding surface (t25), shown for OS file
 * drags AND in-panel item drags, in both views.
 *
 * Top: fixed save zone (drop = save into the clipboard shelf, reusing the
 * existing split/onDrop logic). Below: one scroll column with every task as
 * a drop row (drop = link) and every suggestion card (drop = auto-create the
 * real task and bind). With no tasks and no suggestions it falls back to the
 * centered "Drop to save" hint.
 *
 * OS file drops never reach the DOM onDrop handlers with usable paths (File
 * objects die at the contextBridge) — preload forwards them as a
 * `trace-os-drop` event and Panel resolves the target. The handlers here
 * serve in-panel HTML5 text drags; OLE drags (image/files) never fire DOM
 * drop events either, so Panel's `item:internal-drop` resolution calls the
 * same shared actions in dropActions.ts.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import { DropIcon } from '../icons'
import { AppIcon } from './AppIcon'
import { SuggestionCard } from './SuggestionCard'
import { linkDraggedItem } from './dropActions'

/** Clear an internal drag on drop; split sub-items (the shelf-level drop semantics). */
function dropOnSaveZone(e: React.DragEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const req = useStore.getState().internalDragReq
  if (req) {
    useStore.getState().setInternalDragReq(null)
    if (req.imageId || (req.paths && req.paths.length > 0)) {
      void window.edge.splitItem(req)
    }
  }
}

export function TaskDropPanel() {
  const { t } = useTranslation()
  const dragActive = useStore((s) => s.dragActive)
  const internalDragReq = useStore((s) => s.internalDragReq)
  const tasks = useStore((s) => s.tasks)
  const suggestions = useStore((s) => s.suggestions)
  const [overZone, setOverZone] = useState(false)
  const [overTaskId, setOverTaskId] = useState<string | null>(null)

  const dragging = dragActive || internalDragReq !== null
  const hasTargets = tasks.length > 0 || suggestions.length > 0

  return (
    <AnimatePresence>
      {dragging && !hasTargets && (
        <motion.div
          key="fallback"
          className="task-drop-fallback"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="task-drop-fallback-icon">
            <DropIcon width={26} height={26} />
          </div>
          <div className="task-drop-fallback-title">Drop to save</div>
          <div className="task-drop-fallback-hint">Any file, image, link, or text</div>
        </motion.div>
      )}

      {dragging && hasTargets && (
        <motion.div
          key="bind"
          className="task-drop-panel"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div
            className={`drop-save-zone${overZone ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOverZone(true)
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return
              setOverZone(false)
            }}
            onDrop={dropOnSaveZone}
          >
            <span className="drop-save-zone-icon">
              <DropIcon width={18} height={18} />
            </span>
            <div className="drop-save-zone-text">
              <div className="drop-save-zone-title">{t('tasks.saveZone')}</div>
              <div className="drop-save-zone-hint">{t('tasks.saveZoneHint')}</div>
            </div>
          </div>

          <div className="task-drop-scroll">
            {tasks.map((task) => (
              <div
                key={task.id}
                className={`task-drop-row${overTaskId === task.id ? ' over' : ''}`}
                data-drop-task-id={task.id}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOverTaskId(task.id)
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return
                  setOverTaskId((cur) => (cur === task.id ? null : cur))
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setOverTaskId(null)
                  const req = useStore.getState().internalDragReq
                  if (req) {
                    useStore.getState().setInternalDragReq(null)
                    void linkDraggedItem(task.id, req)
                  }
                  // OS file drops were routed by preload (trace-os-drop).
                }}
              >
                <span className={`task-status-dot ${task.status}`} />
                <span className="task-drop-row-title">{task.title}</span>
                {task.apps[0] && <AppIcon app={task.apps[0]} size={16} />}
              </div>
            ))}
            {suggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
