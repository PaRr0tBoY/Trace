/**
 * FileMemberRow — one file member in the files view (ADR-0004).
 *
 * Reuses the expanded-stack single-file interactions verbatim: drag starts
 * an OS drag of that one path, click pastes it (copy-subitem semantics: the
 * parent entry is promoted, no new entry is created), the copy button copies
 * the path, the pin button pins the parent entry. No delete — deletion is
 * entry-level.
 *
 * The parent entry may live in the transfer station (ADR-0008) instead of
 * the clipboard stack; actions then route to the station channels. Station
 * members skip the pin button (station cards pin at entry level) and can
 * render a split-out button via `onSplit`.
 */
import { useCallback } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '../store/appStore'
import { useDragOut } from '../hooks/useDragOut'
import { formatBytes } from '../lib/format'
import { getFileKind } from '../lib/fileType'
import { playButtonClickSound, playToggleSound } from '../lib/soundEffects'
import { CopyIcon, FileKindIcon, PinIcon, PinFillIcon } from './icons'
import { tryPaste } from '../lib/tryPaste'
import { t } from '../i18n'
import type { FileMember } from '../lib/fileTabs'
import { edge } from '../lib/edge'

interface Props {
  member: FileMember
  /** Hide the entry-level pin button (station cards pin from the card header). */
  showPin?: boolean
}

export function FileMemberRow({ member, showPin = true }: Props) {
  const stationEntry = useStore((s) => s.station.find((e) => e.id === member.itemId) ?? null)
  const item = useStore((s) => s.items.find((it) => it.id === member.itemId) ?? null)
  const entry = stationEntry ?? item
  const startDrag = useDragOut()
  const setInternalDragReq = useStore((s) => s.setInternalDragReq)

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.stopPropagation()
    setInternalDragReq({ id: member.itemId, paths: [member.path] })
    e.preventDefault()
    startDrag({ id: member.itemId, paths: [member.path] })
  }, [member.itemId, member.path, setInternalDragReq, startDrag])

  if (!entry) return null
  const isStation = !!stationEntry
  // Missing on-disk files stay visible but dimmed (station staleness, ADR-0008).
  const dimmed = member.exists === false

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="fluid-list-row"
      style={{ cursor: 'pointer', ...(dimmed ? { opacity: 0.45 } : {}) }}
      draggable
      onDragStartCapture={handleDragStart}
      onDragEnd={() => setInternalDragReq(null)}
      onClick={(e) => {
        e.stopPropagation()
        if (isStation) {
          tryPaste(() => edge.stationPasteMember({ id: member.itemId, paths: [member.path] }))
        } else {
          tryPaste(() => edge.pasteSubitem({ id: member.itemId, paths: [member.path] }))
        }
      }}
    >
      {member.isImage && member.preview ? (
        <div className="fluid-list-icon" style={{ overflow: 'hidden', padding: 0 }}>
          <img
            src={member.preview}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }}
          />
        </div>
      ) : (
        <div className="fluid-list-icon" style={{ color: getFileKind(member.path).color }}>
          <FileKindIcon path={member.path} width={16} height={16} />
        </div>
      )}
      <div className="fluid-list-text-wrap">
        <div className="fluid-list-text">{member.name}</div>
        {member.size > 0 && <div className="fluid-list-sub">{formatBytes(member.size)}</div>}
      </div>
      {showPin && (
        <button
          className={`act${entry.pinned ? ' active' : ''}`}
          title={entry.pinned ? t('item.unpin') : t('item.pin')}
          onClick={(e) => {
            e.stopPropagation()
            e.currentTarget.blur()
            playToggleSound(!entry.pinned)
            if (isStation) {
              void useStore.getState().stationPin(member.itemId, !entry.pinned)
            } else {
              void useStore.getState().togglePin(member.itemId, !entry.pinned)
            }
          }}
          style={{ width: 24, height: 24 }}
        >
          {entry.pinned ? <PinFillIcon width={12} height={12} /> : <PinIcon width={12} height={12} />}
        </button>
      )}
      <button
        className="act subitem-copy-btn"
        title={t('item.copyFilePath')}
        onClick={(e) => {
          e.stopPropagation()
          e.currentTarget.blur()
          playButtonClickSound()
          if (isStation) {
            void edge.stationCopyMember({ id: member.itemId, paths: [member.path] })
          } else {
            void edge.copySubitem({ id: member.itemId, paths: [member.path] })
          }
        }}
        style={{ width: 24, height: 24 }}
      >
        <CopyIcon width={12} height={12} />
      </button>
    </motion.div>
  )
}
