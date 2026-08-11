/**
 * SuggestionCard — one AI task suggestion (t19), two-line layout (t23).
 *
 * Line 1: editable title (+ low-confidence badge). Line 2: app icons
 * (no names) on the left, three icon actions on the right. The "why"
 * toggle folds out the algorithm evidence + optional LLM rationale.
 * Everything delegates to main — the card is a view of the pushed
 * `state:suggestions` payload.
 */
import { useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { Suggestion } from '../../../shared/types'
import { CheckIcon, EditIcon, CloseIcon, ChevronDownIcon, ChevronUpIcon, SparklesIcon } from '../icons'
import { acceptSuggestionDrop } from './dropActions'

interface Props {
  suggestion: Suggestion
}

const MAX_APPS = 5

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

export function SuggestionCard({ suggestion }: Props) {
  const { t } = useTranslation()
  const acceptSuggestion = useStore((s) => s.acceptSuggestion)
  const ignoreSuggestion = useStore((s) => s.ignoreSuggestion)
  // Inline-edit flag lives in the store so the restore mechanism's edit
  // protection can see it (ADR-0004).
  const editing = useStore((s) => s.editingSuggestionId) === suggestion.id
  const setEditingSuggestionId = useStore((s) => s.setEditingSuggestionId)
  const [draft, setDraft] = useState(suggestion.title)
  const [expanded, setExpanded] = useState(false)
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(new Set())
  /** Drop-hover highlight (t25): the whole card is a drop target. */
  const [over, setOver] = useState(false)

  const confirm = (): void => {
    const title = editing ? draft.trim() : ''
    setEditingSuggestionId(null)
    void acceptSuggestion(suggestion.id, title || undefined)
  }

  /** Drop the in-panel drag onto the card: accept + bind in one main-side step. */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const req = useStore.getState().internalDragReq
    if (req) {
      useStore.getState().setInternalDragReq(null)
      void acceptSuggestionDrop(suggestion.id, req)
    }
    // OS file drops were routed by preload (trace-os-drop).
  }

  const apps = (suggestion.appIcons ?? [])
    .filter((app) => !brokenIcons.has(app.iconUrl))
    .slice(0, MAX_APPS)

  return (
    <div
      className={`task-suggestion-card${over ? ' drop-over' : ''}`}
      data-drop-suggestion-id={suggestion.id}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setOver(false)
      }}
      onDrop={onDrop}
    >
      <div className="task-suggestion-head">
        {editing ? (
          <input
            className="task-suggestion-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
              if (e.key === 'Escape') {
                setDraft(suggestion.title)
                setEditingSuggestionId(null)
              }
            }}
            autoFocus
            maxLength={80}
            spellCheck={false}
          />
        ) : (
          <div className="task-suggestion-title">{suggestion.title}</div>
        )}
        {suggestion.lowConfidence && (
          <span className="task-suggestion-low">{t('tasks.suggestionLowConfidence')}</span>
        )}
      </div>

      <div className="task-suggestion-row">
        <div className="task-suggestion-apps">
          {apps.length > 0 ? (
            apps.map((app, i) => (
              <img
                key={`${app.name}:${app.iconUrl}:${i}`}
                className="task-suggestion-app"
                src={app.iconUrl}
                alt=""
                draggable={false}
                onError={() => setBrokenIcons((prev) => new Set(prev).add(app.iconUrl))}
              />
            ))
          ) : (
            <span className="task-suggestion-apps-empty" title={suggestion.appNames.join(', ')}>
              <SparklesIcon width={12} height={12} />
            </span>
          )}
        </div>

        <div className="task-suggestion-actions">
          <button
            type="button"
            className="task-suggestion-action accept"
            title={t('tasks.suggestionAccept')}
            onClick={confirm}
            disabled={editing && draft.trim().length === 0}
          >
            <CheckIcon width={14} height={14} />
          </button>
          <button
            type="button"
            className="task-suggestion-action"
            title={editing ? t('tasks.cancel') : t('tasks.suggestionEdit')}
            onClick={() => {
              if (editing) {
                setDraft(suggestion.title)
                setEditingSuggestionId(null)
              } else {
                setDraft(suggestion.title)
                setEditingSuggestionId(suggestion.id)
              }
            }}
          >
            {editing ? <CloseIcon width={13} height={13} /> : <EditIcon width={13} height={13} />}
          </button>
          <button
            type="button"
            className="task-suggestion-action danger"
            title={t('tasks.suggestionIgnore')}
            onClick={() => {
              setEditingSuggestionId(null)
              void ignoreSuggestion(suggestion.id)
            }}
          >
            <CloseIcon width={13} height={13} />
          </button>
        </div>
      </div>

      <button
        type="button"
        className="task-suggestion-why"
        onClick={() => setExpanded((v) => !v)}
      >
        {t('tasks.suggestionReason')}
        {expanded ? <ChevronUpIcon width={11} height={11} /> : <ChevronDownIcon width={11} height={11} />}
      </button>

      {expanded && (
        <div className="task-suggestion-reason">
          <div className="task-suggestion-reason-block">
            <div className="task-suggestion-reason-label">{t('tasks.suggestionAlgorithm')}</div>
            <div className="task-suggestion-reason-text">{suggestion.algorithmReason}</div>
            <div className="task-suggestion-reason-evidence">
              {suggestion.evidence.appCombination} · {formatDuration(suggestion.evidence.durationMs)}
              {suggestion.evidence.overlappingTasks.length > 0 && (
                <> · {t('tasks.suggestionNearTasks', { titles: suggestion.evidence.overlappingTasks.join(', ') })}</>
              )}
            </div>
          </div>
          {suggestion.reason && (
            <div className="task-suggestion-reason-block">
              <div className="task-suggestion-reason-label">{t('tasks.suggestionAiReason')}</div>
              <div className="task-suggestion-reason-text">{suggestion.reason}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
