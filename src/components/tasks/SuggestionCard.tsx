/**
 * SuggestionCard — one AI task suggestion (t19).
 *
 * Interactive surface for the suggestion lifecycle: editable title, app
 * chips, confidence (+ "needs review" flag for the low zone), expandable
 * reason (algorithm evidence + optional LLM rationale) and the three
 * actions. [确认] accepts with the current title, [编辑] swaps the title
 * into an input (accept then carries the override), [忽略] writes the
 * signature into the local ignore table so this kind never resurfaces.
 * Everything delegates to main — the card is a view of the pushed
 * `state:suggestions` payload.
 */
import { useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { Suggestion } from '../../../shared/types'
import { CheckIcon, EditIcon, CloseIcon, ChevronDownIcon, ChevronUpIcon, SparklesIcon } from '../icons'

interface Props {
  suggestion: Suggestion
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

export function SuggestionCard({ suggestion }: Props) {
  const { t } = useTranslation()
  const acceptSuggestion = useStore((s) => s.acceptSuggestion)
  const ignoreSuggestion = useStore((s) => s.ignoreSuggestion)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(suggestion.title)
  const [expanded, setExpanded] = useState(false)

  const confirm = (): void => {
    const title = editing ? draft.trim() : ''
    void acceptSuggestion(suggestion.id, title || undefined)
  }

  const pct = Math.round(suggestion.confidence * 100)

  return (
    <div className="task-suggestion-card">
      <div className="task-suggestion-head">
        <div className="task-suggest-icon">
          <SparklesIcon width={13} height={13} />
        </div>
        {editing ? (
          <input
            className="task-suggestion-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
              if (e.key === 'Escape') setEditing(false)
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

      <div className="task-suggestion-meta">
        {suggestion.appNames.map((app) => (
          <span key={app} className="task-suggestion-chip">{app}</span>
        ))}
        <span className="task-suggestion-conf">
          {t('tasks.suggestionConfidence', { value: pct })}
        </span>
      </div>

      <div className="task-suggestion-dest">
        {suggestion.taskId ? t('tasks.suggestionMergeHint') : t('tasks.suggestionNewHint')}
      </div>

      <button
        type="button"
        className="task-suggestion-why"
        onClick={() => setExpanded((v) => !v)}
      >
        {t('tasks.suggestionReason')}
        {expanded ? <ChevronUpIcon width={12} height={12} /> : <ChevronDownIcon width={12} height={12} />}
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

      <div className="task-suggestion-actions">
        <button
          type="button"
          className="task-btn primary"
          onClick={confirm}
          disabled={editing && draft.trim().length === 0}
        >
          <CheckIcon width={12} height={12} />
          {editing ? t('tasks.save') : t('tasks.suggestionAccept')}
        </button>
        <button
          type="button"
          className="task-btn"
          onClick={() => {
            if (editing) {
              setDraft(suggestion.title)
              setEditing(false)
            } else {
              setDraft(suggestion.title)
              setEditing(true)
            }
          }}
        >
          {editing ? <CloseIcon width={12} height={12} /> : <EditIcon width={12} height={12} />}
          {editing ? t('tasks.cancel') : t('tasks.edit')}
        </button>
        <button
          type="button"
          className="task-btn danger"
          onClick={() => void ignoreSuggestion(suggestion.id)}
        >
          {t('tasks.suggestionIgnore')}
        </button>
      </div>
    </div>
  )
}
