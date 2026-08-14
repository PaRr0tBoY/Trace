/**
 * SwitcherView — the Alt+Tab switcher page (ADR-0005, TabTab rework).
 *
 * Rendered in place of the whole panel page while a switcher session is
 * active. Keyboard highlight movement and execute-on-Alt-up live in main;
 * this view renders entries, mirrors selection, and resolves the search
 * mode. Enter while armed pins the session (switcher:pin): the search
 * field autofocuses, Arrow keys move the highlight through the filtered
 * list (synced to main via entry.index), Enter switches, Esc cancels.
 *
 * Grouped rows (setting switcherGroupWindows) carry a window-count badge
 * and drill into the app's window list on click — that sub-list is purely
 * local renderer state; executing a sub-window still goes through main.
 *
 * Entry indices in DTOs stay in the ungrouped z-order space, so hover and
 * click always report entry.index to main.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '../store/appStore'
import { edge } from '../lib/edge'
import type { SwitcherEntryDto } from '../../shared/types'

/** Fast slide-in, pure fade-out — TabTab's motion language. */
const ROW_MOTION = {
  initial: { opacity: 0, x: 28, y: 0 },
  animate: { opacity: 1, x: 0, y: 0 },
  transition: { duration: 0.16, ease: [0.16, 1, 0.3, 1] as const }
}



function appNameOf(entry: SwitcherEntryDto): string {
  // UWP app hosts carry the real app title on the window ("Settings",
  // "Realtek Audio Console"…) — show that instead of the host exe name.
  if (/ApplicationFrameHost\.exe$/i.test(entry.exePath)) return entry.title
  const base = entry.exePath.split(/[\\/]/).pop() ?? entry.exePath
  return base.replace(/\.exe$/i, '')
}

export function SwitcherView() {
  const entries = useStore((s) => s.switcherEntries)
  const selected = useStore((s) => s.switcherSelected)
  const pinned = useStore((s) => s.switcherPinned)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [drill, setDrill] = useState<SwitcherEntryDto | null>(null)
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Focus the search field once the panel window is truly active. main's
  // switcherPin calls requestPanelFocus + activateHwnd, but activation is
  // async and Chromium silently drops element.focus() in an inactive
  // document (no focusin fires, so the t21 focusin->activate chain never
  // starts). autoFocus lands too early, so keep re-arming the bridge and
  // retrying until the field actually owns focus — no try cap: activation
  // now happens on Alt-up (after pin), which can be later than any fixed
  // retry window.
  useEffect(() => {
    if (!pinned) return
    edge.requestInputFocus()
    const t = setInterval(() => {
      if (document.activeElement === searchRef.current) {
        clearInterval(t)
        return
      }
      edge.requestInputFocus()
      searchRef.current?.focus()
    }, 40)
    return () => clearInterval(t)
  }, [pinned])

  // Type-to-search: the first character arrives with the pin message
  // (main swallowed the key — the panel wasn't focused yet) and seeds the
  // query here.
  const seedQuery = useStore((s) => s.switcherSeedQuery)
  useEffect(() => {
    if (pinned && seedQuery) setQuery(seedQuery)
  }, [pinned, seedQuery])

  // Resolve app icons in one batch (existing app:icons pipeline, cached main-side).
  // Grouped rows carry their sub-windows — those exePaths need icons too.
  useEffect(() => {
    const exePaths = Array.from(
      new Set(
        entries.flatMap((e) => [e.exePath, ...(e.windows ?? []).map((w) => w.exePath)]).filter(Boolean)
      )
    )
    if (exePaths.length === 0) return
    let alive = true
    edge.getAppIcons(exePaths).then((map) => {
      if (alive) setIcons(map ?? {})
    })
    return () => {
      alive = false
    }
  }, [entries])

  // Keep the local hover state in sync when keyboard moves the highlight.
  useEffect(() => {
    setHoverIndex(null)
  }, [selected])

  // Search filters against window title and app name.
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) => e.title.toLowerCase().includes(q) || appNameOf(e).toLowerCase().includes(q)
    )
  }, [entries, query])

  // Where the main-side selection (rows index) sits inside the filtered list.
  const selInVisible = useMemo(() => {
    const selEntry = entries[selected]
    if (!selEntry) return null
    const found = visibleRows.findIndex((e) => e.index === selEntry.index)
    return found === -1 ? null : found
  }, [entries, selected, visibleRows])

  const displayIndex = hoverIndex ?? selInVisible

  // Keep the highlighted row in view when the selection moves.
  useEffect(() => {
    const list = listRef.current
    if (!list || displayIndex === null) return
    const row = list.querySelector('.switcher-row.selected') as HTMLElement | null
    if (!row) return
    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    if (rowTop < list.scrollTop) list.scrollTop = rowTop
    else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight
  }, [displayIndex, entries.length])

  const syncHover = (rowIndex: number) => {
    const entry = visibleRows[rowIndex]
    if (!entry) return
    setHoverIndex(rowIndex)
    edge.switcherHover(entry.index)
  }

  const handleMouseLeaveList = () => {
    setHoverIndex(null)
  }

  const executeRow = (rowIndex: number) => {
    const entry = visibleRows[rowIndex]
    if (!entry) return
    edge.switcherClick(entry.index)
  }

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (displayIndex === null) return
      const entry = visibleRows[displayIndex]
      if (!entry) return
      // Enter mirrors a mouse click: grouped rows drill into their window
      // list (the user picks one specific window), single rows switch.
      if (entry.groupCount) setDrill(entry)
      else executeRow(displayIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      edge.switcherCancel()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (visibleRows.length === 0) return
      const next = displayIndex === null ? 0 : Math.min(displayIndex + 1, visibleRows.length - 1)
      syncHover(next)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (visibleRows.length === 0) return
      const next = displayIndex === null ? visibleRows.length - 1 : Math.max(displayIndex - 1, 0)
      syncHover(next)
    }
  }

  return (
    <div className="switcher" onMouseLeave={handleMouseLeaveList}>
      {(pinned || drill) && (
        <motion.div
          className="switcher-search"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        >
          {pinned && !drill && (
            <input
              ref={searchRef}
              autoFocus
              type="text"
              placeholder="Search windows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              spellCheck={false}
            />
          )}
          {drill && (
            <button
              className="switcher-back"
              onClick={() => {
                setDrill(null)
                setHoverIndex(null)
              }}
            >
              ← Back
            </button>
          )}
        </motion.div>
      )}
      <div className="switcher-list" ref={listRef}>
        {drill ? (
          drill.windows?.map((win: SwitcherEntryDto, i: number) => (
            <motion.button
              key={win.index}
              className={`switcher-row switcher-subrow${win.index === selected ? ' selected' : ''}`}
              initial={ROW_MOTION.initial}
              animate={ROW_MOTION.animate}
              transition={{ ...ROW_MOTION.transition, delay: i * 0.02 }}
              onMouseEnter={() => edge.switcherHover(win.index)}
              onClick={() => edge.switcherClick(win.index)}
              tabIndex={-1}
            >
              <span className="switcher-icon">
                {icons[win.exePath] ? (
                  <img src={icons[win.exePath]!} alt="" draggable={false} />
                ) : (
                  <span className="switcher-icon-placeholder" />
                )}
              </span>
              <span className="switcher-text">
                <span className="switcher-app">{appNameOf(win)}</span>
                <span className="switcher-title">{win.title}</span>
              </span>
            </motion.button>
          ))
        ) : (
          visibleRows.map((entry: SwitcherEntryDto, i: number) => (
            <motion.button
              key={entry.index}
              className={`switcher-row${i === displayIndex ? ' selected' : ''}`}
              initial={ROW_MOTION.initial}
              animate={ROW_MOTION.animate}
              transition={{ ...ROW_MOTION.transition, delay: i * 0.02 }}
              onMouseEnter={() => syncHover(i)}
              onClick={() => (entry.groupCount ? setDrill(entry) : executeRow(i))}
              onFocus={() => syncHover(i)}
              tabIndex={-1}
            >
              <span className="switcher-icon">
                {icons[entry.exePath] ? (
                  <img src={icons[entry.exePath]!} alt="" draggable={false} />
                ) : (
                  <span className="switcher-icon-placeholder" />
                )}
              </span>
              <span className="switcher-text">
                <span className="switcher-app">{appNameOf(entry)}</span>
                <span className="switcher-title">{entry.title}</span>
              </span>
              {entry.groupCount !== undefined && (
                <span className="switcher-badge">{entry.groupCount}</span>
              )}
            </motion.button>
          ))
        )}
        {visibleRows.length === 0 && !drill && (
          <div className="switcher-empty">No matches</div>
        )}
      </div>
    </div>
  )
}
