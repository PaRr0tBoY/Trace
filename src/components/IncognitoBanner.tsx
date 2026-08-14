import { useStore } from '../store/appStore'
import { useTranslation } from '../i18n'

/**
 * Incognito notice (feedback): incognito silently stops clipboard capture, so
 * the banner renders only where clipboard content is shown — every clipboard
 * view tab and the files view's clipboard tab — with a one-click way back.
 * Same anatomy as the stale-cleanup banner (item.css).
 */
export function IncognitoBanner() {
  const { t } = useTranslation()
  const incognito = useStore((s) => s.settings.incognito)
  const tutorialStep = useStore((s) => s.tutorialStep)

  if (!incognito || tutorialStep > 0) return null
  return (
    <div className="stale-banner incognito-banner">
      <span className="stale-banner-text">{t('privacy.incognitoBanner')}</span>
      <button
        className="stale-banner-btn"
        onClick={(e) => {
          e.currentTarget.blur()
          void useStore.getState().patchSettings({ incognito: false })
        }}
      >
        {t('privacy.incognitoTurnOff')}
      </button>
    </div>
  )
}
