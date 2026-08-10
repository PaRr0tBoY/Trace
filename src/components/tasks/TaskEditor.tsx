/**
 * TaskEditor — inline create/edit form for a task (title + optional note).
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import type { Task } from '../../../shared/types'

interface Props {
  /** The task being edited, or null when creating a new one. */
  task: Task | null
  onSave: (title: string, note: string | undefined) => void
  onCancel: () => void
}

export function TaskEditor({ task, onSave, onCancel }: Props) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(task?.title ?? '')
  const [note, setNote] = useState(task?.note ?? '')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const trimmed = title.trim()
  const canSave = trimmed.length > 0

  const submit = () => {
    if (!canSave) return
    onSave(trimmed, note.trim() || undefined)
  }

  return (
    <div className="task-editor">
      <input
        ref={titleRef}
        className="task-editor-input"
        placeholder={t('tasks.titlePlaceholder')}
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onCancel()
        }}
      />
      <textarea
        className="task-editor-textarea"
        placeholder={t('tasks.notePlaceholder')}
        value={note}
        rows={4}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="task-editor-actions">
        <button type="button" className="task-btn" onClick={onCancel}>
          {t('tasks.cancel')}
        </button>
        <button type="button" className="task-btn primary" disabled={!canSave} onClick={submit}>
          {t('tasks.save')}
        </button>
      </div>
    </div>
  )
}
