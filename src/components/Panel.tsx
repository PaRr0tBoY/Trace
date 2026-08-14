/**
 * Panel — the blade that grows out of the left edge.
 *
 * Motion: when `open` flips true the blade's clip-path releases from the edge
 * strip (the "spoke") to the full panel while the scale animates up. Both are
 * compositor-friendly: scale is a transform (Framer-driven), clip-path is a
 * promoted compositor clip driven by the CSS transition in panel.css. No
 * filter/blur — repainting the whole blade every frame was the jank source.
 * When closed, the clip-path keeps only the spoke visible so the window stays
 * transparent and click-through.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/appStore'
import { PANEL_LEAVE_EVENT, PANEL_ENTER_EVENT } from '../hooks/useEdgeHover'
import { Header } from './Header'
import { ItemList } from './ItemList'
import { SearchBar } from './SearchBar'
import { Settings } from './Settings'
import { TaskView } from './tasks/TaskView'
import { SwitcherView } from './SwitcherView'
import { FileListView } from './FileListView'
import { TaskDropPanel } from './tasks/TaskDropPanel'
import { linkDraggedItem, acceptSuggestionDrop } from './tasks/dropActions'
import { ToastStack } from './Toast'
import { TrashIcon } from './icons'
import { t } from '../i18n'

/** True when the id names a transfer station entry (ADR-0006). */
const isStationId = (id: string): boolean => useStore.getState().station.some((e) => e.id === id)

export function Panel() {
  const open = useStore((s) => s.open)
const switcherActive = useStore((s) => s.switcherActive)
  const total = useStore((s) => s.items.length)
  const clear = useStore((s) => s.clear)
  const settings = useStore((s) => s.settings)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const view = useStore((s) => s.view)

  // NOTE: closing the panel intentionally keeps the settings sheet, its sub
  // view, and the search query — the restore mechanism (ADR-0004) decides
  // whether they survive the re-open based on the restore time.

  const topOffset = '50%'

  // The actual pixel height of the trigger zone on the left edge
  const triggerHeightPx = window.innerHeight * settings.hotZoneHeight
  const halfTrigger = triggerHeightPx / 2

  // The height of the complete pop-up panel
  const panelHeightStr = `${(settings.panelHeight || 0.6) * 100}vh`

  const setDragActive = useStore((s) => s.setDragActive)
  const setInternalDragReq = useStore((s) => s.setInternalDragReq)
  const internalDragReq = useStore((s) => s.internalDragReq)

  const bladeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const blade = bladeRef.current
    if (!blade) return

    const handleLeave = () => window.dispatchEvent(new Event(PANEL_LEAVE_EVENT))
    const handleEnter = () => window.dispatchEvent(new Event(PANEL_ENTER_EVENT))

    blade.addEventListener('mouseleave', handleLeave)
    blade.addEventListener('mouseenter', handleEnter)
    return () => {
      blade.removeEventListener('mouseleave', handleLeave)
      blade.removeEventListener('mouseenter', handleEnter)
    }
  }, [])

  useEffect(() => {
    const unsubDragEnd = window.edge.onDragEnd(() => {
      // Delay clearing to allow React's drop event to process first if they coincide
      setTimeout(() => {
        setInternalDragReq(null)
        setDragActive(false)
      }, 150)
    })

    const unsubInternalDrop = window.edge.onInternalDrop((pos) => {
      // The OS drag ended inside our window, but Electron/Windows swallowed the drop event.
      if (!internalDragReq) return

      const req = { ...internalDragReq }
      setInternalDragReq(null)
      setDragActive(false)

      const splitSubitem = (): void => {
        if (req.imageId || (req.paths && req.paths.length > 0)) {
          if (isStationId(req.id)) {
            window.edge.stationSplit(req)
          } else {
            window.edge.splitItem(req)
          }
        }
      }

      const el = document.elementFromPoint(pos.x, pos.y)
      if (!el) {
        splitSubitem()
        return
      }

      // Drop-binding panel targets (t25).
      const taskRow = el.closest('[data-drop-task-id]')
      if (taskRow) {
        const taskId = taskRow.getAttribute('data-drop-task-id')
        if (taskId) void linkDraggedItem(taskId, req)
        return
      }

      const sugCard = el.closest('[data-drop-suggestion-id]')
      if (sugCard) {
        const sugId = sugCard.getAttribute('data-drop-suggestion-id')
        if (sugId) void acceptSuggestionDrop(sugId, req)
        return
      }

      // Save zone = shelf-level drop: split sub-items out.
      if (el.closest('.drop-save-zone, .split-dropzone')) {
        splitSubitem()
        return
      }

      // Task-layer drop targets: dropping a task resource back onto the task
      // layer is a no-op (no merge/split semantics apply).
      if (el.closest('.task-view, .task-card, .task-detail, .task-list, .task-editor')) {
        return
      }

      const itemEl = el.closest('.item-main')
      if (itemEl) {
        const targetId = itemEl.getAttribute('data-id')
        if (targetId && targetId !== req.id) {
          // Dropped on a DIFFERENT item: merge (station entries merge inside
          // the station domain, ADR-0006).
          if (isStationId(req.id)) {
            window.edge.stationMerge(req.id, targetId)
          } else {
            window.edge.mergeItems(req.id, targetId)
          }
        } else if (targetId === req.id) {
          // Dropped on the SAME item: do nothing, keep it in the collection
        }
      } else {
        // Dropped on empty space (e.g. padding): split
        splitSubitem()
      }
    })

    /**
     * OS file drops: preload resolved the paths (File objects die at the
     * bridge) and forwards them here with the drop coordinates. Pick the
     * target the same way internal drops do, then act per target.
     */
    window.addEventListener('trace-os-drop', handleOsFileDrop)

    return () => {
      unsubDragEnd()
      unsubInternalDrop()
      window.removeEventListener('trace-os-drop', handleOsFileDrop)
    }
  }, [internalDragReq, setInternalDragReq, setDragActive])

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')

  /**
   * Route an OS file drop by its coordinates: task row -> link files,
   * suggestion card -> accept + bind, anywhere else -> save into the shelf.
   */
  const handleOsFileDrop = (e: Event): void => {
    const detail = (e as CustomEvent<{ paths: string[]; x: number; y: number }>).detail
    if (!detail || detail.paths.length === 0) return
    // Claim the drop so preload skips its save-to-shelf fallback (onboarding
    // window has no Panel listener and must not lose the files).
    document.documentElement.setAttribute('data-trace-drop-claimed', '')

    const el = document.elementFromPoint(detail.x, detail.y)
    const taskRow = el?.closest('[data-drop-task-id]')
    if (taskRow) {
      const taskId = taskRow.getAttribute('data-drop-task-id')
      if (taskId) void window.edge.linkFilesToTask(taskId, detail.paths)
      return
    }

    const sugCard = el?.closest('[data-drop-suggestion-id]')
    if (sugCard) {
      const sugId = sugCard.getAttribute('data-drop-suggestion-id')
      if (sugId) {
        void useStore
          .getState()
          .acceptSuggestionWithResource(sugId, undefined, { kind: 'files', paths: detail.paths })
          .then(() => {
            useStore.getState().pushToast({
              id: `sug-${Date.now()}`,
              message: t('tasks.suggestionCreated'),
              tone: 'info'
            })
          })
      }
      return
    }

    void useStore.getState().stationEnter(detail.paths)
  }

  const onDragEnter = (e: React.DragEvent) => {
    if (hasFiles(e)) {
      e.preventDefault()
      setDragActive(true)
    }
  }

  const onDragOver = (e: React.DragEvent) => {
    if (hasFiles(e)) e.preventDefault()
  }

  const onDragLeave = (e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null
    if (related && e.currentTarget.contains(related)) return
    setDragActive(false)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    console.log('[Panel] onDrop internalDragReq=', internalDragReq)
    if (internalDragReq) {
      e.preventDefault()
      // If it reaches here, it means it was dropped on the general panel background
      // (not on another item, which would have called stopPropagation).
      // Check if it's a subitem that should be split out:
      if (internalDragReq.imageId || (internalDragReq.paths && internalDragReq.paths.length > 0)) {
        if (isStationId(internalDragReq.id)) {
          console.log('[Panel] calling stationSplit')
          window.edge.stationSplit(internalDragReq)
        } else {
          console.log('[Panel] calling splitItem')
          window.edge.splitItem(internalDragReq)
        }
      } else {
        console.log('[Panel] internalDragReq has no subitem, not splitting')
      }
      setInternalDragReq(null)
    } else if (hasFiles(e)) {
      e.preventDefault()
    }
    setDragActive(false)
  }

  return (
    <div className="root">
      <motion.div
        className={`blade-container${open ? '' : ' closing'}${settings.stickPosition === 'right' ? ' blade-right' : ''}${switcherActive ? ' switcher-session' : ''}`}
        initial={false}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          top: topOffset,
          y: '-50%',
          position: 'absolute',
          left: settings.stickPosition === 'right' ? 'auto' : 0,
          right: settings.stickPosition === 'right' ? 0 : 'auto',
          zIndex: 10,
          pointerEvents: open ? 'auto' : 'none',
          originX: settings.stickPosition === 'right' ? 1 : 0,
          originY: 0.5
        }}
        animate={{
          // Mirror the clip for the right edge: the blade hugs the window's
          // right edge and the collapsed hot-zone strip stays on that side.
          clipPath: open
            ? settings.stickPosition === 'right'
              ? 'inset(calc(0% - 100px) 0px calc(0% - 100px) calc(0% - 100px) round 24px 0px 0px 24px)'
              : 'inset(calc(0% - 100px) calc(0% - 100px) calc(0% - 100px) 0px round 0px 24px 24px 0px)'
            : settings.stickPosition === 'right'
              ? `inset(calc(50% - ${halfTrigger}px) 0px calc(50% - ${halfTrigger}px) calc(100% - ${settings.hotZoneWidth || 3}px) round 24px 0px 0px 24px)`
              : `inset(calc(50% - ${halfTrigger}px) calc(100% - ${settings.hotZoneWidth || 3}px) calc(50% - ${halfTrigger}px) 0px round 0px 24px 24px 0px)`,
          scale: open ? 1 : 0.92
        }}
        transition={{
          scale: {
            // Scale keeps the original ratio to clip-path (~0.76x: it finished
            // ahead of the clip in the initial 0.46/0.35 pairing). Opening 0.2s
            // fast-then-slow, closing 0.08s linear, both ahead of the clip.
            // Switcher sessions (ADR-0005) run ~2x faster — snappier feel.
            duration: switcherActive ? (open ? 0.1 : 0.06) : open ? 0.2 : 0.08,
            ease: switcherActive ? (open ? [0.22, 1, 0.36, 1] : [0, 0, 1, 1]) : open ? [0.22, 1, 0.36, 1] : [0, 0, 1, 1]
          }
        }}
      >
        <div className={`flare-top${settings.stickPosition === 'right' ? ' flare-right' : ''}`}>
          <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M 0 0 L 0 30 L 30 30 A 30 30 0 0 1 0 0 Z" fill="#000000" />
          </svg>
        </div>
        <div className={`flare-bottom${settings.stickPosition === 'right' ? ' flare-right' : ''}`}>
          <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M 0 30 L 0 0 L 30 0 A 30 30 0 0 0 0 30 Z" fill="#000000" />
          </svg>
        </div>
        <div
          ref={bladeRef}
          className="blade"
          style={{ height: panelHeightStr }}
        >
          {switcherActive ? (
            <SwitcherView />
          ) : (
            <>
          <Header />

          {!settingsOpen && view !== 'tasks' && <SearchBar />}

          <ToastStack />
          <AnimatePresence mode="wait">
            {settingsOpen ? (
              <motion.div
                key="settings"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to bottom, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                <Settings />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to top, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
              </motion.div>
            ) : view === 'tasks' ? (
              <motion.div
                key="tasks"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                transition={{ duration: 0.15 }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to bottom, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                <TaskView />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to top, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
              </motion.div>
            ) : view === 'files' ? (
              <motion.div
                key="files"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                transition={{ duration: 0.15 }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to bottom, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                <FileListView />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to top, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
              </motion.div>
            ) : (
              <motion.div
                key="list"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                transition={{ duration: 0.15 }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to bottom, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to bottom, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                <ItemList />
                <div className="footer" style={{ position: 'relative' }}>
                  <div style={{ position: 'absolute', top: -18, left: 0, right: 0, height: 18, background: 'linear-gradient(to top, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                  <span className="count">
                    {total} item{total === 1 ? '' : 's'}
                  </span>
                  <div className="spacer" />
                  <button 
                    className="text-btn danger"
                    onClick={() => clear()} 
                    disabled={total === 0} 
                    title="Clear shelf" 
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <TrashIcon width={14} height={14} />
                    <span>Clear</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <TaskDropPanel />
          <SplitDropZone />
            </>
          )}
        </div>
      </motion.div>
    </div>
  )
}

/*
function getTutorialText(step: number): string {
  switch (step) {
    case 1:
      return 'Click the trash icon on the pinned card below to delete it.'
    case 2:
      return 'Copy any text or image (Ctrl + C) from another application to capture it.'
    case 3:
      return 'Drag the image card below and drop it onto your desktop.'
    case 4:
      return 'Click the files card below to expand the stack and view its contents.'
    case 5:
      return 'Click the Clear button at the bottom of the panel to finish.'
    default:
      return ''
  }
}
*/

function SplitDropZone() {
  const internalDragReq = useStore((s) => s.internalDragReq)
  const isSubitemDragging = !!(
    internalDragReq &&
    (internalDragReq.imageId || (internalDragReq.paths && internalDragReq.paths.length > 0))
  )

  const [isOver, setIsOver] = useState(false)

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    setIsOver(true)
  }

  const handleDragLeave = () => {
    setIsOver(false)
  }

  return (
    <AnimatePresence>
      {isSubitemDragging && (
        <motion.div
          className={`split-dropzone${isOver ? ' active' : ''}`}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          initial={{ opacity: 0, x: -15 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -15 }}
          transition={{ type: 'spring', stiffness: 350, damping: 25 }}
          style={{ y: '-50%' }}
        >
          <div className="glow-line" />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
