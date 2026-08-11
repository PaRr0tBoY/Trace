/**
 * TaskEditor — inline create/edit form for a task (title + optional note).
 * The ✨ button (t28) asks the provider chain for title candidates and
 * fills the title input with the best one; disabled without a provider.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useStore } from '../../store/appStore'
import type { SuggestTitleContext } from '../../../shared/ipc'
import type { Task } from '../../../shared/types'

interface Props {
  /** The task being edited, or null when creating a new one. */
  task: Task | null
  onSave: (title: string, note: string | undefined) => void
  onCancel: () => void
}

/** Short previews of the task's linked resources for the LLM draft. */
function buildResourcePreviews(task: Task | null): string[] {
  if (!task) return []
  return task.resources.map((r) => {
    if (r.kind === 'files') return r.paths.slice(0, 3).join(', ')
    const s = r.snapshot
    if (s.type === 'text' || s.type === 'files') return s.preview
    return `image ${s.width}x${s.height}`
  })
}

export function TaskEditor({ task, onSave, onCancel }: Props) {
  const { t } = useTranslation()
  const hasProvider = (useStore((s) => s.settings.aiProviders) ?? []).length > 0
  const [title, setTitle] = useState(task?.title ?? '')
  const [note, setNote] = useState(task?.note ?? '')
  const [suggesting, setSuggesting] = useState(false)
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

  const suggestTitle = async () => {
    if (suggesting) return
    setSuggesting(true)
    const fail = () =>
      useStore.getState().pushToast({
        id: `suggest-title-${Date.now()}`,
        message: t('tasks.suggestTitleFailed'),
        tone: 'error'
      })
    try {
      const ctx: SuggestTitleContext = {
        title: title.trim() || undefined,
        note: note.trim() || undefined,
        appNames: (task?.apps ?? []).map((a) => a.name),
        resourcePreviews: buildResourcePreviews(task)
      }
      const candidates = await useStore.getState().suggestTaskTitle(ctx)
      if (candidates && candidates.length > 0) {
        setTitle(candidates[0])
      } else {
        fail()
      }
    } catch {
      fail()
    } finally {
      setSuggesting(false)
    }
  }

  return (
    <div className="task-editor">
      <div className="task-editor-title-row">
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
        <button
          type="button"
          className="task-editor-suggest"
          title={t('tasks.suggestTitle')}
          disabled={!hasProvider || suggesting}
          onClick={suggestTitle}
        >
          {suggesting ? t('tasks.suggestTitleWorking') : t('tasks.suggestTitle')}
        </button>
      </div>
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
