/** Panel header: title + settings toggle. */
import { motion } from 'framer-motion'
import { useStore } from '../store/appStore'
import { GearIcon, CloseIcon, InfoIcon, TaskIcon } from './icons'
import { playButtonClickSound } from '../lib/soundEffects'
import { taskBadgeCount } from '../lib/taskGroups'

import { useTranslation } from '../i18n'

export function Header() {
  const { t } = useTranslation()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const settingsSubView = useStore((s) => s.settingsSubView)
  const setSettingsSubView = useStore((s) => s.setSettingsSubView)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const currentVersion = useStore((s) => s.currentVersion)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const tasks = useStore((s) => s.tasks)
  const suggestions = useStore((s) => s.suggestions)
  const badge = taskBadgeCount(tasks)

  const isChangelogUnread = settingsOpen && (
    !settings.lastSeenChangelogVersion ||
    (currentVersion && settings.lastSeenChangelogVersion !== currentVersion && settings.lastSeenChangelogVersion !== `v${currentVersion}`)
  )

  const handleOpenChangelog = () => {
    if (settingsSubView === 'changelog') {
      setSettingsSubView('main')
    } else {
      setSettingsSubView('changelog')
      if (currentVersion) {
        patchSettings({ lastSeenChangelogVersion: currentVersion })
      }
    }
  }

  const typeFilter = useStore((s) => s.typeFilter)
  const setTypeFilter = useStore((s) => s.setTypeFilter)

  const FILTERS: { id: import('../../shared/types').TypeFilter; label: string }[] = [
    { id: 'all', label: t('filters.all') },
    { id: 'text', label: t('filters.text') },
    { id: 'links', label: t('filters.links') },
    { id: 'images', label: t('filters.images') },
    { id: 'files', label: t('filters.files') }
  ]

  const activeIndex = Math.max(0, FILTERS.findIndex((f) => f.id === typeFilter))
  const maxFilterLen = Math.max(...FILTERS.map((f) => f.label.length))
  const filterChipWidth = 37
  const filterFontSize = maxFilterLen >= 8 ? 7.8 : maxFilterLen >= 6 ? 8.5 : maxFilterLen >= 5 ? 9.2 : 10.2
  const filterLetterSpacing = maxFilterLen >= 7 ? '-0.025em' : maxFilterLen >= 5 ? '-0.015em' : '0'

  return (
    <div className="header" style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center', height: 40, padding: '0 10px 0 4px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 2, minWidth: 0, flex: 1, overflow: 'hidden' }}>
        {settingsOpen ? (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#8e8e93', letterSpacing: '0.01em', paddingLeft: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>
            {settingsSubView === 'changelog' ? t('header.whatsNew') : t('header.settings')}
          </span>
        ) : view === 'tasks' ? (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#8e8e93', letterSpacing: '0.01em', paddingLeft: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>
            {t('tasks.viewTitle')}
          </span>
        ) : (
          <div 
            className="filter-segmented-track" 
            style={{ 
              position: 'relative',
              display: 'flex', 
              alignItems: 'center', 
              background: 'rgba(255, 255, 255, 0.05)', 
              border: '1px solid rgba(255, 255, 255, 0.09)', 
              borderRadius: 999, 
              padding: '2px 3px', 
              gap: 2, 
              marginLeft: 2,
              boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
              maxWidth: '100%',
              overflow: 'hidden'
            }}
          >
            {/* Single Persistent Sliding Pill Indicator */}
            <motion.div
              initial={false}
              animate={{ x: activeIndex * (filterChipWidth + 2) }}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              style={{
                position: 'absolute',
                left: 3,
                top: 2,
                width: filterChipWidth,
                height: 22,
                borderRadius: 999,
                background: 'rgba(255, 255, 255, 0.16)',
                border: '1px solid rgba(255, 255, 255, 0.22)',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
                pointerEvents: 'none',
                zIndex: 0
              }}
            />

            {FILTERS.map((f) => {
              const active = typeFilter === f.id
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`filter-chip${active ? ' active' : ''}`}
                  onClick={() => {
                    playButtonClickSound()
                    setTypeFilter(f.id)
                  }}
                  style={{
                    position: 'relative',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: filterChipWidth,
                    height: 22,
                    padding: '0 1px',
                    fontSize: filterFontSize,
                    letterSpacing: filterLetterSpacing,
                    fontWeight: active ? 600 : 500,
                    color: active ? '#ffffff' : 'rgba(255, 255, 255, 0.65)',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 999,
                    cursor: 'pointer',
                    userSelect: 'none',
                    transition: 'color 0.18s ease',
                    zIndex: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden'
                  }}
                >
                  <span>{f.label}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, paddingRight: 2 }}>
        {settingsOpen && (
          <button
            type="button"
            className={`icon-btn${settingsSubView === 'changelog' ? ' active' : ''}`}
            title={settingsSubView === 'changelog' ? t('tabs.behaviour') : t('header.whatsNew')}
            onClick={() => {
              playButtonClickSound()
              handleOpenChangelog()
            }}
            style={{
              color: settingsSubView === 'changelog' ? '#ffffff' : 'rgba(255, 255, 255, 0.75)',
              background: settingsSubView === 'changelog' ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
              border: 'none',
              boxShadow: 'none',
              flexShrink: 0,
              cursor: 'pointer',
              width: 32,
              height: 32,
              display: 'grid',
              placeItems: 'center',
              position: 'relative',
              borderRadius: 8,
              transition: 'all 0.15s ease'
            }}
          >
            <InfoIcon width={16} height={16} />
            {isChangelogUnread && (
              <span
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: '#ffffff',
                  boxShadow: '0 0 6px rgba(255, 255, 255, 0.6)',
                  border: '1.5px solid #000000',
                  pointerEvents: 'none'
                }}
              />
            )}
          </button>
        )}

        {!settingsOpen && (
          <button
            type="button"
            className={`icon-btn${view === 'tasks' ? ' active' : ''}`}
            title={view === 'tasks' ? t('tasks.back') : t('tasks.viewTitle')}
            onClick={() => {
              playButtonClickSound()
              if (view === 'tasks') {
                setView('clipboard')
                return
              }
              // Leave the shelf cleanly: no item preview / style flyout may
              // linger over the task layer.
              const state = useStore.getState()
              state.setPreviewItemId(null)
              state.setStyleFlyoutOpen(false)
              setView('tasks')
            }}
            style={{
              color: view === 'tasks' ? '#ffffff' : 'rgba(255, 255, 255, 0.75)',
              background: view === 'tasks' ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
              border: 'none',
              boxShadow: 'none',
              flexShrink: 0,
              cursor: 'pointer',
              width: 32,
              height: 32,
              display: 'grid',
              placeItems: 'center',
              position: 'relative',
              borderRadius: 8,
              transition: 'all 0.15s ease'
            }}
          >
            <TaskIcon width={16} height={16} />
            {badge > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  minWidth: 13,
                  height: 13,
                  padding: '0 3px',
                  borderRadius: 999,
                  backgroundColor: '#f87171',
                  color: '#000000',
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: '13px',
                  textAlign: 'center',
                  boxShadow: '0 0 6px rgba(0, 0, 0, 0.5)',
                  pointerEvents: 'none'
                }}
              >
                {badge > 9 ? '9+' : badge}
              </span>
            )}
            {suggestions.length > 0 && (
              <span
                title={t('tasks.suggestionBadge', { count: suggestions.length })}
                style={{
                  position: 'absolute',
                  bottom: 4,
                  right: 4,
                  minWidth: 13,
                  height: 13,
                  padding: '0 3px',
                  borderRadius: 999,
                  backgroundColor: '#fbbf24',
                  color: '#000000',
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: '13px',
                  textAlign: 'center',
                  boxShadow: '0 0 6px rgba(0, 0, 0, 0.5)',
                  pointerEvents: 'none'
                }}
              >
                {suggestions.length > 9 ? '9+' : suggestions.length}
              </span>
            )}
          </button>
        )}

        <button
          type="button"
          className={`icon-btn${settingsOpen ? ' active' : ''}`}
          title={settingsOpen ? t('header.close') : t('header.settings')}
          onClick={() => {
            playButtonClickSound()
            if (settingsOpen) {
              setSettingsOpen(false)
              setSettingsSubView('main')
              return
            }
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
          }}
          style={{
            color: '#ffffff',
            background: 'transparent',
            border: 'none',
            boxShadow: 'none',
            flexShrink: 0,
            cursor: 'pointer',
            width: 32,
            height: 32,
            display: 'grid',
            placeItems: 'center',
            position: 'relative'
          }}
        >
          {settingsOpen ? <CloseIcon /> : <GearIcon />}
        </button>
      </div>
    </div>
  )
}
