/**
 * TaskCard — one row in the grouped task list.
 *
 * Line 1: status dot + title (full width, actions moved out). Line 2: app
 * icons + per-kind content badges on the left, row actions on the right.
 * The actions are hover-revealed but occupy their space always, so hovering
 * never shifts the layout. Clicking the card body opens the detail view.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import { relativeTime, previewText, formatDuration } from '../../lib/format'
import type { TaskDto, TaskStatus } from '../../../shared/types'
import {
  PauseIcon,
  ResumeIcon,
  CompleteIcon,
  RestoreIcon,
  TrashIcon,
  FileIcon,
  ImageIcon,
  FolderOpenIcon
} from '../icons'
import { AppIcon } from './AppIcon'

/** Max app icons shown on a card before collapsing into "+N". */
const MAX_APP_ICONS = 5

/** Content badge granularity: one entry per material kind. */
type ContentKind = 'text' | 'image' | 'files'

interface Props {
  task: TaskDto
  onOpen: (task: TaskDto) => void
  onDeleteRequest: (task: TaskDto) => void
}

/** Live clock so the running-time line ticks while the task is active. */
function useNowTick(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, active])
  return now
}

/** Map a resource reference to its content badge kind. */
function contentKindOf(resource: TaskDto['resources'][number]): ContentKind {
  if (resource.kind === 'files' || resource.snapshot.type === 'files') return 'files'
  if (resource.snapshot.type === 'image' || resource.snapshot.type === 'image-collection') return 'image'
  return 'text'
}

const CONTENT_ICONS: Record<ContentKind, JSX.Element> = {
  text: <FileIcon width={10} height={10} />,
  image: <ImageIcon width={10} height={10} />,
  files: <FolderOpenIcon width={10} height={10} />
}

export function TaskCard({ task, onOpen, onDeleteRequest }: Props) {
  const { t } = useTranslation()
  const updateTask = useStore((s) => s.updateTask)

  const apps = task.apps
  const visibleApps = apps.slice(0, MAX_APP_ICONS)
  const overflowApps = apps.slice(MAX_APP_ICONS)

  // Per-kind content counts replacing the old "N items" meta line.
  const counts = new Map<ContentKind, number>()
  for (const r of task.resources) {
    const kind = contentKindOf(r)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const contentBadges = (['text', 'image', 'files'] as const)
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind)! }))

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
  const now = useNowTick(30_000, task.status === 'active')

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
            <div className="task-time">
              {t('tasks.activeAt', { time: relativeTime(task.lastActiveAt) })} ·{' '}
              {t('tasks.runningTime', { duration: formatDuration(task.activeMs + (now - task.lastActiveAt)) })}
            </div>
          )}
          {task.status === 'paused' && task.activeMs > 0 && (
            <div className="task-time paused">
              {t('tasks.runningTime', { duration: formatDuration(task.activeMs) })}
            </div>
          )}
          <div className="task-card-footer">
            <div className="task-card-badges">
              {apps.length > 0 && (
                <div className="task-app-icons">
                  {visibleApps.map((a) => (
                    <AppIcon key={a.id} app={a} />
                  ))}
                  {overflowApps.length > 0 && (
                    <span className="task-app-icons-more" title={overflowApps.map((a) => a.name).join(', ')}>
                      +{overflowApps.length}
                    </span>
                  )}
                </div>
              )}
              {contentBadges.length > 0 && (
                <div className="task-content-badges">
                  {contentBadges.map(({ kind, count }) => (
                    <span key={kind} className="task-content-badge" title={t(`fileKinds.${kind}`)}>
                      {CONTENT_ICONS[kind]}
                      {count}
                    </span>
                  ))}
                </div>
              )}
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
      </div>
    </div>
  )
}
