/**
 * SwitcherView — the Alt+Tab switcher page (ADR-0005).
 *
 * Rendered in place of the whole panel page while a switcher session is
 * active. The keyboard side (highlight movement, execute-on-Alt-up) lives in
 * main; this view only renders the entries and mirrors selection changes.
 * Mouse: hovering highlights an entry (synced to main so Alt-up switches to
 * it), clicking executes the switch immediately.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/appStore'
import { edge } from '../lib/edge'
import type { SwitcherEntryDto } from '../../shared/types'

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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const listRef = useRef<HTMLDivElement>(null)

  // Resolve app icons in one batch (existing app:icons pipeline, cached main-side).
  useEffect(() => {
    const exePaths = Array.from(new Set(entries.map((e) => e.exePath).filter(Boolean)))
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
    setHoverIndex(selected)
  }, [selected])

  const displayIndex = useMemo(() => {
    if (hoverIndex !== null && hoverIndex < entries.length) return hoverIndex
    return selected
  }, [hoverIndex, selected, entries.length])

  // Keep the highlighted entry in view when the selection moves (Tab repeats
  // or hover can walk the list past the visible viewport).
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const row = list.querySelector('.switcher-row.selected') as HTMLElement | null
    if (!row) return
    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    if (rowTop < list.scrollTop) list.scrollTop = rowTop
    else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight
  }, [displayIndex, entries.length])

  const handleMouseEnter = (index: number) => {
    setHoverIndex(index)
    edge.switcherHover(index)
  }

  const handleMouseLeaveList = () => {
    setHoverIndex(null)
  }

  const handleClick = (index: number) => {
    edge.switcherClick(index)
  }

  return (
    <div
      className="switcher"
      onMouseLeave={handleMouseLeaveList}
    >
      <div className="switcher-list" ref={listRef}>
        {entries.map((entry: SwitcherEntryDto, i: number) => (
          <button
            key={i}
            className={`switcher-row${i === displayIndex ? ' selected' : ''}`}
            onMouseEnter={() => handleMouseEnter(i)}
            onClick={() => handleClick(i)}
            onFocus={() => handleMouseEnter(i)}
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
          </button>
        ))}
      </div>
    </div>
  )
}
