/**
 * ContentPicker — "Add content" overlay in the task detail: lists clipboard
 * shelf items and links the picked one to the task via task:link-item.
 * Items already linked to the task are marked and disabled.
 */
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import { previewText, relativeTime, formatImageDisplayName } from '../../lib/format'
import { CheckIcon, CloseIcon, FileIcon, ImageIcon, LinkIcon } from '../icons'
import type { ClipboardItemDto } from '../../../shared/types'

const MAX_ROWS = 40

interface Props {
  taskId: string
  linkedItemIds: Set<string>
  onClose: () => void
}

function rowPreview(item: ClipboardItemDto): string {
  switch (item.data.kind) {
    case 'text':
      return previewText(item.data.text, 60)
    case 'image':
      return `${item.data.width}×${item.data.height}`
    case 'image-collection':
      return `${item.data.images.length} images`
    case 'files':
      return item.data.paths.map((p) => formatImageDisplayName(p, item.capturedAt)).join(', ')
  }
}

export function ContentPicker({ taskId, linkedItemIds, onClose }: Props) {
  const { t } = useTranslation()
  const items = useStore((s) => s.items)
  const linkItemToTask = useStore((s) => s.linkItemToTask)
  const pushToast = useStore((s) => s.pushToast)

  const rows = items.slice(0, MAX_ROWS)

  const handlePick = async (itemId: string) => {
    await linkItemToTask(taskId, itemId)
    pushToast({ id: `link-${Date.now()}`, message: t('tasks.linkToast'), tone: 'info' })
    onClose()
  }

  return (
    <div className="task-picker-overlay" onClick={onClose}>
      <div className="task-picker-card" onClick={(e) => e.stopPropagation()}>
        <div className="task-picker-head">
          <span>{t('tasks.addContentTitle')}</span>
          <button type="button" className="task-btn ghost" onClick={onClose} title={t('header.close')}>
            <CloseIcon width={13} height={13} />
          </button>
        </div>
        {rows.length === 0 ? (
          <div className="task-picker-empty">{t('tasks.addContentEmpty')}</div>
        ) : (
          <div className="task-picker-list">
            {rows.map((item) => {
              const linked = linkedItemIds.has(item.id)
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`task-picker-item${linked ? ' linked' : ''}`}
                  disabled={linked}
                  title={linked ? t('tasks.alreadyLinked') : undefined}
                  onClick={() => void handlePick(item.id)}
                >
                  <span className="task-picker-kind">
                    {item.data.kind === 'text' ? (
                      item.data.isUrl ? <LinkIcon width={13} height={13} /> : <FileIcon width={13} height={13} />
                    ) : (
                      <ImageIcon width={13} height={13} />
                    )}
                  </span>
                  <span className="task-picker-preview">{rowPreview(item)}</span>
                  <span className="task-picker-meta">
                    {linked ? <CheckIcon width={12} height={12} /> : relativeTime(item.capturedAt)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
