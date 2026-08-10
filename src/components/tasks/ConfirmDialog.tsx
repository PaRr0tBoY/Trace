/**
 * ConfirmDialog — small modal used for destructive confirmations (hard delete).
 * Rendered inside the task layer so it never escapes the blade.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslation } from '../../i18n'
import { TrashIcon } from '../icons'

interface Props {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, description, confirmLabel, onConfirm, onCancel }: Props) {
  const { t } = useTranslation()
  return (
    <AnimatePresence>
      <motion.div
        className="task-confirm-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onClick={onCancel}
      >
        <motion.div
          className="task-confirm-card"
          initial={{ scale: 0.94, opacity: 0, y: 6 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 4 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="task-confirm-title">{title}</div>
          <div className="task-confirm-desc">{description}</div>
          <div className="task-confirm-actions">
            <button type="button" className="task-btn" onClick={onCancel}>
              {t('tasks.cancel')}
            </button>
            <button
              type="button"
              className="task-btn danger"
              autoFocus
              onClick={() => {
                onConfirm()
              }}
            >
              <TrashIcon width={13} height={13} />
              {confirmLabel}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
