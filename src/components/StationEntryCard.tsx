/**
 * StationEntryCard — one transfer station entry in the files view (ADR-0006).
 *
 * Mirrors the clipboard stack's file-bundle card: collapsed = stacked preview
 * (up to four paths), click expands to per-member rows. Members reuse
 * FileMemberRow (station-routed: paste/copy/pin go through the station
 * channels; the card pins at entry level, so rows skip the pin button).
 *
 * Station specifics:
 *   - the whole entry drags out (main falls back to the station lookup for
 *     path-less drag requests), members drag individually
 *   - entry-to-entry drops merge inside the station (stationMerge)
 *   - clipboard-captured entries carry a route badge (途径, CONTEXT.md)
 *   - a stale entry (any path missing on disk) is dimmed
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { StationEntryDto } from '../../shared/station'
import { useStore } from '../store/appStore'
import { useDragOut } from '../hooks/useDragOut'
import { relativeTime, basename } from '../lib/format'
import { getFileKind } from '../lib/fileType'
import { playToggleSound, playDeleteSound, playCardExpandSound } from '../lib/soundEffects'
import { FileKindIcon, PinIcon, PinFillIcon, TrashIcon, ChevronUpIcon } from './icons'
import { FileMemberRow } from './FileMemberRow'
import { t } from '../i18n'

interface Props {
  entry: StationEntryDto
}

function StationEntryCardBase({ entry }: Props) {
  const open = useStore((s) => s.open)
  const [expanded, setExpanded] = useState(false)
  const startDrag = useDragOut()
  const setInternalDragReq = useStore((s) => s.setInternalDragReq)

  useEffect(() => {
    if (!open) setExpanded(false)
  }, [open])

  const count = entry.paths.length
  const isBundle = count > 1

  const handleDragStart = useCallback((e: React.DragEvent) => {
    setInternalDragReq({ id: entry.id })
    e.preventDefault()
    startDrag({ id: entry.id })
  }, [entry.id, setInternalDragReq, startDrag])

  const onSplitMember = useCallback((e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    void useStore.getState().stationSplit({ id: entry.id, paths: [path], splitPlacement: 'after' })
  }, [entry.id])

  const onExpand = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    playCardExpandSound(true)
    setExpanded(true)
  }, [])

  const onCollapse = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    playCardExpandSound(false)
    setExpanded(false)
  }, [])

  const first = entry.paths[0]
  const info = getFileKind(first)

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4, transition: { duration: 0.12, ease: [0.32, 0, 0.67, 0] } }}
      transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 0.8, restDelta: 0.05, restSpeed: 0.05 }}
      className={`item${entry.pinned ? ' pinned' : ''}${isBundle ? ' bundle' : ''}`}
      style={entry.stale ? { opacity: 0.55 } : undefined}
    >
      <div
        className="item-main"
        data-id={entry.id}
        draggable={!expanded}
        onDragStart={handleDragStart}
        onDragEnd={() => setInternalDragReq(null)}
        onDragOver={(e) => {
          const activeDrag = useStore.getState().internalDragReq
          if (activeDrag && activeDrag.id !== entry.id) {
            e.preventDefault()
          } else if (activeDrag && activeDrag.id === entry.id) {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
        onDrop={(e) => {
          const activeDrag = useStore.getState().internalDragReq
          if (activeDrag && activeDrag.id !== entry.id) {
            e.preventDefault()
            e.stopPropagation()
            void useStore.getState().stationMerge(activeDrag.id, entry.id)
            setInternalDragReq(null)
          } else if (activeDrag && activeDrag.id === entry.id) {
            e.preventDefault()
            e.stopPropagation()
            setInternalDragReq(null)
          }
        }}
        onClick={isBundle && !expanded ? onExpand : undefined}
      >
        {!expanded && entry.route === 'clipboard' && (
          <span
            className="kind-badge"
            style={{
              position: 'absolute',
              top: 10,
              left: 10,
              zIndex: 5
            }}
            title={t('item.routeClipboard')}
          >
            {t('item.routeClipboard')}
          </span>
        )}
        <div className="body">
          <div className="fluid-bundle">
            <AnimatePresence initial={false} mode="wait">
              {expanded ? (
                <motion.div
                  key="expanded"
                  className="fluid-list"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.16, ease: 'easeOut' } }}
                  exit={{ opacity: 0, transition: { duration: 0.12, ease: 'easeIn' } }}
                >
                  <div className="bundle-actions">
                    <div
                      className="bundle-collapse-zone"
                      title={t('item.collapsePinned')}
                      onClick={(e) => { e.stopPropagation(); onCollapse(e); }}
                    >
                      <button className="act bundle-collapse-btn">
                        <ChevronUpIcon />
                      </button>
                    </div>
                    <div className="bundle-capacity">{count}</div>
                    <div className="actions-pill">
                      <button
                        className={`act${entry.pinned ? ' active' : ''}`}
                        title={entry.pinned ? t('item.unpin') : t('item.pin')}
                        onClick={(e) => {
                          e.stopPropagation()
                          playToggleSound(!entry.pinned)
                          void useStore.getState().stationPin(entry.id, !entry.pinned)
                        }}
                      >
                        {entry.pinned ? <PinFillIcon /> : <PinIcon />}
                      </button>
                      <button
                        className="act danger"
                        title={t('item.delete')}
                        onClick={(e) => {
                          e.stopPropagation()
                          playDeleteSound()
                          void useStore.getState().stationDelete(entry.id)
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                  {entry.paths.map((path, idx) => (
                    <FileMemberRow
                      key={`${entry.id}:${idx}`}
                      member={{
                        itemId: entry.id,
                        path,
                        index: idx,
                        ext: entry.members[idx]?.ext || null,
                        name: entry.members[idx]?.name ?? basename(path),
                        size: entry.members[idx]?.size ?? 0,
                        isImage: entry.members[idx]?.isImage ?? false,
                        exists: entry.members[idx]?.exists,
                        ...(entry.members[idx]?.isImage && entry.members[idx]?.exists
                          ? { preview: `tracelocal://thumb/${encodeURIComponent(path)}` }
                          : {})
                      }}
                      showPin={false}
                      onSplit={(e) => onSplitMember(e, path)}
                    />
                  ))}
                </motion.div>
              ) : (
                <motion.div
                  key="collapsed"
                  style={{ width: '100%' }}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1, transition: { duration: 0.18, ease: 'easeOut' } }}
                  exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12, ease: 'easeIn' } }}
                >
                  <div className="bundle-stack-large">
                    {entry.paths.slice(0, 4).map((path, i) => ({ path, pathIndex: i })).reverse().map(({ path, pathIndex }, idx, arr) => {
                      const realIndex = arr.length - 1 - idx
                      const member = entry.members[pathIndex]
                      const preview = member?.isImage && member?.exists
                        ? `tracelocal://thumb/${encodeURIComponent(path)}`
                        : null
                      return (
                        <motion.div
                          key={`${entry.id}-${pathIndex}`}
                          className="bundle-stack-card bundle-file-stack-card"
                          animate={{
                            x: realIndex * 20 - 20,
                            y: realIndex * 6,
                            rotate: realIndex * 6 - 6,
                            scale: 1 - realIndex * 0.05
                          }}
                          style={{ zIndex: 10 - realIndex }}
                          initial={{ borderRadius: 8 }}
                        >
                          {preview ? (
                            <img
                              src={preview}
                              alt=""
                              draggable={false}
                              loading="lazy"
                              decoding="async"
                              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }}
                            />
                          ) : (
                            <div style={{ color: getFileKind(path).color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <FileKindIcon path={path} width={40} height={40} />
                            </div>
                          )}
                        </motion.div>
                      )
                    })}
                  </div>
                  {count > 1 ? (
                    <div className="bundle-more-label">{t('item.moreFiles', { count: count - 1 })}</div>
                  ) : (
                    <div className="bundle-more-label">{t('item.singleFile')}</div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="meta">
            <span className="kind-badge" style={count === 1 && !entry.members[0]?.isImage ? { color: info.color } : undefined}>
              <FileKindIcon path={first} width={11} height={11} />
              {count > 1 ? `${count} ${t('filters.files').toLowerCase()}` : info.label.toLowerCase()}
            </span>
            <span>{relativeTime(entry.capturedAt)}</span>
          </div>
        </div>

        <div className="actions" onClick={(e) => e.stopPropagation()} style={{ display: expanded ? 'none' : undefined }}>
          <button
            className={`act${entry.pinned ? ' active' : ''}`}
            title={entry.pinned ? t('item.unpin') : t('item.pin')}
            onClick={(e) => {
              e.currentTarget.blur()
              playToggleSound(!entry.pinned)
              void useStore.getState().stationPin(entry.id, !entry.pinned)
            }}
          >
            {entry.pinned ? <PinFillIcon /> : <PinIcon />}
          </button>
          <div className="act-divider" />
          <button
            className="act danger"
            title={t('item.delete')}
            onClick={(e) => {
              e.currentTarget.blur()
              playDeleteSound()
              void useStore.getState().stationDelete(entry.id)
            }}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </motion.div>
  )
}

export const StationEntryCard = memo(StationEntryCardBase)
