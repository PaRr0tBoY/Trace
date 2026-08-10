/**
 * TaskView — the task layer root inside the panel.
 *
 * Layout: reserved suggestion-card slot on top (t19 fills it), then either the
 * grouped list, the detail view, or the create/edit form. Delete is always a
 * confirmed hard delete.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { TaskDto } from '../../../shared/types'
import { SparklesIcon } from '../icons'
import { TaskList } from './TaskList'
import { TaskDetail } from './TaskDetail'
import { TaskEditor } from './TaskEditor'
import { ConfirmDialog } from './ConfirmDialog'

/** Reserved slot for suggestion cards (t19). Rendered empty for now. */
function SuggestionArea() {
  const { t } = useTranslation()
  return (
    <div className="task-suggest">
      <div className="task-suggest-icon">
        <SparklesIcon width={14} height={14} />
      </div>
      <div className="task-suggest-text">{t('tasks.suggestionsHint')}</div>
    </div>
  )
}

export function TaskView() {
  const { t } = useTranslation()
  const tasks = useStore((s) => s.tasks)
  const createTask = useStore((s) => s.createTask)
  const updateTask = useStore((s) => s.updateTask)
  const deleteTask = useStore((s) => s.deleteTask)

  /** Task whose detail is open (null = list). */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 'new' = create form; a task id = edit form; null = no form. */
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  /** Task awaiting hard-delete confirmation. */
  const [confirmDelete, setConfirmDelete] = useState<TaskDto | null>(null)

  const selected = selectedId ? (tasks.find((task) => task.id === selectedId) ?? null) : null

  // The selected task vanished (deleted here or elsewhere): fall back to the list.
  useEffect(() => {
    if (selectedId && !selected) {
      setSelectedId(null)
      setEditing((e) => (e !== null && e !== 'new' ? null : e))
    }
  }, [selectedId, selected])

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    await deleteTask(confirmDelete.id)
    if (selectedId === confirmDelete.id) setSelectedId(null)
    if (editing === confirmDelete.id) setEditing(null)
    setConfirmDelete(null)
  }

  return (
    <div className="task-view">
      <SuggestionArea />

      {editing !== null ? (
        <TaskEditor
          task={editing === 'new' ? null : selected}
          onSave={async (title, note) => {
            if (editing === 'new') {
              await createTask(title, note)
            } else if (selected) {
              await updateTask(selected.id, { title, note })
            }
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      ) : selected ? (
        <TaskDetail
          task={selected}
          onBack={() => setSelectedId(null)}
          onEdit={() => setEditing(selected.id)}
          onDeleteRequest={setConfirmDelete}
        />
      ) : (
        <TaskList
          tasks={tasks}
          onOpen={(task) => setSelectedId(task.id)}
          onCreate={() => setEditing('new')}
          onDeleteRequest={setConfirmDelete}
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
