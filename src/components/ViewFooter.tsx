/**
 * ViewFooter — the unified bottom toolbar of every content view
 * (user feedback 2026-08-14): item count + a per-view clear button +
 * the settings button, all on one row. The settings entry point moved
 * here from the header so every view offers it in the same place; the
 * settings sheet itself has no footer (nothing to clear there).
 *
 * The footer is rendered once by Panel, OUTSIDE the view-transition
 * AnimatePresence — switching views must not animate the toolbar itself
 * (user feedback 2026-08-14). Views report their footer data via
 * onFooterChange so the bar stays put while only the content animates.
 *
 * Destructive views (e.g. notes) can opt into a two-step confirm via
 * `confirmLabel`: the first click arms the button (solid red + confirm
 * label), the second click — while the mouse is still on the button —
 * executes. Leaving the button, or any change to the clear scope,
 * disarms again, so a stray click can never fire the action by itself.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../store/appStore'
import { useTranslation } from '../i18n'
import { TrashIcon, GearIcon } from './icons'
import { playButtonClickSound } from '../lib/soundEffects'

export interface ViewFooterState {
  /** Visible entries in the current view (drives count + clear disabled). */
  count: number
  /** Singular noun for the count, e.g. 'item' | 'task'. */
  noun: string
  /** Short button label (e.g. item.clear). */
  clearLabel: string
  /** Tooltip explaining exactly what this view's clear removes. */
  clearTitle: string
  onClear: () => void
  /** Override the disabled state (clear scope wider than the visible count,
   *  e.g. a search query narrows the list but clear still covers the type). */
  clearDisabled?: boolean
  /** Two-step confirm (destructive scopes): the first click turns the button
   *  into a red confirm button (label `confirmLabel`); a second click while
   *  the mouse is still on it executes. Leaving the button disarms. Absent =
   *  the clear executes on the first click. */
  confirmLabel?: string
  /** Tooltip shown while armed (e.g. 'click again to confirm'). */
  confirmTitle?: string
  /** Icon override for the clear button (e.g. an eraser for content-clearing
   *  views). Defaults to the trash icon. */
  clearIcon?: ReactNode
}

export function ViewFooter({
  count,
  noun,
  clearLabel,
  clearTitle,
  onClear,
  clearDisabled,
  confirmLabel,
  confirmTitle,
  clearIcon
}: ViewFooterState) {
  const { t } = useTranslation()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [armed, setArmed] = useState(false)

  // Disarm whenever the clear scope changes (view switch, count hitting
  // zero, label swap) — an armed confirm must never survive its context.
  useEffect(() => {
    setArmed(false)
  }, [clearLabel, clearTitle, confirmLabel, clearDisabled])

  const openSettings = (): void => {
    playButtonClickSound()
    const state = useStore.getState()
    const hasActiveFlyout = !!(state.previewItemId || state.styleFlyoutOpen)
    if (hasActiveFlyout) {
      state.setPreviewItemId(null)
      state.setStyleFlyoutOpen(false)
      setTimeout(() => {
        useStore.getState().setSettingsOpen(true)
      }, 220)
    } else {
      setSettingsOpen(true)
    }
  }

  const handleClearClick = (): void => {
    playButtonClickSound()
    if (confirmLabel !== undefined && !armed) {
      // First click of a two-step confirm: arm, don't execute.
      setArmed(true)
      return
    }
    setArmed(false)
    onClear()
  }

  return (
    <div className="footer">
      <span className="count">
        {count} {noun}
        {count === 1 ? '' : 's'}
      </span>
      <div className="spacer" />
      <button
        type="button"
        className={`text-btn danger${armed ? ' confirming' : ''}`}
        onClick={handleClearClick}
        onMouseLeave={() => setArmed(false)}
        disabled={clearDisabled ?? count === 0}
        title={armed ? (confirmTitle ?? clearTitle) : clearTitle}
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {clearIcon ?? <TrashIcon width={14} height={14} />}
        <span>{armed ? confirmLabel : clearLabel}</span>
      </button>
      <button
        type="button"
        className="icon-btn"
        title={t('header.settings')}
        onClick={openSettings}
        style={{
          color: 'rgba(255, 255, 255, 0.75)',
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
          flexShrink: 0,
          cursor: 'pointer',
          width: 30,
          height: 30,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 8,
          transition: 'all 0.15s ease'
        }}
      >
        <GearIcon width={16} height={16} />
      </button>
    </div>
  )
}
