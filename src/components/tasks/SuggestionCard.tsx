/**
 * SuggestionCard — one task suggestion (t19), compact two-row card (t23).
 *
 * Line 1: title (+ low-confidence badge). Line 2: app icons and the
 * clipboard material copied during the segment (isomorphic with a task's
 * resources) on the left, three icon actions on the right. Clicking the
 * card opens the convert panel (TaskEditor in suggestion mode) where the
 * "why" lives — the card itself carries no expandable detail. Everything
 * delegates to main — the card is a view of the pushed `state:suggestions`
 * payload.
 */
import { useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import { basename } from '../../lib/format'
import type { ResourceRef, Suggestion } from '../../../shared/types'
import { CheckIcon, EditIcon, CloseIcon, FileIcon, ImageIcon, SparklesIcon } from '../icons'
import { acceptSuggestionDrop } from './dropActions'

interface Props {
  suggestion: Suggestion
  /** Open the convert panel for this suggestion (absent in drop surfaces). */
  onOpen?: (id: string) => void
}

const MAX_APPS = 5
const MAX_CHIPS = 3

/** Short chip label for one clipboard ref (the task-detail preview shape). */
function chipLabel(ref: ResourceRef): string {
  if (ref.kind === 'files') return ref.paths.length > 1 ? `${basename(ref.paths[0])} +${ref.paths.length - 1}` : basename(ref.paths[0])
  if (ref.snapshot.type === 'text') return ref.snapshot.preview.slice(0, 24)
  return ref.snapshot.preview
}

export function SuggestionCard({ suggestion, onOpen }: Props) {
  const { t } = useTranslation()
  const acceptSuggestion = useStore((s) => s.acceptSuggestion)
  const ignoreSuggestion = useStore((s) => s.ignoreSuggestion)
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(new Set())
  /** Drop-hover highlight (t25): the whole card is a drop target. */
  const [over, setOver] = useState(false)

  const confirm = (): void => {
    void acceptSuggestion(suggestion.id)
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

  const allApps = (suggestion.appIcons ?? []).filter((app) => !brokenIcons.has(app.iconUrl))
  const apps = allApps.slice(0, MAX_APPS)
  const overflowApps = allApps.slice(MAX_APPS)
  const chips = (suggestion.clipboardRefs ?? []).slice(0, MAX_CHIPS)
  const chipOverflow = (suggestion.clipboardRefs?.length ?? 0) - chips.length

  return (
    <div
      className={`task-suggestion-card${over ? ' drop-over' : ''}`}
      data-drop-suggestion-id={suggestion.id}
      onClick={() => onOpen?.(suggestion.id)}
      title={onOpen ? t('tasks.openDetail') : undefined}
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
        <div className="task-suggestion-title">{suggestion.title}</div>
        {suggestion.lowConfidence && (
          <span className="task-suggestion-low">{t('tasks.suggestionLowConfidence')}</span>
        )}
      </div>

      <div className="task-suggestion-row">
        <div className="task-suggestion-apps">
          {apps.length > 0 ? (
            <>
              {apps.map((app, i) => (
                <img
                  key={`${app.name}:${app.iconUrl}:${i}`}
                  className="task-suggestion-app"
                  src={app.iconUrl}
                  alt=""
                  draggable={false}
                  onError={() => setBrokenIcons((prev) => new Set(prev).add(app.iconUrl))}
                />
              ))}
              {overflowApps.length > 0 && (
                <span className="task-app-icons-more" title={overflowApps.map((a) => a.name).join(', ')}>
                  +{overflowApps.length}
                </span>
              )}
            </>
          ) : (
            <span className="task-suggestion-apps-empty" title={suggestion.appNames.join(', ')}>
              <SparklesIcon width={12} height={12} />
            </span>
          )}
        </div>

        <div className="task-suggestion-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="task-suggestion-action accept"
            title={t('tasks.suggestionAccept')}
            onClick={confirm}
          >
            <CheckIcon width={14} height={14} />
          </button>
          <button
            type="button"
            className="task-suggestion-action"
            title={t('tasks.suggestionEdit')}
            onClick={() => onOpen?.(suggestion.id)}
          >
            <EditIcon width={13} height={13} />
          </button>
          <button
            type="button"
            className="task-suggestion-action danger"
            title={t('tasks.suggestionIgnore')}
            onClick={() => {
              void ignoreSuggestion(suggestion.id)
            }}
          >
            <CloseIcon width={13} height={13} />
          </button>
        </div>
      </div>

      {chips.length > 0 && (
        <div className="task-suggestion-chips">
          {chips.map((ref, i) => (
            <span
              key={ref.kind === 'files' ? `f${i}` : ref.itemId}
              className="task-suggestion-chip"
              title={chipLabel(ref)}
            >
              {ref.kind === 'files' ? (
                <FileIcon width={10} height={10} />
              ) : ref.snapshot.type !== 'text' ? (
                <ImageIcon width={10} height={10} />
              ) : null}
              {chipLabel(ref)}
            </span>
          ))}
          {chipOverflow > 0 && <span className="task-suggestion-chip-more">+{chipOverflow}</span>}
        </div>
      )}
    </div>
  )
}
