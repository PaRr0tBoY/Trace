/**
 * PinnedTile — one transfer station entry in the pinned badge grid (T6).
 *
 * Compact 4-per-row launch tiles for pinned station entries: file-type icon
 * + name, a bundle counter, and minimal status dots (missing = red,
 * in-transit = accent). Clicking expands the entry to a full StationEntryCard
 * (rendered by the caller above the grid); hover reveals an unpin shortcut.
 * The tile keeps whole-entry drag-out like the card does.
 */
import { useCallback } from 'react'
import { motion } from 'framer-motion'
import type { StationEntryDto } from '../../shared/station'
import { useStore } from '../store/appStore'
import { useDragOut } from '../hooks/useDragOut'
import { basename } from '../lib/format'
import { getFileKind } from '../lib/fileType'
import { playCardExpandSound, playToggleSound } from '../lib/soundEffects'
import { FileKindIcon, PinFillIcon } from './icons'
import { t } from '../i18n'

interface Props {
  entry: StationEntryDto
  onExpand: (id: string) => void
}

export function PinnedTile({ entry, onExpand }: Props) {
  const startDrag = useDragOut()
  const setInternalDragReq = useStore((s) => s.setInternalDragReq)

  const handleDragStart = useCallback((e: React.DragEvent) => {
    setInternalDragReq({ id: entry.id })
    e.preventDefault()
    startDrag({ id: entry.id })
  }, [entry.id, setInternalDragReq, startDrag])

  const first = entry.paths[0]
  const info = getFileKind(first)
  const name = entry.members[0]?.name ?? basename(first)
  const isBundle = entry.paths.length > 1

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.1 } }}
      transition={{ type: 'spring', stiffness: 400, damping: 32, mass: 0.7, restDelta: 0.05, restSpeed: 0.05 }}
      className={`pinned-tile${entry.stale ? ' missing' : ''}`}
      title={name}
      draggable
      onDragStartCapture={handleDragStart}
      onDragEnd={() => setInternalDragReq(null)}
      onClick={(e) => {
        e.stopPropagation()
        playCardExpandSound(true)
        onExpand(entry.id)
      }}
    >
      {entry.stale && <span className="pinned-tile-dot missing" title={t('item.fileMissing')} />}
      {!entry.stale && entry.inTransit && <span className="pinned-tile-dot in-transit" title={t('item.inTransit')} />}
      <div className="pinned-tile-icon" style={{ color: info.color }}>
        <FileKindIcon path={first} width={18} height={18} />
      </div>
      <div className="pinned-tile-name">{name}</div>
      {isBundle && <span className="pinned-tile-count">{entry.paths.length}</span>}
      <button
        className="pinned-tile-unpin"
        title={t('item.unpin')}
        onClick={(e) => {
          e.stopPropagation()
          e.currentTarget.blur()
          playToggleSound(false)
          void useStore.getState().stationPin(entry.id, false)
        }}
      >
        <PinFillIcon width={10} height={10} />
      </button>
    </motion.div>
  )
}
