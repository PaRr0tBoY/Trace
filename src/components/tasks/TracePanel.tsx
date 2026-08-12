/**
 * TracePanel — shared "AI 依据" panel (t42, spec 实现决策 8).
 *
 * One component mounted from both the proposal card (decision chain by
 * decisionId) and the task detail (adopted trace by taskId). Shows the five
 * trace kinds (observed / recall / decision / result / privacy) with the
 * per-row version columns; privacy rows carry the "已被隐私政策过滤"
 * treatment. Developer export writes the full chain as an HTML report via
 * the main-side save dialog; the clear button deletes unadopted data only
 * (adopted trace lives with its task) and the panel refreshes in place.
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { TraceKind, TraceRecordDto } from '../../../shared/types'
import { CloseIcon, InfoIcon, TrashIcon, FileIcon } from '../icons'

interface Props {
  /** Proposal path: load one decision chain (observed → … → result). */
  decisionId?: string
  /** Task path: load the task's adopted trace rows. */
  taskId?: string
  onClose: () => void
}

const KIND_ORDER: TraceKind[] = ['observed', 'recall', 'decision', 'result', 'privacy']

/** Kind label key under `trace.*`. */
const KIND_KEY: Record<TraceKind, string> = {
  observed: 'trace.observed',
  recall: 'trace.recall',
  decision: 'trace.decision',
  result: 'trace.result',
  privacy: 'trace.privacy'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** One payload field row: key + value, with hit paths rendered as chains. */
function PayloadRow({ k, v }: { k: string; v: unknown }) {
  if (Array.isArray(v)) {
    return (
      <div className="trace-payload-row">
        <span className="trace-payload-key">{k}</span>
        <span className="trace-payload-value trace-hit-path">{v.map((x) => String(x)).join(' → ')}</span>
      </div>
    )
  }
  const text = v === null || v === undefined ? '—' : String(v)
  return (
    <div className="trace-payload-row">
      <span className="trace-payload-key">{k}</span>
      <span className={`trace-payload-value${typeof v === 'number' ? ' num' : ''}`}>{text}</span>
    </div>
  )
}

/** One trace row: kind + time, payload fields, per-row version chips. */
function TraceRow({ record }: { record: TraceRecordDto }) {
  const { t } = useTranslation()
  const blocked = record.kind === 'privacy'
  const payload = record.payload ?? {}
  return (
    <div className={`trace-row ${record.kind}${blocked ? ' blocked' : ''}`}>
      <div className="trace-row-head">
        <span className="trace-row-kind">{t(KIND_KEY[record.kind] ?? record.kind)}</span>
        <span className="trace-row-time">{formatTime(record.createdAt)}</span>
        {blocked && <span className="trace-privacy-badge">{t('trace.privacyBlocked')}</span>}
      </div>
      <div className="trace-payload">
        {Object.entries(payload).map(([k, v]) => (
          <PayloadRow key={k} k={k} v={v} />
        ))}
      </div>
      {(record.agentVersion || record.policyVersion || record.classifierVersion || record.promptVersion) && (
        <div className="trace-versions">
          {record.agentVersion && <span>{t('trace.agent')}: {record.agentVersion}</span>}
          {record.policyVersion && <span>{t('trace.policy')}: {record.policyVersion}</span>}
          {record.classifierVersion && <span>{t('trace.classifier')}: {record.classifierVersion}</span>}
          {record.promptVersion && <span>{t('trace.prompt')}: {record.promptVersion}</span>}
        </div>
      )}
    </div>
  )
}

export function TracePanel({ decisionId, taskId, onClose }: Props) {
  const { t } = useTranslation()
  const getTraceByDecision = useStore((s) => s.getTraceByDecision)
  const getTraceByTask = useStore((s) => s.getTraceByTask)
  const clearTrace = useStore((s) => s.clearTrace)
  const exportTraceReport = useStore((s) => s.exportTraceReport)
  const pushToast = useStore((s) => s.pushToast)

  const [records, setRecords] = useState<TraceRecordDto[] | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Bumped after clear so the panel refetches (adopted rows survive a global unadopted-only clear). */
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    setRecords(null)
    const load = async (): Promise<void> => {
      const rows = decisionId !== undefined ? await getTraceByDecision(decisionId) : await getTraceByTask(taskId ?? '')
      if (alive) setRecords(rows)
    }
    void load()
    return () => {
      alive = false
    }
  }, [decisionId, taskId, reloadKey, getTraceByDecision, getTraceByTask])

  const groups = useMemo(() => {
    if (!records) return []
    return KIND_ORDER.map((kind) => ({
      kind,
      rows: records.filter((r) => r.kind === kind)
    })).filter((g) => g.rows.length > 0)
  }, [records])

  const hasPrivacyBlock = records?.some((r) => r.kind === 'privacy') ?? false

  const handleClear = async (): Promise<void> => {
    setBusy(true)
    try {
      const removed = await clearTrace()
      setConfirmingClear(false)
      setReloadKey((k) => k + 1)
      pushToast({ id: `trace-clear-${Date.now()}`, message: t('trace.clearedToast', { count: removed }), tone: 'info' })
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    if (!records || records.length === 0) return
    setBusy(true)
    try {
      const path = await exportTraceReport(records)
      if (path) {
        pushToast({ id: `trace-export-${Date.now()}`, message: t('trace.exportToast'), tone: 'info' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="task-confirm-overlay" onClick={onClose}>
      <div className="trace-panel" onClick={(e) => e.stopPropagation()}>
        <div className="trace-panel-head">
          <div className="trace-panel-title">
            <InfoIcon width={14} height={14} />
            {t('trace.title')}
          </div>
          <button type="button" className="task-btn ghost" onClick={onClose} title={t('tasks.cancel')}>
            <CloseIcon width={13} height={13} />
          </button>
        </div>

        {records === null ? (
          <div className="trace-panel-body trace-empty">{t('trace.loading')}</div>
        ) : records.length === 0 ? (
          <div className="trace-panel-body trace-empty">
            <div className="trace-empty-title">{t('trace.empty')}</div>
            <div className="trace-empty-hint">{t('trace.emptyHint')}</div>
          </div>
        ) : (
          <>
            {hasPrivacyBlock && <div className="trace-privacy-note">{t('trace.privacyNote')}</div>}
            <div className="trace-panel-body">
              {groups.map((g) => (
                <div className="trace-group" key={g.kind}>
                  {g.rows.map((r) => (
                    <TraceRow key={r.id} record={r} />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="trace-panel-foot">
          {confirmingClear ? (
            <span className="trace-clear-confirm">
              <span className="trace-clear-confirm-text">{t('trace.clearConfirm')}</span>
              <button type="button" className="task-btn danger" disabled={busy} onClick={() => void handleClear()}>
                <TrashIcon width={12} height={12} />
                {t('trace.clearConfirmYes')}
              </button>
              <button type="button" className="task-btn ghost" disabled={busy} onClick={() => setConfirmingClear(false)}>
                {t('tasks.cancel')}
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="task-btn ghost"
                disabled={busy || (records?.length ?? 0) === 0}
                onClick={() => void handleExport()}
              >
                <FileIcon width={12} height={12} />
                {t('trace.export')}
              </button>
              <button
                type="button"
                className="task-btn ghost danger"
                disabled={busy}
                onClick={() => setConfirmingClear(true)}
              >
                <TrashIcon width={12} height={12} />
                {t('trace.clear')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
