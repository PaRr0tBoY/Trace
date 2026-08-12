/**
 * TaskView — the task layer root inside the panel.
 *
 * List mode is ONE scroll column (t24): suggestion cards on top when any are
 * pending, a hairline divider, then the grouped task list — no more split
 * panes. Detail and create/edit forms are full-page sub-views, and the
 * suggestion convert panel (TaskEditor in suggestion mode) is one too —
 * same structure as create/edit, closed loop: edit + convert in place.
 * Delete is always a confirmed hard delete.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { TaskDto } from '../../../shared/types'
import { TaskList } from './TaskList'
import { TaskDetail } from './TaskDetail'
import { TaskEditor } from './TaskEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { ContentPicker } from './ContentPicker'
import { SuggestionCard } from './SuggestionCard'

export function TaskView() {
  const { t } = useTranslation()
  const tasks = useStore((s) => s.tasks)
  const suggestions = useStore((s) => s.suggestions)
  const createTask = useStore((s) => s.createTask)
  const updateTask = useStore((s) => s.updateTask)
  const deleteTask = useStore((s) => s.deleteTask)
  const acceptSuggestion = useStore((s) => s.acceptSuggestion)

  /** Task whose detail is open (null = list). */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 'new' = create form; a task id = edit form; null = no form. */
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  /** Suggestion whose convert panel is open (null = closed). */
  const [convertId, setConvertId] = useState<string | null>(null)
  /** Task awaiting hard-delete confirmation. */
  const [confirmDelete, setConfirmDelete] = useState<TaskDto | null>(null)
  /** Task whose content picker (add content) is open. */
  const [pickerTaskId, setPickerTaskId] = useState<string | null>(null)

  const selected = selectedId ? (tasks.find((task) => task.id === selectedId) ?? null) : null
  const converting = convertId ? (suggestions.find((s) => s.id === convertId) ?? null) : null

  // The selected task vanished (deleted here or elsewhere): fall back to the list.
  useEffect(() => {
    if (selectedId && !selected) {
      setSelectedId(null)
      setEditing((e) => (e !== null && e !== 'new' ? null : e))
    }
  }, [selectedId, selected])

  // A new analysis replaced the pending list: close the convert panel too.
  useEffect(() => {
    if (convertId && !converting) setConvertId(null)
  }, [convertId, converting])

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    await deleteTask(confirmDelete.id)
    if (selectedId === confirmDelete.id) setSelectedId(null)
    if (editing === confirmDelete.id) setEditing(null)
    setConfirmDelete(null)
  }

  return (
    <div className="task-view">
      {editing !== null ? (
        <TaskEditor
          task={editing === 'new' ? null : selected}
          onSave={async ({ title, note, apps, clipboardItemIds }) => {
            if (editing === 'new') {
              await createTask(title, { note, apps, clipboardItemIds })
            } else if (selected) {
              await updateTask(selected.id, { title, note, apps, clipboardItemIds })
            }
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      ) : converting ? (
        <TaskEditor
          suggestion={converting}
          onSave={async ({ title, note, apps, clipboardItemIds }) => {
            await acceptSuggestion(converting.id, { title, note, apps, clipboardItemIds })
            setConvertId(null)
          }}
          onCancel={() => setConvertId(null)}
        />
      ) : selected ? (
        <TaskDetail
          task={selected}
          onBack={() => setSelectedId(null)}
          onEdit={() => setEditing(selected.id)}
          onDeleteRequest={setConfirmDelete}
          onAddContent={() => setPickerTaskId(selected.id)}
        />
      ) : (
        <div className="task-scroll">
          {suggestions.length > 0 && (
            <>
              <div className="task-suggest-list">
                {suggestions.map((s) => (
                  <SuggestionCard key={s.id} suggestion={s} onOpen={setConvertId} />
                ))}
              </div>
              <div className="task-suggest-divider" />
            </>
          )}
          <TaskList
            tasks={tasks}
            onOpen={(task) => setSelectedId(task.id)}
            onCreate={() => setEditing('new')}
            onDeleteRequest={setConfirmDelete}
          />
        </div>
      )}

      {pickerTaskId && selected && (
        <ContentPicker
          taskId={pickerTaskId}
          linkedItemIds={new Set(
            selected.resources.flatMap((r) => (r.kind === 'clipboard' ? [r.itemId] : []))
          )}
          onClose={() => setPickerTaskId(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t('tasks.deleteTitle')}
          description={t('tasks.deleteDesc')}
          confirmLabel={t('tasks.deleteConfirm')}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}
