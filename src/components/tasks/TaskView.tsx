/**
 * TaskView — the task layer root inside the panel.
 *
 * Two second-level tabs (ADR-0004): "existing tasks" (the grouped task list,
 * completed last) and "candidate tasks" (suggestion cards). Detail and
 * create/edit forms are full-page sub-views, and the suggestion convert
 * panel (TaskEditor in suggestion mode) is one too — same structure as
 * create/edit, closed loop: edit + convert in place. Delete is always a
 * confirmed hard delete. Navigation state lives in the store so the
 * restore mechanism (ADR-0004) can remember/reset it and edit protection
 * can see it; the convert panel is a local edit session.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { TaskDto } from '../../../shared/types'
import { TaskList } from './TaskList'
import { TaskDetail } from './TaskDetail'
import { TaskEditor } from './TaskEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { ContentPicker } from './ContentPicker'
import { TaskProposalCard } from './TaskProposalCard'
import { TracePanel } from './TracePanel'
import type { ViewFooterState } from '../ViewFooter'

/** Which "AI 依据" chain the shared TracePanel is showing (t42). */
type TraceTarget = { kind: 'proposal'; id: string } | { kind: 'task'; id: string } | null

interface Props {
  /** Report this view's footer state up to Panel (the toolbar lives outside
   *  the view-transition animation and is rendered once, at Panel level). */
  onFooterChange: (footer: ViewFooterState | null) => void
}

export function TaskView({ onFooterChange }: Props) {
  const { t } = useTranslation()
  const tasks = useStore((s) => s.tasks)
  const suggestions = useStore((s) => s.suggestions)
  const tasksFilter = useStore((s) => s.tasksFilter)
  const createTask = useStore((s) => s.createTask)
  const updateTask = useStore((s) => s.updateTask)
  const deleteTask = useStore((s) => s.deleteTask)
  const acceptSuggestion = useStore((s) => s.acceptSuggestion)

  const selectedId = useStore((s) => s.selectedTaskId)
  const setSelectedTaskId = useStore((s) => s.setSelectedTaskId)
  const editing = useStore((s) => s.editingTask)
  const setEditingTask = useStore((s) => s.setEditingTask)
  const confirmDeleteTaskId = useStore((s) => s.confirmDeleteTaskId)
  const setConfirmDeleteTaskId = useStore((s) => s.setConfirmDeleteTaskId)
  const pickerTaskId = useStore((s) => s.pickerTaskId)
  const setPickerTaskId = useStore((s) => s.setPickerTaskId)
  /** TaskProposal whose convert panel is open (null = closed). */
  const [convertId, setConvertId] = useState<string | null>(null)
  /** "AI 依据" panel target (shared TracePanel, t42). */
  const [traceTarget, setTraceTarget] = useState<TraceTarget>(null)

  const selected = selectedId ? (tasks.find((task) => task.id === selectedId) ?? null) : null
  const converting = convertId ? (suggestions.find((s) => s.id === convertId) ?? null) : null
  const confirmDelete = confirmDeleteTaskId ? (tasks.find((task) => task.id === confirmDeleteTaskId) ?? null) : null
  /** L1 主动建议（t47 分级展示）：任务列表顶部固定区，位于状态分组之前。 */
  const l1Suggestions = suggestions.filter((s) => s.level === 1)

  // The selected task vanished (deleted here or elsewhere): fall back to the list.
  useEffect(() => {
    if (selectedId && !selected) {
      setSelectedTaskId(null)
      const s = useStore.getState()
      if (s.editingTask !== null && s.editingTask !== 'new') s.setEditingTask(null)
    }
  }, [selectedId, selected, setSelectedTaskId])

  // A new analysis replaced the pending list: close the convert panel too.
  useEffect(() => {
    if (convertId && !converting) setConvertId(null)
  }, [convertId, converting])

  // Switching the secondary tab (existing/candidates) returns to that tab's
  // list — no task sub-view (detail, editor, convert, picker, delete
  // confirm, trace) may linger across the switch (ref guard: the effect
  // must not fire on mount, where a kept sub-view is a deliberate restore).
  const prevTasksFilter = useRef(tasksFilter)
  useEffect(() => {
    if (prevTasksFilter.current !== tasksFilter) {
      prevTasksFilter.current = tasksFilter
      setSelectedTaskId(null)
      setEditingTask(null)
      setConvertId(null)
      setPickerTaskId(null)
      setConfirmDeleteTaskId(null)
      setTraceTarget(null)
    }
  }, [tasksFilter, setSelectedTaskId, setEditingTask, setPickerTaskId, setConfirmDeleteTaskId])

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    await deleteTask(confirmDelete.id)
    if (selectedId === confirmDelete.id) setSelectedTaskId(null)
    if (editing === confirmDelete.id) setEditingTask(null)
    setConfirmDeleteTaskId(null)
  }

  /**
   * Per-tab clear (user feedback 2026-08-14): the existing-tasks tab wipes
   * every task, the candidates tab dismisses every suggestion — never the
   * other tab's content.
   */
  const clearCurrentTab = useCallback((): void => {
    const state = useStore.getState()
    if (tasksFilter === 'candidates') {
      void (async () => {
        for (const s of state.suggestions) {
          await state.ignoreSuggestion(s.id)
        }
      })()
    } else {
      void (async () => {
        for (const task of state.tasks) {
          await state.deleteTask(task.id)
        }
      })()
    }
  }, [tasksFilter])

  // Footer data, hoisted so the shared toolbar (rendered by Panel outside
  // the view-transition animation) gets it before the browser paints.
  useLayoutEffect(() => {
    onFooterChange({
      count: tasksFilter === 'candidates' ? suggestions.length : tasks.length,
      noun: 'task',
      clearLabel: t('item.clear'),
      clearTitle: tasksFilter === 'candidates' ? t('tasks.dismissAll') : t('tasks.clearAll'),
      confirmLabel: t('item.confirmClear'),
      confirmTitle: t('item.confirmClearTitle'),
      onClear: clearCurrentTab
    })
  }, [tasksFilter, suggestions.length, tasks.length, clearCurrentTab, onFooterChange, t])

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
            setEditingTask(null)
          }}
          onCancel={() => setEditingTask(null)}
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
          onBack={() => setSelectedTaskId(null)}
          onEdit={() => setEditingTask(selected.id)}
          onDeleteRequest={(task) => setConfirmDeleteTaskId(task.id)}
          onAddContent={() => setPickerTaskId(selected.id)}
          onTrace={() => setTraceTarget({ kind: 'task', id: selected.id })}
        />
      ) : (
        <div className="task-scroll">
          {tasksFilter === 'candidates' ? (
            suggestions.length > 0 ? (
              <div className="task-suggest-list">
                {suggestions.map((s) => (
                  <TaskProposalCard
                    key={s.id}
                    suggestion={s}
                    onOpen={setConvertId}
                    onTrace={(id) => setTraceTarget({ kind: 'proposal', id })}
                  />
                ))}
              </div>
            ) : (
              <div className="task-empty">
                <div className="title">{t('tasks.candidatesEmpty')}</div>
                <div className="hint">{t('tasks.candidatesEmptyHint')}</div>
              </div>
            )
          ) : (
            <>
              {l1Suggestions.length > 0 && (
                <section className="task-group task-group-l1">
                  <div className="task-group-label">
                    <span>{t('tasks.activeSuggestions')}</span>
                    <span className="task-group-count">{l1Suggestions.length}</span>
                  </div>
                  {l1Suggestions.map((s) => (
                    <TaskProposalCard
                      key={s.id}
                      suggestion={s}
                      onOpen={setConvertId}
                      onTrace={(id) => setTraceTarget({ kind: 'proposal', id })}
                    />
                  ))}
                </section>
              )}
              <TaskList
                tasks={tasks}
                onOpen={(task) => setSelectedTaskId(task.id)}
                onCreate={() => setEditingTask('new')}
                onDeleteRequest={(task) => setConfirmDeleteTaskId(task.id)}
              />
            </>
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

      {traceTarget && (
        <TracePanel
          decisionId={traceTarget.kind === 'proposal' ? traceTarget.id : undefined}
          taskId={traceTarget.kind === 'task' ? traceTarget.id : undefined}
          onClose={() => setTraceTarget(null)}
        />
      )}
    </div>
  )
}

export type { TaskDto }
