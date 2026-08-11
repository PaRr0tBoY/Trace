/**
 * TaskView — the task layer root inside the panel.
 *
 * Two second-level tabs (ADR-0004): "existing tasks" (the grouped task list,
 * completed last) and "candidate tasks" (suggestion cards). Detail and
 * create/edit forms are full-page sub-views. Delete is always a confirmed
 * hard delete. All navigation state lives in the store so the restore
 * mechanism (ADR-0004) can remember/reset it and edit protection can see it.
 */
import { useEffect } from 'react'
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
  const tasksFilter = useStore((s) => s.tasksFilter)
  const createTask = useStore((s) => s.createTask)
  const updateTask = useStore((s) => s.updateTask)
  const deleteTask = useStore((s) => s.deleteTask)

  const selectedId = useStore((s) => s.selectedTaskId)
  const setSelectedTaskId = useStore((s) => s.setSelectedTaskId)
  const editing = useStore((s) => s.editingTask)
  const setEditingTask = useStore((s) => s.setEditingTask)
  const confirmDeleteTaskId = useStore((s) => s.confirmDeleteTaskId)
  const setConfirmDeleteTaskId = useStore((s) => s.setConfirmDeleteTaskId)
  const pickerTaskId = useStore((s) => s.pickerTaskId)
  const setPickerTaskId = useStore((s) => s.setPickerTaskId)

  const selected = selectedId ? (tasks.find((task) => task.id === selectedId) ?? null) : null
  const confirmDelete = confirmDeleteTaskId ? (tasks.find((task) => task.id === confirmDeleteTaskId) ?? null) : null

  // The selected task vanished (deleted here or elsewhere): fall back to the list.
  useEffect(() => {
    if (selectedId && !selected) {
      setSelectedTaskId(null)
      const s = useStore.getState()
      if (s.editingTask !== null && s.editingTask !== 'new') s.setEditingTask(null)
    }
  }, [selectedId, selected, setSelectedTaskId])

  // The suggestion being edited vanished (accepted/ignored via any path,
  // including drag-drop): clear the flag so edit protection can't stick
  // forever (ADR-0004).
  const editingSuggestionId = useStore((s) => s.editingSuggestionId)
  const setEditingSuggestionId = useStore((s) => s.setEditingSuggestionId)
  useEffect(() => {
    if (editingSuggestionId && !suggestions.some((s) => s.id === editingSuggestionId)) {
      setEditingSuggestionId(null)
    }
  }, [editingSuggestionId, suggestions, setEditingSuggestionId])

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    await deleteTask(confirmDelete.id)
    if (selectedId === confirmDelete.id) setSelectedTaskId(null)
    if (editing === confirmDelete.id) setEditingTask(null)
    setConfirmDeleteTaskId(null)
  }

  return (
    <div className="task-view">
      {editing !== null ? (
        <TaskEditor
          task={editing === 'new' ? null : selected}
          onSave={async (title, note) => {
            if (editing === 'new') {
              await createTask(title, note)
            } else if (selected) {
              await updateTask(selected.id, { title, note })
            }
            setEditingTask(null)
          }}
          onCancel={() => setEditingTask(null)}
        />
      ) : selected ? (
        <TaskDetail
          task={selected}
          onBack={() => setSelectedTaskId(null)}
          onEdit={() => setEditingTask(selected.id)}
          onDeleteRequest={(task) => setConfirmDeleteTaskId(task.id)}
          onAddContent={() => setPickerTaskId(selected.id)}
        />
      ) : (
        <div className="task-scroll">
          {tasksFilter === 'candidates' ? (
            suggestions.length > 0 ? (
              <div className="task-suggest-list">
                {suggestions.map((s) => (
                  <SuggestionCard key={s.id} suggestion={s} />
                ))}
              </div>
            ) : (
              <div className="task-empty">
                <div className="title">{t('tasks.candidatesEmpty')}</div>
                <div className="hint">{t('tasks.candidatesEmptyHint')}</div>
              </div>
            )
          ) : (
            <TaskList
              tasks={tasks}
              onOpen={(task) => setSelectedTaskId(task.id)}
              onCreate={() => setEditingTask('new')}
              onDeleteRequest={(task) => setConfirmDeleteTaskId(task.id)}
            />
          )}
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
          onCancel={() => setConfirmDeleteTaskId(null)}
        />
      )}
    </div>
  )
}

export type { TaskDto }
