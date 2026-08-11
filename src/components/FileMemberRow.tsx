/**
 * FileMemberRow — one file member in the files view (ADR-0004).
 *
 * Reuses the expanded-stack single-file interactions verbatim: drag starts
 * an OS drag of that one path, click pastes it (copy-subitem semantics: the
 * parent entry is promoted, no new entry is created), the copy button copies
 * the path, the pin button pins the parent entry. No delete — deletion is
 * entry-level.
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

export function FileMemberRow({ member }: { member: FileMember }) {
  const item = useStore((s) => s.items.find((it) => it.id === member.itemId) ?? null)
  const startDrag = useDragOut()
  const setInternalDragReq = useStore((s) => s.setInternalDragReq)

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.stopPropagation()
    setInternalDragReq({ id: member.itemId, paths: [member.path] })
    e.preventDefault()
    startDrag({ id: member.itemId, paths: [member.path] })
  }, [member.itemId, member.path, setInternalDragReq, startDrag])

  if (!item) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="fluid-list-row"
      style={{ cursor: 'pointer' }}
      draggable
      onDragStartCapture={handleDragStart}
      onDragEnd={() => setInternalDragReq(null)}
      onClick={(e) => {
        e.stopPropagation()
        tryPaste(() => edge.pasteSubitem({ id: member.itemId, paths: [member.path] }))
      }}
    >
      {member.isImage && member.preview ? (
        <div className="fluid-list-icon" style={{ overflow: 'hidden', padding: 0 }}>
          <img
            src={member.preview}
            alt=""
            draggable={false}
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
      <button
        className={`act${item.pinned ? ' active' : ''}`}
        title={item.pinned ? t('item.unpin') : t('item.pin')}
        onClick={(e) => {
          e.stopPropagation()
          e.currentTarget.blur()
          playToggleSound(!item.pinned)
          void useStore.getState().togglePin(item.id, !item.pinned)
        }}
        style={{ width: 24, height: 24 }}
      >
        {item.pinned ? <PinFillIcon width={12} height={12} /> : <PinIcon width={12} height={12} />}
      </button>
      <button
        className="act subitem-copy-btn"
        title={t('item.copyFilePath')}
        onClick={(e) => {
          e.stopPropagation()
          e.currentTarget.blur()
          playButtonClickSound()
          void edge.copySubitem({ id: member.itemId, paths: [member.path] })
        }}
        style={{ width: 24, height: 24 }}
      >
        <CopyIcon width={12} height={12} />
      </button>
    </motion.div>
  )
}
