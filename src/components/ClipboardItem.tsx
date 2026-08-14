/**
 * ClipboardItem — a single history/shelf entry.
 *
 * Interactions:
 *   - Click body            -> paste item (write to clipboard + simulate Ctrl+V)
 *   - Drag the tile         -> native OS drag-out (via useDragOut)
 *   - File bundle: click body -> expand/collapse
 *   - Drag collapsed bundle -> drag all files as one entity
 *   - Drag expanded sub-row -> drag just that one file
 *   - Pin / Delete          -> quick actions on hover
 *   - Copy button (⧉)      -> single-click copy (just clipboard, no Ctrl+V)
 *
 * Visual: a raised dark tile. Image items show a thumbnail; text items show a
 * clamped preview; file items list names or bundle badge. Motion is handled by
 * the parent list (layout/AnimatePresence), so this component stays presentational.
 */
import { memo, useState, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { ClipboardItemDto } from '../../shared/types'
import type { StationEntryDto } from '../../shared/station'
import { MAX_STACK } from '../../shared/types'
import type { DragRequest } from '../../shared/types'
import { useStore } from '../store/appStore'
import { useDragOut } from '../hooks/useDragOut'
import { edge } from '../lib/edge'
import { basename, formatBytes, previewText, relativeTime, formatImageDisplayName } from '../lib/format'
import { getFileKind } from '../lib/fileType'
import { playButtonClickSound, playToggleSound, playDeleteSound, playCardExpandSound } from '../lib/soundEffects'
import { CopyIcon, FileKindIcon, ImageIcon, LinkIcon, PinIcon, PinFillIcon, TrashIcon, ChevronUpIcon, ExpandIcon, ContractIcon, ExternalLinkIcon } from './icons'
import '../styles/item.css'

import { tryPaste } from '../lib/tryPaste'
import { t } from '../i18n'

interface Props {
  item: ClipboardItemDto
  /** Skip the enter animation (used when the type filter/search changes —
      cards swap instantly instead of "clearing then falling back in"). */
  instant?: boolean
  /** FLIP position animation on list reorder; disabled on long lists (the
      O(n) layout pass + spring on every card is the reorder-frame cost). */
  animateLayout?: boolean
  /** Single-file transfer-station entry rendered in the clipboard card
      style (feedback: 单个文件不显示为组卡片). `item` is the display
      conversion of this entry; actions route to the station channels. */
  stationEntry?: StationEntryDto
}





/* ------------------------------------------------------------------ */
/* Main item card                                                      */
/* ------------------------------------------------------------------ */

function ClipboardItemBase({ item, instant, animateLayout, stationEntry }: Props) {
  const copy = useStore.getState().copy
  const paste = useStore.getState().paste
  const togglePin = useStore.getState().togglePin
  const remove = useStore.getState().remove
  const setInternalDragReq = useStore.getState().setInternalDragReq
  const startDrag = useDragOut()
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const isStation = stationEntry !== undefined

  const open = useStore((s) => s.open)
  useEffect(() => {
    if (!open) setExpanded(false)
  }, [open])

  const isPreviewing = useStore((s) => s.previewItemId) === item.id
  const isBundle = (item.data.kind === 'files' && item.data.paths.length > 1) || item.data.kind === 'image-collection'

  const onCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    playButtonClickSound()
    if (stationEntry) {
      void edge.stationCopyMember({ id: stationEntry.id, paths: stationEntry.paths })
    } else {
      copy(item.id)
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 900)
  }, [copy, item.id, stationEntry])

  const onPaste = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (stationEntry) {
      tryPaste(() => edge.stationPasteMember({ id: stationEntry.id, paths: stationEntry.paths }))
    } else {
      tryPaste(() => paste(item.id))
    }
  }, [paste, item.id, stationEntry])

  const onExpand = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (isBundle) {
      playCardExpandSound(true)
      setExpanded(true)
      if (useStore.getState().tutorialStep === 4 && item.id === 'onboarding-files') {
        useStore.getState().setTutorialStep(5)
      }
    }
  }, [isBundle, item.id])

  const onCollapse = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    playCardExpandSound(false)
    setExpanded(false)
  }, [])

  const handleDragStart = useCallback((e: React.DragEvent, req: DragRequest) => {
    // Every kind OLE-drags out of the app from the main process via
    // Electron's startDrag (text is staged as a temp .txt in main). Cancel
    // the HTML5 drag (preventDefault) so the browser doesn't run its own
    // ghost in parallel, and fire the IPC synchronously so main starts the
    // OS drag on the same tick. In-panel drops still work: the drop
    // target resolves `item:internal-drop` against internalDragReq (set
    // below), the same path images/files already use.
    setInternalDragReq(req)
    e.preventDefault()
    startDrag(req)
  }, [startDrag, setInternalDragReq])

  return (
    <motion.div
      layout={animateLayout ? 'position' : false}
      initial={!instant && open ? { opacity: 0, scale: 0.96, y: 6 } : false}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4, transition: { duration: 0.12, ease: [0.32, 0, 0.67, 0] } }}
      transition={{
        layout: { type: 'spring', stiffness: 280, damping: 28, mass: 0.8 },
        type: 'spring',
        stiffness: 300,
        damping: 30,
        mass: 0.8,
        restDelta: 0.05,
        restSpeed: 0.05
      }}
      className={`item${item.pinned ? ' pinned' : ''}${isBundle ? ' bundle' : ''}`}
    >
      {copied && (
        <motion.div
          key="copy-ripple"
          initial={{ opacity: 0.75, scale: 0.2 }}
          animate={{ opacity: 0, scale: 1.6 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 16,
            background: 'radial-gradient(circle at center, rgba(255, 255, 255, 0.3) 0%, rgba(255, 255, 255, 0.08) 45%, transparent 75%)',
            pointerEvents: 'none',
            zIndex: 15
          }}
        />
      )}
      <div
        className={`item-main${isPreviewing ? ' force-actions previewing' : ''}`}
        data-id={item.id}
        draggable={!isPreviewing && (!isBundle || !expanded)}
        onDragStart={(e) => handleDragStart(e, { id: item.id, ...(stationEntry ? { paths: stationEntry.paths } : {}) })}
        onDragEnd={() => setInternalDragReq(null)}
        onDragOver={(e) => {
          const activeDrag = useStore.getState().internalDragReq
          if (activeDrag && activeDrag.id !== item.id) {
            e.preventDefault()
          } else if (activeDrag && activeDrag.id === item.id) {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
        onDrop={(e) => {
          const activeDrag = useStore.getState().internalDragReq
          if (activeDrag && activeDrag.id !== item.id) {
            e.preventDefault()
            e.stopPropagation()
            // Drop-on-another-item merging was removed with the grouping
            // feature (user feedback 2026-08-14) — every entry stays
            // standalone.
            setInternalDragReq(null)
          } else if (activeDrag && activeDrag.id === item.id) {
            e.preventDefault()
            e.stopPropagation()
            setInternalDragReq(null)
          }
        }}
        onClick={isPreviewing ? undefined : (isBundle && !expanded ? onExpand : (!isBundle ? onPaste : undefined))}
      >
        <div className="body">
          {isBundle ? (
              <BundleFluidPreview 
                item={item} 
                expanded={expanded} 
                onDragStart={handleDragStart} 
                onCopy={onCopy} 
                onRemove={() => remove(item.id)} 
                onCollapse={onCollapse}
              />
          ) : (
            <Preview item={item} />
          )}
          <div className="meta">
            <KindBadge item={item} />
            <span>{relativeTime(item.capturedAt)}</span>
            {item.hitCount > 1 && <span>· ×{item.hitCount}</span>}
            {item.data.kind === 'image' && (
              <span>
                · {item.data.width}×{item.data.height}
              </span>
            )}
            {item.data.kind === 'image' && <span>· {formatBytes(item.data.bytes)}</span>}
            {copied && <span style={{ color: '#fff' }}>· copied</span>}
          </div>
        </div>

        <div 
          className="actions" 
          onClick={(e) => e.stopPropagation()} 
          style={{ display: isBundle && expanded ? 'none' : undefined }}
        >
          <button
            className={`act${item.pinned ? ' active' : ''}`}
            title={item.pinned ? t('item.unpin') : t('item.pin')}
            onClick={(e) => {
              e.currentTarget.blur()
              playToggleSound(!item.pinned)
              if (stationEntry) {
                void useStore.getState().stationPin(stationEntry.id, !item.pinned)
              } else {
                togglePin(item.id, !item.pinned)
              }
            }}
          >
            {item.pinned ? <PinFillIcon /> : <PinIcon />}
          </button>
          {!isStation && (
            <button
              className={`act${isPreviewing ? ' preview-contract active' : ' preview-expand'}`}
              title={isPreviewing ? t('header.close') : t('item.expand')}
              onClick={(e) => {
                e.stopPropagation()
                e.currentTarget.blur()
                playCardExpandSound(!isPreviewing)
                const rect = e.currentTarget.closest('.item-main')?.getBoundingClientRect()
                const rectData = rect ? { y: rect.y, height: rect.height } : undefined
                useStore.getState().setPreviewItemId(isPreviewing ? null : item.id, rectData)
              }}
            >
              {isPreviewing ? <ContractIcon /> : <ExpandIcon />}
            </button>
          )}
          <button className="act" title={t('item.copy')} onClick={(e) => {
            e.currentTarget.blur()
            onCopy(e)
          }}>
            <CopyIcon />
          </button>
          {item.data.kind === 'text' && item.data.isUrl && (
            <button
              className="act"
              title={t('flyout.openLink')}
              onClick={(e) => {
                e.stopPropagation()
                e.currentTarget.blur()
                playButtonClickSound()
                window.open((item.data as any).text, '_blank')
              }}
            >
              <ExternalLinkIcon />
            </button>
          )}
          <div className="act-divider" />
          <button
            className="act danger"
            title={t('item.delete')}
            onClick={(e) => {
              e.currentTarget.blur()
              playDeleteSound()
              if (stationEntry) {
                void useStore.getState().stationDelete(stationEntry.id)
              } else {
                remove(item.id)
              }
            }}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </motion.div>
  )
}

// Bundle expand/collapse — all blur removed; opacity+y+scale composite trivially.
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      opacity: { duration: 0.18, ease: 'easeOut' },
      staggerChildren: 0.04,
      delayChildren: 0.01
    }
  },
  exit: {
    opacity: 0,
    transition: {
      opacity: { duration: 0.12, ease: 'easeIn' },
      staggerChildren: 0.025,
      staggerDirection: -1
    }
  }
};

const rowVariants = {
  hidden: { opacity: 0, y: 8, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      y: { type: 'spring', stiffness: 500, damping: 38, mass: 0.6, restDelta: 0.05 },
      scale: { type: 'spring', stiffness: 500, damping: 38, mass: 0.6, restDelta: 0.05 },
      opacity: { duration: 0.16, ease: 'easeOut' }
    }
  },
  exit: {
    opacity: 0,
    y: -6,
    scale: 0.97,
    transition: {
      y: { duration: 0.1, ease: 'easeIn' },
      scale: { duration: 0.1, ease: 'easeIn' },
      opacity: { duration: 0.1, ease: 'easeIn' }
    }
  }
};

const stackVariants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      scale: { type: 'spring', stiffness: 480, damping: 38, mass: 0.6, restDelta: 0.05 },
      opacity: { duration: 0.18, ease: 'easeOut' }
    }
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: {
      scale: { duration: 0.12, ease: 'easeIn' },
      opacity: { duration: 0.12, ease: 'easeIn' }
    }
  }
};

function BundleFluidPreview({
  item,
  expanded,
  onDragStart,
  onCopy,
  onRemove,
  onCollapse,
}: {
  item: ClipboardItemDto
  expanded: boolean
  onDragStart: (e: React.DragEvent, req: DragRequest) => void
  onCopy: (e: React.MouseEvent) => void
  onRemove: () => void
  onCollapse: (e?: React.MouseEvent) => void
}) {



  if (item.data.kind === 'image-collection') {
    const more = item.data.images.length - 1
    return (
      <div className="fluid-bundle">
        <AnimatePresence initial={false} mode="wait">
          {expanded ? (
            <motion.div
              key="expanded"
              className="fluid-list"
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
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
                <div className="actions-pill">
                  <button
                    className={`act${item.pinned ? ' active' : ''}`}
                    title={item.pinned ? t('item.unpin') : t('item.pin')}
                    onClick={(e) => { e.stopPropagation(); useStore.getState().togglePin(item.id, !item.pinned); }}
                  >
                    {item.pinned ? <PinFillIcon /> : <PinIcon />}
                  </button>
                  <button className="act" title={t('item.copy')} onClick={(e) => { e.stopPropagation(); onCopy(e); }}>
                    <CopyIcon />
                  </button>
                  <button className="act danger" title={t('item.delete')} onClick={(e) => { e.stopPropagation(); onRemove(); }}>
                    <TrashIcon />
                  </button>
                </div>
              </div>
              {item.data.images.map((img) => (
                <motion.div
                  key={img.imageId}
                  className="fluid-list-row"
                  variants={rowVariants}
                  draggable
                  onDragStartCapture={(e: any) => { e.stopPropagation(); onDragStart(e, { id: item.id, imageId: img.imageId }) }}
                  onClick={(e) => { e.stopPropagation(); tryPaste(() => window.edge.pasteSubitem({ id: item.id, imageId: img.imageId })) }}
                >
                  <motion.img
                    src={img.preview}
                    style={{ width: 50, height: 50, objectFit: 'cover', borderRadius: 4, background: 'rgba(0,0,0,0.5)' }}
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>
                       {t('item.imageItem')} • {img.width} × {img.height}
                    </span>
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                      {formatBytes(img.bytes)}
                    </span>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          ) : (
            <motion.div
              key="collapsed"
              style={{ width: '100%' }}
              variants={stackVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <div className="bundle-stack-large">
                {item.data.images.slice(0, 4).reverse().map((img, idx, arr) => {
                  const realIndex = arr.length - 1 - idx
                  return (
                    <motion.img
                      key={img.imageId}
                      src={img.preview}
                      className="bundle-stack-card"
                      loading="lazy"
                      decoding="async"
                      animate={{ 
                        x: realIndex * 20 - 20, 
                        y: realIndex * 6, 
                        rotate: realIndex * 6 - 6, 
                        scale: 1 - realIndex * 0.05 
                      }}
                      style={{ zIndex: 10 - realIndex }}
                      draggable={false}
                      initial={{ borderRadius: 8 }}
                    />
                  )
                })}
              </div>
              {more > 0 && <div className="bundle-more-label">{t('item.moreImages', { count: more })}</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  if (item.data.kind === 'files') {
    const entries = item.data.entries
    const paths = item.data.paths
    const count = paths.length
    return (
      <div className="fluid-bundle">
        <AnimatePresence initial={false} mode="wait">
          {expanded ? (
            <motion.div
              key="expanded"
              className="fluid-list"
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
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
                <div className="bundle-capacity">
                  {count} / {MAX_STACK}
                </div>
                <div className="actions-pill">
                  <button className="act" title={t('item.copy')} onClick={(e) => { e.stopPropagation(); onCopy(e); }}>
                    <CopyIcon />
                  </button>
                  <button className="act danger" title={t('item.delete')} onClick={(e) => { e.stopPropagation(); onRemove(); }}>
                    <TrashIcon />
                  </button>
                </div>
              </div>
              {paths.map((filePath, idx) => {
                const entry = entries?.[idx]
                const name = formatImageDisplayName(entry?.name ?? filePath, item.capturedAt)
                const size = entry?.size ?? 0
                return (
                  <motion.div
                    key={`${item.id}-${idx}`}
                    className="fluid-list-row"
                    variants={rowVariants}
                    draggable
                    onDragStartCapture={(e: any) => { e.stopPropagation(); onDragStart(e, { id: item.id, paths: [filePath] }) }}
                    onClick={(e) => { e.stopPropagation(); tryPaste(() => window.edge.pasteSubitem({ id: item.id, paths: [filePath] })) }}
                  >
                    {entry?.isImage && entry.preview ? (
                      <div className="fluid-list-icon" style={{ overflow: 'hidden', padding: 0 }}>
                        <img 
                          src={entry.preview} 
                          alt="" 
                          draggable={false} 
                          loading="lazy" 
                          decoding="async" 
                          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }} 
                        />
                      </div>
                    ) : (
                      <div className="fluid-list-icon" style={{ color: getFileKind(filePath).color }}>
                        <FileKindIcon path={filePath} width={16} height={16} />
                      </div>
                    )}
                    <div className="fluid-list-text-wrap">
                      <div className="fluid-list-text">{name}</div>
                      {size > 0 && <div className="fluid-list-sub">{formatBytes(size)}</div>}
                    </div>
                    <button
                      className="act subitem-copy-btn"
                      title={t('item.copyFilePath')}
                      onClick={(e) => { e.stopPropagation(); window.edge.copySubitem({ id: item.id, paths: [filePath] }); }}
                      style={{ width: 24, height: 24 }}
                    >
                      <CopyIcon width={12} height={12} />
                    </button>
                  </motion.div>
                )
              })}
            </motion.div>
          ) : (
            <motion.div
              key="collapsed"
              style={{ width: '100%' }}
              variants={stackVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <div className="bundle-stack-large">
                {paths.slice(0, 4).map((filePath, i) => ({ filePath, pathIndex: i })).reverse().map(({ filePath, pathIndex }, idx, arr) => {
                  const realIndex = arr.length - 1 - idx
                  const entry = entries?.[pathIndex]
                  return (
                    <motion.div
                      key={`${item.id}-${pathIndex}`}
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
                      {entry?.isImage && entry.preview ? (
                        <img 
                          src={entry.preview} 
                          alt="" 
                          draggable={false} 
                          loading="lazy" 
                          decoding="async" 
                          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }} 
                        />
                      ) : (
                        <div style={{ color: getFileKind(filePath).color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <FileKindIcon path={filePath} width={40} height={40} />
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
    )
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

function Preview({ item }: { item: ClipboardItemDto }) {
  switch (item.data.kind) {
    case 'text':
      if (item.data.isUrl) {
        return (
          <>
            <div className="preview single">{item.data.text}</div>
          </>
        )
      }
      return <div className="preview">{previewText(item.data.text)}</div>

    case 'image':
      return (
        <div className="thumb-wrap">
          {item.data.preview ? (
            <img
              className="thumb"
              src={item.data.preview}
              alt=""
              draggable={false}
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="preview">[{t('item.imageItem')}]</div>
          )}
        </div>
      )

    case 'files': {
      const first = item.data.paths[0]
      const entry = item.data.entries?.[0]
      const rawName = entry?.name ?? basename(first)
      const displayName = formatImageDisplayName(first, item.capturedAt)
      const isInternalHash = /^[a-z0-9]{6,12}-[a-z0-9]{6,12}\.[a-z0-9]+$/i.test(rawName) || first.includes('trace/images') || first.includes('trace\\images') || first.includes('trace/temp') || first.includes('trace\\temp')
      const isImage = entry?.isImage || getFileKind(first).kind === 'image'

      // Single image file — show its thumbnail.
      if (item.data.paths.length === 1 && isImage) {
        return (
          <>
            <div className="thumb-wrap">
              {entry?.preview ? (
                <img
                  className="thumb"
                  src={entry.preview}
                  alt=""
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="preview">[image: {displayName}]</div>
              )}
            </div>
            {!isInternalHash && (
              <div className="preview single" style={{ marginTop: 4 }}>
                {displayName}
              </div>
            )}
          </>
        )
      }
      // Non-image single file — show a tinted type icon alongside its name.
      const info = getFileKind(first)
      return (
        <div className="single-file-preview">
          <div className="single-file-icon" style={{ color: info.color }}>
            <FileKindIcon path={first} width={28} height={28} />
          </div>
          <div className="single-file-meta">
            <div className="preview single">
              {displayName}
            </div>
            <div className="single-file-sub">
              {info.label}{entry && entry.size > 0 ? ` · ${formatBytes(entry.size)}` : ''}
            </div>
          </div>
        </div>
      )
    }
  }
}

/* ------------------------------------------------------------------ */
/* Kind badge                                                          */
/* ------------------------------------------------------------------ */

function KindBadge({ item }: { item: ClipboardItemDto }) {
  switch (item.data.kind) {
    case 'text':
      if (item.data.isUrl)
        return (
          <span className="kind-badge url">
            <LinkIcon width={11} height={11} /> {t('filters.links').toLowerCase()}
          </span>
        )
      return <span className="kind-badge">{t('filters.text').toLowerCase()}</span>
    case 'image':
      return (
        <span className="kind-badge">
          <ImageIcon width={11} height={11} /> {t('filters.images').toLowerCase().slice(0, -1) || t('filters.images').toLowerCase()}
        </span>
      )
    case 'image-collection':
      return (
        <span className="kind-badge">
          <ImageIcon width={11} height={11} />
          {item.data.images.length} {t('filters.images').toLowerCase()}
        </span>
      )
    case 'files': {
      const firstPath = item.data.paths[0]
      const info = getFileKind(firstPath)
      const count = item.data.paths.length
      const isImage = count === 1 && (item.data.entries?.[0]?.isImage || info.kind === 'image')
      if (isImage) {
        return (
          <span className="kind-badge">
            <ImageIcon width={11} height={11} /> {t('filters.images').toLowerCase().slice(0, -1) || t('filters.images').toLowerCase()}
          </span>
        )
      }
      const label = count > 1 ? `${count} ${t('filters.files').toLowerCase()}` : info.label.toLowerCase()
      return (
        <span className="kind-badge" style={{ color: count > 1 ? undefined : info.color }}>
          <FileKindIcon path={firstPath} width={11} height={11} />
          {label}
        </span>
      )
    }
  }
}

export const ClipboardItemCard = memo(ClipboardItemBase)
