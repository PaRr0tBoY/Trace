/**
 * Panel — the blade that grows out of the left edge.
 *
 * Motion: when `open` flips true the blade's clip-path releases from the edge
 * strip (the "spoke") to the full panel — the reveal, driven by the CSS
 * transition in panel.css. Under the 'extended' motion level the background
 * layer (.blade-bg) also overshoots ~2% past the rest edge and settles back
 * (useOpenBounce) — a Dynamic-Island-style poke that moves only the black
 * shape; content in .blade stays put. 'standard' keeps the plain reveal
 * (scale pinned at 1). All compositor-friendly: scale is a transform
 * (Framer-driven), clip-path is a promoted compositor clip. No filter/blur —
 * repainting the whole blade every frame was the jank source. Unlike the
 * flyout presets, this motion is intentionally not gated on
 * prefers-reduced-motion (see useOpenBounce) — the reveal always animates
 * and the OS "animations off" setting was silently killing it.
 * When closed, the clip-path keeps only the spoke visible so the window stays
 * transparent and click-through.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/appStore'
import { useOpenBounce } from '../hooks/useAdaptiveSpring'
import { PANEL_LEAVE_EVENT, PANEL_ENTER_EVENT } from '../hooks/useEdgeHover'
import { useFilteredItems, matchesClipboardFilter } from '../hooks/useFilteredItems'
import { Header } from './Header'
import { ItemList } from './ItemList'
import { SearchBar } from './SearchBar'
import { Settings } from './Settings'
import { TaskView } from './tasks/TaskView'
import { SwitcherView } from './SwitcherView'
import { FileListView } from './FileListView'
import { TaskDropPanel } from './tasks/TaskDropPanel'
import { linkDraggedItem, acceptSuggestionDrop, dropOnSaveZone } from './tasks/dropActions'
import { ToastStack } from './Toast'
import { ViewFooter, type ViewFooterState } from './ViewFooter'
import { t } from '../i18n'

export function Panel() {
  const open = useStore((s) => s.open)
  const switcherActive = useStore((s) => s.switcherActive)
  // Files/tasks views report their footer data up here (the bar lives
  // outside the view-transition animation); clipboard is derived locally.
  const [reportedFooter, setReportedFooter] = useState<ViewFooterState | null>(null)
  const clear = useStore((s) => s.clear)

  const settings = useStore((s) => s.settings)
  const isRight = settings.stickPosition === 'right'
  const settingsOpen = useStore((s) => s.settingsOpen)
  const view = useStore((s) => s.view)

  // Clipboard-view footer: count + clear are scoped to the active type
  // filter (user feedback 2026-08-14: clear only the current view, e.g.
  // the image filter clears images only). The count shows what the user
  // sees (query-filtered); clear removes every unpinned item matching the
  // type filter regardless of the search query.
  const { pinned: visiblePinned, recent: visibleRecent } = useFilteredItems()
  const visibleTotal = visiblePinned.length + visibleRecent.length
  const clipboardFilter = useStore((s) => s.clipboardFilter)
  const clearScopedClipboard = (): void => {
    const state = useStore.getState()
    const filter = state.clipboardFilter || 'all'
    const ids = state.items.filter((it) => !it.pinned && matchesClipboardFilter(it, filter)).map((it) => it.id)
    if (ids.length > 0) void clear(ids)
  }
  const clipboardScopeCount = useStore((s) => s.items).filter(
    (it) => !it.pinned && matchesClipboardFilter(it, clipboardFilter || 'all')
  ).length

  // Blade open motion — under 'extended' a Dynamic-Island-style
  // exceed-and-settle timed to the clip reveal's end; 'standard' stays flat.
  const openBounce = useOpenBounce()
  const extended = settings.motionLevel === 'extended'
  // View/settings transitions: 'extended' slides with direction (x ±10);
  // 'standard' cross-fades — the slide is directional delight, not navigation.
  const viewSlide = extended ? 10 : 0
  const viewSlideOut = extended ? -10 : 0

  // NOTE: closing the panel intentionally keeps the settings sheet, its sub
  // view, and the search query — the restore mechanism (ADR-0004) decides
  // whether they survive the re-open based on the restore time.

  const topOffset = '50%'

  // The actual pixel height of the trigger zone on the left edge
  const triggerHeightPx = window.innerHeight * settings.hotZoneHeight
  const halfTrigger = triggerHeightPx / 2
  // The edge-hint beacon hugs the same trigger band as the clip path.
  const insetTop = `calc(50% - ${halfTrigger}px)`
  const insetBottom = `calc(50% - ${halfTrigger}px)`
  const edgeHintActive = useStore((s) => s.edgeHintActive)

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

      const el = document.elementFromPoint(pos.x, pos.y)
      if (!el) return

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

      // Save zone (T5): a labelled landing surface. Internal drags are
      // no-ops (the item already lives in the panel), external content is
      // routed here by handleOsFileDrop.
      if (el.closest('.drop-save-zone')) {
        void dropOnSaveZone(req)
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
          // Drop-on-another-item merging was removed with the grouping
          // feature (user feedback 2026-08-14) — entries stay standalone.
        } else if (targetId === req.id) {
          // Dropped on the SAME item: do nothing, keep it in the collection
        }
      }
      // Dropped on empty space: no-op.
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

  const hasDragContent = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer?.types || [])
    return (
      types.includes('Files') ||
      types.includes('text/uri-list') ||
      types.includes('text/plain') ||
      types.includes('text/html') ||
      types.includes('URL')
    )
  }

  /**
   * Route an OS file drop by its coordinates: task row -> link files,
   * suggestion card -> accept + bind, anywhere else -> station entry.
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

    void dropOnSaveZone(null, detail.paths)
  }

  const onDragEnter = (e: React.DragEvent) => {
    if (hasDragContent(e)) {
      e.preventDefault()
      setDragActive(true)
    }
  }

  const onDragOver = (e: React.DragEvent) => {
    if (hasDragContent(e)) {
      e.preventDefault()
    }
  }

  const onDragLeave = (e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null
    if (related && e.currentTarget.contains(related)) return
    // Deliberately no setDragActive(false) here: DOM drag events on an OLE
    // drag are unreliable (enter without leave happens), and dragActive's
    // authority is the main-process drag:active push — a premature clear
    // releases the close-guards mid-drag and the panel collapses while the
    // user is still dragging (user feedback 2026-08-14).
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (internalDragReq) {
      // Dropped on the general panel background: no-op. Batch-member split
      // lives on the card button only (T5).
      setInternalDragReq(null)
    }
    // No setDragActive(false) here either — an OS drop is settled by the
    // main drag:active push once DoDragDrop returns; internal drops are
    // settled by setInternalDragReq(null) above.
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
          pointerEvents: open ? 'auto' : 'none'
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
              : `inset(calc(50% - ${halfTrigger}px) calc(100% - ${settings.hotZoneWidth || 3}px) calc(50% - ${halfTrigger}px) 0px round 0px 24px 24px 0px)`
        }}
      >
        {/* The black shape. The open bounce (extended level only, useOpenBounce)
            lives here — content in .blade below never scales, so only the
            background pokes past and settles back. */}
        <motion.div
          className="blade-bg"
          style={{
            originX: settings.stickPosition === 'right' ? 1 : 0,
            originY: 0.5
          }}
          animate={{
            scale: switcherActive ? 1 : open && extended ? [1, 1.02, 1] : 1
          }}
          transition={{
            scale: switcherActive
              ? { duration: open ? 0.1 : 0.06, ease: open ? [0.22, 1, 0.36, 1] : [0, 0, 1, 1] }
              : open
                ? extended
                  ? openBounce
                  : { duration: 0, ease: [0, 0, 1, 1] }
                : { duration: 0.08, ease: [0, 0, 1, 1] }
          }}
        />
        {/* Edge Location Hint Beacon (Ultra-subtle fast hairline pulse when touching edge at wrong position) */}
        <AnimatePresence>
          {!open && edgeHintActive && (settings.showEdgeLocationHint ?? false) && (
            <motion.div
              key="edge-location-beacon"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              style={{
                position: 'absolute',
                top: insetTop,
                bottom: insetBottom,
                [isRight ? 'right' : 'left']: 0,
                width: 2,
                boxSizing: 'border-box',
                background: 'linear-gradient(to bottom, transparent, rgba(255, 255, 255, 0.65) 25%, rgba(255, 255, 255, 0.65) 75%, transparent)',
                boxShadow: '0 0 6px rgba(255, 255, 255, 0.3)',
                borderRadius: isRight ? '999px 0 0 999px' : '0 999px 999px 0',
                pointerEvents: 'none',
                zIndex: 99
              }}
            />
          )}
        </AnimatePresence>
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
          <AnimatePresence initial={false}>
            {switcherActive ? (
              <motion.div
                key="switcher"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
              >
                <SwitcherView />
              </motion.div>
            ) : (
              <motion.div
                key="main"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.1 }}
                style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
              >
          <Header />

          {!settingsOpen && view !== 'tasks' && <SearchBar />}

          <ToastStack />
          <AnimatePresence initial={false}>
            {settingsOpen ? (
              <motion.div
                key="settings"
                initial={{ opacity: 0, x: viewSlide }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: viewSlideOut, transition: { duration: 0.25 } }}
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
                initial={{ opacity: 0, x: viewSlide }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: viewSlideOut, transition: { duration: 0.25 } }}
                transition={{ duration: 0.15 }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to bottom, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                <TaskView onFooterChange={setReportedFooter} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to top, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
              </motion.div>
            ) : view === 'files' ? (
              <motion.div
                key="files"
                initial={{ opacity: 0, x: viewSlide }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: viewSlideOut, transition: { duration: 0.25 } }}
                transition={{ duration: 0.15 }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to bottom, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                <FileListView onFooterChange={setReportedFooter} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to top, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
              </motion.div>
            ) : (
              <motion.div
                key="list"
                initial={{ opacity: 0, x: viewSlide }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: viewSlideOut, transition: { duration: 0.25 } }}
                transition={{ duration: 0.15 }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, background: 'linear-gradient(to bottom, #000000, transparent)', pointerEvents: 'none', zIndex: 10 }} />
                <ItemList />
              </motion.div>
            )}
          </AnimatePresence>
          {/* One toolbar for every content view, fixed below the animated
              content area (user feedback 2026-08-14). Settings and switcher
              sessions have no footer. */}
          {!settingsOpen && !switcherActive && (
            view === 'clipboard' ? (
              <ViewFooter
                count={visibleTotal}
                noun="item"
                clearLabel={t('item.clear')}
                clearTitle={t('item.clearScoped')}
                clearDisabled={clipboardScopeCount === 0}
                onClear={clearScopedClipboard}
              />
            ) : reportedFooter ? (
              <ViewFooter {...reportedFooter} />
            ) : null
          )}
          <TaskDropPanel />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}
