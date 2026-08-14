/**
 * TaskDropPanel — full-blade drop-binding surface (t25), shown for OS file
 * drags AND in-panel item drags, in both views.
 *
 * The task rows (drop = link) and suggestion cards (drop = auto-create and
 * bind) scroll above; the save zone fills the remaining height at the bottom
 * (T5) as the labelled landing surface. Its copy is contextual: external
 * content enters the transfer station, internal clipboard/station drags are
 * no-ops that stay where they are.
 *
 * OS file drops never reach the DOM onDrop handlers with usable paths (File
 * objects die at the contextBridge) — preload forwards them as a
 * `trace-os-drop` event and Panel resolves the target. Native drags (every
 * item kind, via Electron's startDrag) never fire DOM drop events either,
 * so Panel's `item:internal-drop` resolution calls the same shared actions
 * in dropActions.ts.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import { DropIcon } from '../icons'
import { AppIcon } from './AppIcon'
import { TaskProposalCard } from './TaskProposalCard'
import { dropOnSaveZone, linkDraggedItem, saveZoneContext, saveZoneCopy } from './dropActions'

export function TaskDropPanel() {
  const { t } = useTranslation()
  const dragActive = useStore((s) => s.dragActive)
  const internalDragReq = useStore((s) => s.internalDragReq)
  const tasks = useStore((s) => s.tasks)
  const suggestions = useStore((s) => s.suggestions)
  const station = useStore((s) => s.station)
  const [overZone, setOverZone] = useState(false)
  const [overTaskId, setOverTaskId] = useState<string | null>(null)

  const dragging = dragActive || internalDragReq !== null
  const isExternal = internalDragReq === null
  const copy = saveZoneCopy(saveZoneContext(isExternal, internalDragReq?.id, station.map((e) => e.id)))

  const handleSaveZoneDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setOverZone(false)
    const req = useStore.getState().internalDragReq
    if (req) useStore.getState().setInternalDragReq(null)
    void dropOnSaveZone(req)
  }

  return (
    <AnimatePresence>
      {dragging && (
        <motion.div
          key="bind"
          className="task-drop-panel"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
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
              <TaskProposalCard key={s.id} suggestion={s} />
            ))}
          </div>

          <div
            className={`drop-save-zone${overZone ? ' over' : ''}${isExternal ? '' : ' noop'}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOverZone(true)
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return
              setOverZone(false)
            }}
            onDrop={handleSaveZoneDrop}
          >
            <span className="drop-save-zone-icon">
              <DropIcon width={24} height={24} />
            </span>
            <div className="drop-save-zone-text">
              <div className="drop-save-zone-title">{t(copy.title)}</div>
              {copy.hint && <div className="drop-save-zone-hint">{t(copy.hint)}</div>}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
