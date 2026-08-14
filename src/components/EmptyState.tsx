import { motion } from 'framer-motion'
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
  // 'extended' motion level eases the empty state in (fade + 8px rise).
  const extended = useStore((s) => s.settings.motionLevel) === 'extended'

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
    <motion.div
      className="empty"
      initial={extended ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="empty-text">
        <div className="big">{title}</div>
        <div className="hint">{hint}</div>
      </div>
    </motion.div>
  )
}
