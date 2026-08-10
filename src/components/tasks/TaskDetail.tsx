/**
 * TaskDetail — full task view: editable title/note, linked apps, resource
 * list (text preview / image thumbnail / file paths) with eviction placeholders.
 */
import { useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import { basename } from '../../lib/format'
import type { ResourceRef, TaskDto, TaskStatus } from '../../../shared/types'
import {
  ChevronLeftIcon,
  EditIcon,
  TrashIcon,
  FileIcon,
  ImageIcon,
  FolderOpenIcon,
  PauseIcon,
  ResumeIcon,
  CompleteIcon,
  RestoreIcon
} from '../icons'

interface Props {
  task: TaskDto
  onBack: () => void
  onEdit: () => void
  onDeleteRequest: (task: TaskDto) => void
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  active: 'groupActive',
  waiting: 'groupWaiting',
  paused: 'groupPaused',
  completed: 'groupCompleted'
}

function ResourceRow({ resource }: { resource: ResourceRef & { alive: boolean } }) {
  const { t } = useTranslation()
  const [imgFailed, setImgFailed] = useState(false)

  if (resource.kind === 'files') {
    return (
      <div className="task-resource">
        <div className="task-resource-head">
          <FolderOpenIcon width={13} height={13} />
          <span>{t('tasks.resourceCount', { count: resource.paths.length })}</span>
        </div>
        <div className="task-resource-files">
          {resource.paths.map((p) => (
            <div className="task-file-row" key={p} title={p}>
              <FileIcon width={11} height={11} />
              <span>{basename(p)}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const snapshot = resource.snapshot
  // imgFailed: the item can be evicted between the liveness push and render,
  // so a failed thumbnail also degrades to the dead placeholder.
  const dead = !resource.alive || imgFailed

  if (snapshot.type === 'text') {
    return (
      <div className={`task-resource${dead ? ' dead' : ''}`}>
        {dead && (
          <div className="task-dead-label">
            <span className="task-dead-dot" />
            {t('tasks.resourceDead')}
          </div>
        )}
        <div className="task-resource-text">{snapshot.preview}</div>
      </div>
    )
  }

  // image / image-collection
  if (snapshot.type !== 'image' && snapshot.type !== 'image-collection') return null
  return (
    <div className={`task-resource${dead ? ' dead' : ''}`}>
      {dead ? (
        <div className="task-resource-image-placeholder">
          <ImageIcon width={18} height={18} />
          <span className="task-dead-label">
            <span className="task-dead-dot" />
            {t('tasks.resourceDead')}
          </span>
        </div>
      ) : (
        <img
          className="task-resource-image"
          src={`tracelocal://${snapshot.imageId}`}
          alt={snapshot.preview}
          draggable={false}
          onError={() => setImgFailed(true)}
        />
      )}
      <div className="task-resource-summary">{snapshot.preview}</div>
    </div>
  )
}

export function TaskDetail({ task, onBack, onEdit, onDeleteRequest }: Props) {
  const { t } = useTranslation()
  const updateTask = useStore((s) => s.updateTask)

  const actions: { key: string; label: string; icon: JSX.Element; next: TaskStatus }[] = []
  if (task.status === 'active') {
    actions.push({ key: 'pause', label: t('tasks.pause'), icon: <PauseIcon width={13} height={13} />, next: 'paused' })
    actions.push({ key: 'complete', label: t('tasks.complete'), icon: <CompleteIcon width={13} height={13} />, next: 'completed' })
  } else if (task.status === 'paused' || task.status === 'waiting') {
    actions.push({ key: 'resume', label: t('tasks.resume'), icon: <ResumeIcon width={13} height={13} />, next: 'active' })
    actions.push({ key: 'complete', label: t('tasks.complete'), icon: <CompleteIcon width={13} height={13} />, next: 'completed' })
  } else {
    actions.push({ key: 'restore', label: t('tasks.restore'), icon: <RestoreIcon width={13} height={13} />, next: 'active' })
  }

  return (
    <div className="task-detail">
      <div className="task-detail-header">
        <button type="button" className="task-btn ghost" onClick={onBack}>
          <ChevronLeftIcon width={14} height={14} />
          {t('tasks.back')}
        </button>
        <span className={`task-status-pill ${task.status}`}>{t(`tasks.${STATUS_LABEL[task.status]}`)}</span>
        <button type="button" className="task-btn ghost" onClick={onEdit}>
          <EditIcon width={13} height={13} />
          {t('tasks.edit')}
        </button>
        <button type="button" className="task-btn ghost danger" onClick={() => onDeleteRequest(task)}>
          <TrashIcon width={13} height={13} />
          {t('tasks.delete')}
        </button>
      </div>

      <div className="task-detail-title">{task.title}</div>
      {task.note && <div className="task-detail-note">{task.note}</div>}

      {task.apps.length > 0 && (
        <div className="task-app-chips">
          {task.apps.map((a) => (
            <span className="task-app-chip" key={a.id} title={a.exePath ?? a.name}>
              {a.name}
            </span>
          ))}
        </div>
      )}

      <div className="task-resources-title">{t('tasks.resourcesTitle')}</div>
      {task.resources.length === 0 ? (
        <div className="task-empty">
          <div className="hint">{t('tasks.noResources')}</div>
        </div>
      ) : (
        <div className="task-resources">
          {task.resources.map((r, i) => (
            <ResourceRow key={`${r.kind}-${i}`} resource={r} />
          ))}
        </div>
      )}

      <div className="task-detail-actions">
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            className="task-btn primary"
            onClick={() => updateTask(task.id, { status: a.next })}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}
