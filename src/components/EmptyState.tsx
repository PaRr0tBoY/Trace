import { useStore } from '../store/appStore'
import { useTranslation } from '../i18n'

/**
 * Empty state for the clipboard/files views. The message follows the active
 * view + second level: an explicit filter ("No text clips yet"), a search
 * query ("No results"), or the plain shelf empty state.
 */
export function EmptyState({ filtered }: { filtered: boolean }) {
  const { t } = useTranslation()
  const view = useStore((s) => s.view)
  const clipboardFilter = useStore((s) => s.clipboardFilter)

  let title = filtered ? t('emptyState.noResultsFound') : t('emptyState.shelfEmpty')
  let hint = filtered ? t('emptyState.noResultsHint') : t('emptyState.shelfEmptyHint')

  const filter = view === 'clipboard' ? clipboardFilter : 'all'
  if (!filtered && view !== 'files' && filter !== 'all') {
    const labelKey = filter === 'text' ? 'emptyState.textClips' : filter === 'links' ? 'emptyState.links' : 'emptyState.images'
    const label = t(labelKey)
    title = t('emptyState.noClipsFound', { type: label })
    hint = t('emptyState.copyTypeHint', { type: label })
  } else if (!filtered && view === 'files') {
    title = t('emptyState.filesEmpty')
    hint = t('emptyState.filesEmptyHint')
  }

  return (
    <div className="empty">
      <div className="empty-text">
        <div className="big">{title}</div>
        <div className="hint">{hint}</div>
      </div>
    </div>
  )
}
