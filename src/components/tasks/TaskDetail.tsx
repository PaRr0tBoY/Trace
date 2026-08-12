/**
 * TaskDetail — full task view (t27): back + status pill on top, title with a
 * hover-revealed edit button, per-app rows (icon + name + open), recent
 * window titles, the resource list (text preview / image thumbnail / file
 * paths), and a confidence + creation-reason block. No OCR/algorithm raw.
 */
import { useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import { basename, formatDuration } from '../../lib/format'
import { taskStatusHintKey } from '../../lib/taskGroups'
import { useDragOut } from '../../hooks/useDragOut'
import { AppIcon } from './AppIcon'
import type { AppRef, ResourceRef, TaskDto, TaskSession, TaskStatus } from '../../../shared/types'
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
  RestoreIcon,
  ArchiveIcon,
  PlusIcon,
  InfoIcon
} from '../icons'

interface Props {
  task: TaskDto
  onBack: () => void
  onEdit: () => void
  onDeleteRequest: (task: TaskDto) => void
  onAddContent: () => void
  /** Open the shared AI-rationale panel for this task's adopted trace (t42). */
  onTrace?: () => void
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: 'groupRunning',
  waiting: 'groupWaiting',
  paused: 'groupPaused',
  completed: 'groupCompleted',
  archived: 'groupArchived'
}

/** Confidence floor below which the bar turns amber (settings θ_low, t27). */
const DEFAULT_CONFIDENCE_LOW = 0.45

/** Session settle reasons (spec 实现决策 4) -> i18n key; unknown reasons show raw. */
const SESSION_REASON_KEYS: Record<string, string> = {
  auto_switch: 'taskSession.reasonAutoSwitch',
  activity_lost: 'taskSession.reasonActivityLost',
  user_paused: 'taskSession.reasonUserPaused',
  user_completed: 'taskSession.reasonUserCompleted',
  user_archived: 'taskSession.reasonUserArchived',
  user_merged: 'taskSession.reasonUserMerged',
  user_deleted: 'taskSession.reasonUserDeleted'
}

/** Compact timestamp for a session boundary: "Jul 4, 09:30". */
function formatSessionTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** One session history row: time range + duration + reason + previous task. */
function SessionRow({ session, previousTitle }: { session: TaskSession; previousTitle?: string }) {
  const { t } = useTranslation()
  const open = session.endedAt === undefined
  return (
    <div className="task-session">
      <div className="task-session-head">
        <span className="task-session-time">
          {formatSessionTime(session.startedAt)} →{' '}
          {open ? (
            <span className="task-session-open">{t('taskSession.running')}</span>
          ) : (
            formatSessionTime(session.endedAt!)
          )}
        </span>
        <span className="task-session-duration">
          {formatDuration((session.endedAt ?? Date.now()) - session.startedAt)}
        </span>
      </div>
      {(session.transitionReason || previousTitle) && (
        <div className="task-session-meta">
          {session.transitionReason && (
            <span>{t(SESSION_REASON_KEYS[session.transitionReason] ?? session.transitionReason)}</span>
          )}
          {previousTitle && (
            <span>
              {t('taskSession.previousTask')}: {previousTitle}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ResourceRow({ resource }: { resource: ResourceRef & { alive: boolean } }) {
  const { t } = useTranslation()
  const [imgFailed, setImgFailed] = useState(false)
  const startDrag = useDragOut()
  const copy = useStore((s) => s.copy)
  const setInternalDragReq = useStore((s) => s.setInternalDragReq)
  const pushToast = useStore((s) => s.pushToast)

  const beginDrag = (e: React.DragEvent) => {
    e.preventDefault()
    if (resource.kind === 'files') {
      // File-list resource: drag the real paths; no shelf item behind it.
      setInternalDragReq({ id: '', paths: resource.paths })
      startDrag({ id: '', paths: resource.paths })
    } else {
      // Clipboard resource: OLE-drag the backing shelf item's content.
      setInternalDragReq({ id: resource.itemId })
      startDrag({ id: resource.itemId })
    }
  }

  const pinBack = () => {
    if (resource.kind !== 'clipboard') return
    void copy(resource.itemId)
    pushToast({ id: `pin-${Date.now()}`, message: t('tasks.pinBackToast'), tone: 'info' })
  }

  if (resource.kind === 'files') {
    return (
      <div
        className="task-resource"
        draggable
        onDragStart={beginDrag}
        onDragEnd={() => setInternalDragReq(null)}
        title={t('tasks.resourceHint')}
      >
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
      <div
        className={`task-resource${dead ? ' dead' : ' live'}`}
        draggable={!dead}
        onDragStart={beginDrag}
        onDragEnd={() => setInternalDragReq(null)}
        onClick={dead ? undefined : pinBack}
        title={dead ? undefined : t('tasks.resourceHint')}
      >
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
    <div
      className={`task-resource${dead ? ' dead' : ' live'}`}
      draggable={!dead}
      onDragStart={beginDrag}
      onDragEnd={() => setInternalDragReq(null)}
      onClick={dead ? undefined : pinBack}
      title={dead ? undefined : t('tasks.resourceHint')}
    >
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

function AppRow({ app, onOpen }: { app: AppRef; onOpen: (app: AppRef) => void }) {
  const { t } = useTranslation()
  const clickable = Boolean(app.exePath)
  return (
    <div
      className={`task-detail-app${clickable ? ' clickable' : ''}`}
      title={app.exePath ?? app.name}
      onClick={clickable ? () => onOpen(app) : undefined}
    >
      <AppIcon app={app} size={20} />
      <span className="task-detail-app-name">{app.name}</span>
      {clickable && (
        <button type="button" className="task-detail-app-open" tabIndex={-1}>
          {t('tasks.openApp')}
        </button>
      )}
    </div>
  )
}

export function TaskDetail({ task, onBack, onEdit, onDeleteRequest, onAddContent, onTrace }: Props) {
  const { t } = useTranslation()
  const updateTask = useStore((s) => s.updateTask)
  const tasks = useStore((s) => s.tasks)
  const confidenceLow = useStore((s) => s.settings.confidenceLow ?? DEFAULT_CONFIDENCE_LOW)

  const actions: { key: string; label: string; icon: JSX.Element; next: TaskStatus }[] = []
  if (task.status === 'running') {
    actions.push({ key: 'pause', label: t('tasks.pause'), icon: <PauseIcon width={13} height={13} />, next: 'paused' })
    actions.push({ key: 'complete', label: t('tasks.complete'), icon: <CompleteIcon width={13} height={13} />, next: 'completed' })
    actions.push({ key: 'archive', label: t('tasks.archive'), icon: <ArchiveIcon width={13} height={13} />, next: 'archived' })
  } else if (task.status === 'paused' || task.status === 'waiting') {
    actions.push({ key: 'resume', label: t('tasks.resume'), icon: <ResumeIcon width={13} height={13} />, next: 'running' })
    actions.push({ key: 'complete', label: t('tasks.complete'), icon: <CompleteIcon width={13} height={13} />, next: 'completed' })
    actions.push({ key: 'archive', label: t('tasks.archive'), icon: <ArchiveIcon width={13} height={13} />, next: 'archived' })
  } else if (task.status === 'completed') {
    actions.push({ key: 'restore', label: t('tasks.restore'), icon: <RestoreIcon width={13} height={13} />, next: 'running' })
    actions.push({ key: 'archive', label: t('tasks.archive'), icon: <ArchiveIcon width={13} height={13} />, next: 'archived' })
  } else {
    actions.push({ key: 'restore', label: t('tasks.restore'), icon: <RestoreIcon width={13} height={13} />, next: 'running' })
  }

  // Source-aware pill: "you paused this" (user PAUSED) vs "the system judged
  // it waiting" (WAITING) — plain group label otherwise.
  const pillKey = taskStatusHintKey(task) ?? STATUS_LABEL[task.status]

  const confidencePct =
    task.confidence === undefined ? undefined : Math.round(Math.min(1, Math.max(0, task.confidence)) * 100)
  const confidenceTone =
    task.confidence === undefined || task.confidence >= confidenceLow ? 'high' : 'low'
  const showMeta = confidencePct !== undefined || Boolean(task.reason)

  return (
    <div className="task-detail">
      <div className="task-detail-header">
        <button type="button" className="task-btn ghost" onClick={onBack}>
          <ChevronLeftIcon width={14} height={14} />
          {t('tasks.back')}
        </button>
        <span className={`task-status-pill ${task.status}`}>{t(`tasks.${pillKey}`)}</span>
        <button
          type="button"
          className="task-btn ghost danger task-detail-header-del"
          onClick={() => onDeleteRequest(task)}
          title={t('tasks.delete')}
        >
          <TrashIcon width={13} height={13} />
        </button>
      </div>

      <div className="task-detail-title-row">
        <div className="task-detail-title" title={task.title}>
          {task.title}
        </div>
        <button type="button" className="task-btn ghost task-detail-title-edit" onClick={onEdit} title={t('tasks.edit')}>
          <EditIcon width={14} height={14} />
        </button>
        {onTrace && (
          <button
            type="button"
            className="task-btn ghost task-detail-title-edit"
            onClick={onTrace}
            title={t('trace.entryLabel')}
          >
            <InfoIcon width={14} height={14} />
          </button>
        )}
      </div>
      {task.note && <div className="task-detail-note">{task.note}</div>}

      {task.apps.length > 0 && (
        <div className="task-detail-section">
          {task.apps.map((a) => (
            <AppRow
              key={a.id}
              app={a}
              onOpen={async (app) => {
                const res = await window.edge.openLinkedWindow(app)
                if (res.ok) {
                  useStore.getState().setOpen(false)
                  window.edge.setInteractive(false)
                }
              }}
            />
          ))}
        </div>
      )}

      {task.windowTitles.length > 0 && (
        <div className="task-detail-section">
          <div className="task-resources-title">{t('tasks.windowTitles')}</div>
          <div className="task-detail-windows">
            {task.windowTitles.map((w, i) => (
              <div className="task-detail-window" key={`${w}-${i}`} title={w}>
                <span className="task-window-dot" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="task-detail-section">
        <div className="task-resources-title">{t('taskSession.sectionTitle')}</div>
        {task.sessions.length === 0 ? (
          <div className="task-empty">
            <div className="hint">{t('taskSession.empty')}</div>
          </div>
        ) : (
          <div className="task-session-list">
            {task.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                previousTitle={
                  session.previousTaskId
                    ? tasks.find((t) => t.id === session.previousTaskId)?.title
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      <div className="task-detail-section">
        <div className="task-resources-head">
          <span className="task-resources-title">{t('tasks.resourcesTitle')}</span>
          <button type="button" className="task-btn ghost" onClick={onAddContent}>
            <PlusIcon width={12} height={12} />
            {t('tasks.addContent')}
          </button>
        </div>
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
      </div>

      {showMeta && (
        <div className="task-detail-section">
          {confidencePct !== undefined && (
            <div className="task-detail-conf">
              <span className="task-detail-conf-label">{t('tasks.confidence')}</span>
              <div className="task-detail-conf-track">
                <div className={`task-detail-conf-fill ${confidenceTone}`} style={{ width: `${confidencePct}%` }} />
              </div>
              <span className="task-detail-conf-value">{confidencePct}%</span>
            </div>
          )}
          {task.reason && (
            <>
              <div className="task-resources-title task-detail-block-title">{t('tasks.createdReason')}</div>
              <p className="task-detail-reason">{task.reason}</p>
            </>
          )}
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
