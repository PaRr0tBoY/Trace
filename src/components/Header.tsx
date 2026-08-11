/**
 * Panel header: two-row navigation (ADR-0004).
 *
 * Row 1: three top-level chips (clipboard / files / tasks) + right buttons.
 * Row 2: the active view's second level — clipboard (all/text/links/images),
 * files (all + dynamic extension tabs + other; hidden entirely when no file
 * entries exist), tasks (existing / candidates).
 *
 * Badges: the tasks top-level chip shows a red paused+waiting count (no
 * amber dot); the existing-tasks tab shows the same count, candidate-tasks
 * shows an amber dot when suggestions are pending.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store/appStore'
import { GearIcon, CloseIcon, InfoIcon } from './icons'
import { playButtonClickSound } from '../lib/soundEffects'
import { taskBadgeCount } from '../lib/taskGroups'
import { useFileMembers } from '../hooks/useFilteredItems'
import { useTranslation } from '../i18n'

/** Primary chips: centered in the 256px content area; 58px keeps the group
 * (184px) clear of the 34px right buttons (222px) with a 2px gap. */
const PRIMARY_CHIP_WIDTH = 58
const PRIMARY_GAP = 2
const TRACK_LEFT = 3

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
  const clipboardFilter = useStore((s) => s.clipboardFilter)
  const setClipboardFilter = useStore((s) => s.setClipboardFilter)
  const filesFilter = useStore((s) => s.filesFilter)
  const setFilesFilter = useStore((s) => s.setFilesFilter)
  const tasksFilter = useStore((s) => s.tasksFilter)
  const setTasksFilter = useStore((s) => s.setTasksFilter)
  const tasks = useStore((s) => s.tasks)
  const suggestions = useStore((s) => s.suggestions)
  const badge = taskBadgeCount(tasks)

  const files = useFileMembers()

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

  // Leaving the shelf cleanly: no item preview / style flyout may linger
  // over the task layer when switching top-level views.
  const leaveShelfFlyouts = () => {
    const state = useStore.getState()
    state.setPreviewItemId(null)
    state.setStyleFlyoutOpen(false)
  }

  const primaryViewIndex = view === 'clipboard' ? 0 : view === 'files' ? 1 : 2

  // Dynamic chip font: longest label across the row drives the size (the
  // 270px panel caps every row at ~200px; long labels ellipsize).
  const primaryMaxLen = Math.max(t('filters.clipboard').length, t('filters.files').length, t('filters.tasks').length)
  const primaryFontSize = primaryMaxLen >= 12 ? 7.5 : primaryMaxLen >= 9 ? 8.5 : primaryMaxLen >= 6 ? 9.5 : 10.5

  const primaryChipStyle = (active: boolean): React.CSSProperties => ({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: PRIMARY_CHIP_WIDTH,
    height: 22,
    padding: '0 1px',
    fontSize: primaryFontSize,
    letterSpacing: '0.01em',
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
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  })

  const secondaryChipStyle = (active: boolean): React.CSSProperties => ({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 1,
    minWidth: 0,
    height: 20,
    padding: '0 8px',
    fontSize: 9,
    letterSpacing: '0.01em',
    fontWeight: active ? 600 : 500,
    color: active ? '#ffffff' : 'rgba(255, 255, 255, 0.6)',
    background: active ? 'rgba(255, 255, 255, 0.16)' : 'transparent',
    border: active ? '1px solid rgba(255, 255, 255, 0.22)' : '1px solid transparent',
    borderRadius: 999,
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'color 0.18s ease, background 0.18s ease, border-color 0.18s ease',
    zIndex: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  })

  const redBadge = (count: number) => (
    <span
      style={{
        position: 'absolute',
        top: 1,
        right: 1,
        minWidth: 11,
        height: 11,
        padding: '0 2px',
        borderRadius: 999,
        backgroundColor: '#f87171',
        color: '#000000',
        fontSize: 8,
        fontWeight: 700,
        lineHeight: '11px',
        textAlign: 'center',
        boxShadow: '0 0 6px rgba(0, 0, 0, 0.5)',
        pointerEvents: 'none'
      }}
    >
      {count > 9 ? '9+' : count}
    </span>
  )

  const amberDot = (title: string) => (
    <span
      title={title}
      style={{
        position: 'absolute',
        bottom: 2,
        right: 2,
        width: 6,
        height: 6,
        borderRadius: '50%',
        backgroundColor: '#fbbf24',
        boxShadow: '0 0 6px rgba(0, 0, 0, 0.5)',
        pointerEvents: 'none'
      }}
    />
  )

  // Files second row: hidden entirely when no file entries exist.
  const hasFiles = files.members.length > 0

  return (
    <div
      className="header"
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        width: '100%',
        alignItems: 'stretch',
        height: 'auto',
        minHeight: 62,
        padding: '6px 7px 6px 7px',
        boxSizing: 'border-box',
        gap: 4,
        flexShrink: 0
      }}
    >
      {/* ── Row 1: primary view chips / settings title + right buttons ── */}
      <div style={{
        display: 'flex',
        justifyContent: settingsOpen ? 'space-between' : 'center',
        width: '100%',
        alignItems: 'center',
        gap: 0,
        flexShrink: 0,
        position: 'relative'
      }}>
        {settingsOpen ? (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#8e8e93', letterSpacing: '0.01em', paddingLeft: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>
            {settingsSubView === 'changelog' ? t('header.whatsNew') : t('header.settings')}
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
              gap: PRIMARY_GAP,
              boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
              maxWidth: '100%',
              overflow: 'hidden'
            }}
          >
            <motion.div
              initial={false}
              animate={{ x: primaryViewIndex * (PRIMARY_CHIP_WIDTH + PRIMARY_GAP) }}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              style={{
                position: 'absolute',
                left: TRACK_LEFT,
                top: 2,
                width: PRIMARY_CHIP_WIDTH,
                height: 22,
                borderRadius: 999,
                background: 'rgba(255, 255, 255, 0.16)',
                border: '1px solid rgba(255, 255, 255, 0.22)',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
                pointerEvents: 'none',
                zIndex: 0
              }}
            />

            {[
              { id: 'clipboard' as const, label: t('filters.clipboard') },
              { id: 'files' as const, label: t('filters.files') },
              { id: 'tasks' as const, label: t('filters.tasks') }
            ].map((f) => {
              const active = view === f.id
              return (
                <button
                  key={f.id}
                  title={f.id === 'tasks' ? t('tasks.viewTitle') : undefined}
                  type="button"
                  className={`filter-chip${active ? ' active' : ''}`}
                  onClick={() => {
                    playButtonClickSound()
                    if (f.id !== view) {
                      leaveShelfFlyouts()
                      setView(f.id)
                    }
                  }}
                  style={primaryChipStyle(active)}
                >
                  <span>{f.label}</span>
                  {f.id === 'tasks' && badge > 0 && redBadge(badge)}
                </button>
              )
            })}
          </div>
        )}

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexShrink: 0,
          paddingRight: 2,
          // When the chips are centered the buttons float at the right edge
          // (they'd otherwise push the row's center off by half their width).
          ...(settingsOpen ? {} : { position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)' })
        }}>
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

      {/* ── Row 2: second-level chips — hidden entirely when the files view
             has no entries (two rows spring back to one, ADR-0004) ── */}
      <AnimatePresence initial={false}>
        {!settingsOpen && !(view === 'files' && !hasFiles) && (
          <motion.div
            key="secondary-row"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 26 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 34 }}
            style={{ overflow: 'hidden', flexShrink: 0 }}
          >
            <div
              className="filter-segmented-track"
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.07)',
                borderRadius: 999,
                padding: '2px 3px',
                gap: 2,
                marginLeft: 2,
                marginRight: 2,
                boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
                maxWidth: '100%',
                overflow: 'hidden',
                height: 26,
                boxSizing: 'border-box'
              }}
            >
              <AnimatePresence initial={false} mode="wait">
                {view === 'clipboard' && (
              <motion.div
                key="row-clipboard"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
                style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}
              >
                {([
                  { id: 'all' as const, label: t('filters.all') },
                  { id: 'text' as const, label: t('filters.text') },
                  { id: 'links' as const, label: t('filters.links') },
                  { id: 'images' as const, label: t('filters.images') }
                ]).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`filter-chip${clipboardFilter === f.id ? ' active' : ''}`}
                    onClick={() => {
                      playButtonClickSound()
                      setClipboardFilter(f.id)
                    }}
                    style={secondaryChipStyle(clipboardFilter === f.id)}
                  >
                    <span>{f.label}</span>
                  </button>
                ))}
              </motion.div>
            )}

            {view === 'files' && (
              <motion.div
                key="row-files"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
                style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}
              >
                <AnimatePresence initial={false}>
                  {hasFiles ? (
                    <motion.div
                      key="files-tabs"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                      style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, overflow: 'hidden' }}
                    >
                      <button
                        type="button"
                        className={`filter-chip${filesFilter === 'all' ? ' active' : ''}`}
                        onClick={() => {
                          playButtonClickSound()
                          setFilesFilter('all')
                        }}
                        style={secondaryChipStyle(filesFilter === 'all')}
                      >
                        <span>{t('filters.all')}</span>
                      </button>
                      {files.tabs.map((tab) => (
                        <button
                          key={tab.ext}
                          type="button"
                          className={`filter-chip${filesFilter === tab.ext ? ' active' : ''}`}
                          onClick={() => {
                            playButtonClickSound()
                            setFilesFilter(tab.ext)
                          }}
                          style={secondaryChipStyle(filesFilter === tab.ext)}
                        >
                          <span>{tab.ext.slice(1)}</span>
                        </button>
                      ))}
                      {files.otherCount > 0 && (
                        <button
                          type="button"
                          className={`filter-chip${filesFilter === 'other' ? ' active' : ''}`}
                          onClick={() => {
                            playButtonClickSound()
                            setFilesFilter('other')
                          }}
                          style={secondaryChipStyle(filesFilter === 'other')}
                        >
                          <span>{t('filters.other')}</span>
                        </button>
                      )}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            )}

            {view === 'tasks' && (
              <motion.div
                key="row-tasks"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
                style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}
              >
                <button
                  type="button"
                  className={`filter-chip${tasksFilter === 'existing' ? ' active' : ''}`}
                  onClick={() => {
                    playButtonClickSound()
                    setTasksFilter('existing')
                  }}
                  style={secondaryChipStyle(tasksFilter === 'existing')}
                >
                  <span>{t('filters.existingTasks')}</span>
                  {tasksFilter === 'existing' && badge > 0 && redBadge(badge)}
                </button>
                <button
                  type="button"
                  className={`filter-chip${tasksFilter === 'candidates' ? ' active' : ''}`}
                  onClick={() => {
                    playButtonClickSound()
                    setTasksFilter('candidates')
                  }}
                  style={secondaryChipStyle(tasksFilter === 'candidates')}
                >
                  <span>{t('filters.candidateTasks')}</span>
                  {tasksFilter === 'candidates' && suggestions.length > 0 && amberDot(t('tasks.suggestionBadge', { count: suggestions.length }))}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
