/**
 * TaskCard — one row in the grouped task list.
 *
 * Row actions are the manual lifecycle controls (pause/resume, complete,
 * restore, hard delete). Clicking the card body opens the detail view.
 */
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import { relativeTime, previewText } from '../../lib/format'
import type { TaskDto, TaskStatus } from '../../../shared/types'
import { PauseIcon, ResumeIcon, CompleteIcon, RestoreIcon, TrashIcon } from '../icons'

interface Props {
  task: TaskDto
  onOpen: (task: TaskDto) => void
  onDeleteRequest: (task: TaskDto) => void
}

export function TaskCard({ task, onOpen, onDeleteRequest }: Props) {
  const { t } = useTranslation()
  const updateTask = useStore((s) => s.updateTask)

  const apps = task.apps
  const appNames = apps.slice(0, 3).map((a) => a.name)
  const moreApps = apps.length > 3 ? apps.length - 3 : 0

  const meta: string[] = []
  if (task.resources.length > 0) {
    meta.push(t('tasks.resourceCount', { count: task.resources.length }))
  }
  if (appNames.length > 0) {
    meta.push(moreApps > 0 ? `${appNames.join(' · ')} +${moreApps}` : appNames.join(' · '))
  }

  const statusAction = (status: TaskStatus): { key: string; label: string; icon: JSX.Element; next: TaskStatus } | null => {
    switch (status) {
      case 'active':
        return { key: 'pause', label: t('tasks.pause'), icon: <PauseIcon width={13} height={13} />, next: 'paused' }
      case 'paused':
      case 'waiting':
        return { key: 'resume', label: t('tasks.resume'), icon: <ResumeIcon width={13} height={13} />, next: 'active' }
      case 'completed':
        return { key: 'restore', label: t('tasks.restore'), icon: <RestoreIcon width={13} height={13} />, next: 'active' }
    }
  }

  const action = statusAction(task.status)
  const canComplete = task.status !== 'completed'

  return (
    <div
      className={`task-card ${task.status}`}
      onClick={() => onOpen(task)}
      title={t('tasks.openDetail')}
    >
      <div className="task-card-main">
        <span className={`task-status-dot ${task.status}`} />
        <div className="task-card-body">
          <div className="task-title">{task.title}</div>
          {task.note && <div className="task-note">{previewText(task.note, 80)}</div>}
          {task.status === 'active' && (
            <div className="task-time">{t('tasks.activeAt', { time: relativeTime(task.lastActiveAt) })}</div>
          )}
          {meta.length > 0 && <div className="task-meta">{meta.join(' · ')}</div>}
        </div>
        <div className="task-actions" onClick={(e) => e.stopPropagation()}>
          {action && (
            <button
              type="button"
              className="task-action-btn"
              title={action.label}
              onClick={() => updateTask(task.id, { status: action!.next })}
            >
              {action.icon}
            </button>
          )}
          {canComplete && (
            <button
              type="button"
              className="task-action-btn"
              title={t('tasks.complete')}
              onClick={() => updateTask(task.id, { status: 'completed' })}
            >
              <CompleteIcon width={13} height={13} />
            </button>
          )}
          <button
            type="button"
            className="task-action-btn danger"
            title={t('tasks.delete')}
            onClick={() => onDeleteRequest(task)}
          >
            <TrashIcon width={13} height={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
