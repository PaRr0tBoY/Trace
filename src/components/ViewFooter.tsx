/**
 * ViewFooter — the unified bottom toolbar of every content view
 * (user feedback 2026-08-14): item count + a per-view clear button +
 * the settings button, all on one row. The settings entry point moved
 * here from the header so every view offers it in the same place; the
 * settings sheet itself has no footer (nothing to clear there).
 */
import { useStore } from '../store/appStore'
import { useTranslation } from '../i18n'
import { TrashIcon, GearIcon } from './icons'
import { playButtonClickSound } from '../lib/soundEffects'

interface Props {
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
}

export function ViewFooter({ count, noun, clearLabel, clearTitle, onClear, clearDisabled }: Props) {
  const { t } = useTranslation()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

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

  return (
    <div className="footer">
      <span className="count">
        {count} {noun}
        {count === 1 ? '' : 's'}
      </span>
      <div className="spacer" />
      <button
        type="button"
        className="text-btn danger"
        onClick={() => {
          playButtonClickSound()
          onClear()
        }}
        disabled={clearDisabled ?? count === 0}
        title={clearTitle}
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <TrashIcon width={14} height={14} />
        <span>{clearLabel}</span>
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
