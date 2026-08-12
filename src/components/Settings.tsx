import { useEffect, useState, useRef, type CSSProperties } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, type SettingsTab } from '../store/appStore'
import type { DisplayInfo, Memory, MemoryAction, ProviderConfig, ClipboardFilter, RestoreTime } from '../../shared/types'
import { THEME_ACCENTS, THEME_COLORS } from '../../shared/themes'
import { LiquidOctopusLoader } from './LiquidOctopusLoader'
import { TickIndicatorIcon, CopyIndicatorIcon, SparkleIndicatorIcon } from './CopyIndicatorCurve'
import { ChevronRightIcon, CloseIcon, LogOutIcon, StarIcon, GithubOctocatLogo, ChevronDownIcon, PlusIcon } from './icons'
import { ChangelogView } from './ChangelogView'
import kofiSupportImg from '../assets/kofi-support.webp'
import { playDialTickSound, playToggleSound, playButtonClickSound } from '../lib/soundEffects'
import { useTranslation } from '../i18n'
import '../styles/settings.css'

export type { SettingsTab }

export function Settings({ inlineIndicatorStyle }: { inlineIndicatorStyle?: boolean }) {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: 'behaviour',  label: t('tabs.behaviour') },
    { id: 'position',   label: t('tabs.position') },
    { id: 'appearance', label: t('tabs.appearance') },
    { id: 'tasks',      label: t('tabs.tasks') },
  ]
  const patch = useStore((s) => s.patchSettings)
  const currentVersion = useStore((s) => s.currentVersion)
  const styleFlyoutOpen = useStore((s) => s.styleFlyoutOpen)
  const setStyleFlyoutOpen = useStore((s) => s.setStyleFlyoutOpen)
  const settingsSubView = useStore((s) => s.settingsSubView)
  const setSliderActive = useStore((s) => s.setSliderActive)

  const lastTickVal = useRef<number>(settings.verticalOffset ?? 0.5)

  const handleSliderInput = (rawVal: number) => {
    const clamped = Math.min(1.0, Math.max(0.0, rawVal))
    if (Math.abs(clamped - lastTickVal.current) >= 0.05) {
      lastTickVal.current = clamped
      playDialTickSound()
    }
    // Update store state immediately for butter-smooth 60fps real-time tracking
    useStore.setState((s) => ({
      settings: { ...s.settings, verticalOffset: clamped }
    }))
  }

  const handleSliderRelease = (rawVal: number) => {
    // Snap to nearest 5% tick on pointer release
    const snapped = Math.round(rawVal / 0.05) * 0.05
    const clamped = Math.min(1.0, Math.max(0.0, snapped))
    lastTickVal.current = clamped
    playDialTickSound()
    patch({ verticalOffset: clamped })
  }

  const [localInlineOpen, setLocalInlineOpen] = useState(false)
  const isTutorial = inlineIndicatorStyle || (typeof window !== 'undefined' && window.location.hash.includes('onboarding'))

  const isFlyoutActive = isTutorial ? localInlineOpen : styleFlyoutOpen

  const handleToggleFlyout = () => {
    if (isTutorial) {
      setLocalInlineOpen(!localInlineOpen)
    } else {
      setStyleFlyoutOpen(!styleFlyoutOpen)
    }
  }

  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  useEffect(() => {
    window.edge.getDisplays().then(setDisplays).catch(() => {})
  }, [])

  // ── Tab state & Independent Scroll Memory per section ──────────────────────
  // activeTab lives in the store so the restore mechanism can remember it
  // across panel opens (ADR-0004).
  const activeTab = useStore((s) => s.settingsTab)
  const setActiveTab = useStore((s) => s.setSettingsTab)
  const scrollListRef = useRef<HTMLDivElement>(null)
  const tabScrollPositions = useRef<Record<SettingsTab, number>>({
    behaviour: 0,
    position: 0,
    appearance: 0,
    tasks: 0
  })

  const handleTabSwitch = (newTab: SettingsTab) => {
    if (newTab === activeTab) return
    // Save current section's scroll position
    if (scrollListRef.current) {
      tabScrollPositions.current[activeTab] = scrollListRef.current.scrollTop
    }
    playButtonClickSound()
    setActiveTab(newTab)
  }

  // Restore target section's independent scroll position when tab changes
  useEffect(() => {
    if (scrollListRef.current) {
      const targetPos = tabScrollPositions.current[activeTab] ?? 0
      scrollListRef.current.scrollTop = targetPos
    }
  }, [activeTab])

  // ── Persistent footer shared across all tabs ───────────────────────────
  const [footerOpen, setFooterOpen] = useState(false)
  const footerContentRef = useRef<HTMLDivElement>(null)
  // Auto-expand: scrolling past the bottom of the settings list opens the
  // collapsed Community & Support section. Damped: the overscroll distance
  // must accumulate past 600px (several wheel notches) — a single nudge or
  // trackpad inertia at the bottom won't trigger. Any upward scroll or
  // leaving the bottom resets the accumulator.
  const footerOverscrollAcc = useRef(0)
  const handleFooterOverscroll = (e: React.WheelEvent<HTMLDivElement>) => {
    if (footerOpen) return
    const el = scrollListRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    if (atBottom && e.deltaY > 0) {
      // Normalize wheel units (line/page) to pixels
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      footerOverscrollAcc.current += e.deltaY * scale
      if (footerOverscrollAcc.current >= 600) {
        footerOverscrollAcc.current = 0
        playButtonClickSound()
        setFooterOpen(true)
      }
    } else {
      footerOverscrollAcc.current = 0
    }
  }
  // Auto-collapse: once the expanded footer content has scrolled fully out of
  // the settings list's viewport above, fold it back up. Compare against the
  // container's top — the scroll area sits below the fixed header, so the
  // window coordinate 0 is never reached.
  const handleFooterScroll = () => {
    if (!footerOpen) return
    const el = footerContentRef.current
    const container = scrollListRef.current
    if (!el || !container) return
    const containerRect = container.getBoundingClientRect()
    if (el.getBoundingClientRect().bottom <= containerRect.top) {
      footerOverscrollAcc.current = 0
      setFooterOpen(false)
    }
  }
  const PersistentFooter = (
    <>
      {/* Community & Support — collapsible */}
      <button
        type="button"
        className="settings-collapse-header"
        onClick={() => { playButtonClickSound(); setFooterOpen(!footerOpen) }}
      >
        <span>{t('footer.communityAndSupport')}</span>
        <ChevronDownIcon
          width={13}
          height={13}
          style={{ transform: footerOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.22s ease', flexShrink: 0 }}
        />
      </button>

      <AnimatePresence initial={false}>
        {footerOpen && (
        <motion.div
          key="footer-content"
          ref={footerContentRef}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          style={{ overflow: 'hidden' }}
        >

      <div className="setting-row vertical" style={{ gap: 10 }}>
        <div className="setting-info">
          <div className="setting-title">{t('footer.feedbackTitle')}</div>
          <div className="setting-desc">{t('footer.feedbackDesc')}</div>
        </div>
        <button
          className="pill display-pill"
          style={{ width: '100%', justifyContent: 'center', padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '12.5px' }}
          onClick={() => {
            playButtonClickSound()
            window.open('https://github.com/PaRr0tBoY/Trace/issues/new/choose', '_blank')
          }}
        >
          {t('footer.submitFeedback')}
        </button>
      </div>

      {/* Support & GitHub Promo Footer */}
      <div className="setting-divider" style={{ marginTop: 20 }} />

      <div className="support-promo">
        <div className="support-promo-title">
          {t('footer.supportPromo')}
        </div>
        <div className="support-buttons-group">
          {/* Primary Action: Support via Ko-fi (image button) */}
          <button
            className="kofi-support-btn"
            onClick={() => {
              playButtonClickSound()
              window.open('https://acidev.cc', '_blank')
            }}
          >
            <img
              src={kofiSupportImg}
              alt={t('footer.supportOnKofi')}
              style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 12 }}
            />
          </button>

          {/* Secondary Action: GitHub Star */}
          <button
            className="github-promo-btn"
            onClick={() => {
              playButtonClickSound()
              window.open('https://github.com/PaRr0tBoY/Trace', '_blank')
            }}
          >
            <GithubOctocatLogo width={14} height={14} className="github-octocat-icon" />
            <span>{t('footer.starOnGithub')}</span>
            <StarIcon width={13} height={13} className="star-icon" fill="#fbbf24" stroke="#fbbf24" style={{ marginLeft: 2 }} />
          </button>
        </div>
        <div className="app-version-footer">
          {t('footer.version')} {currentVersion || '0.2.6'}
        </div>
      </div>

      {/* Subtle Bottom Quit Button */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14, marginBottom: 6 }}>
        <button
          className="subtle-quit-btn"
          onClick={() => {
            playButtonClickSound()
            void window.edge.quitApp()
          }}
        >
          <LogOutIcon width={13} height={13} />
          <span>{t('tray.quit')}</span>
        </button>
      </div>
        </motion.div>
        )}
      </AnimatePresence>
    </>
  )

  const maxTabLen = Math.max(...TABS.map((tab) => tab.label.length))
  const tabFontSize = maxTabLen > 15 ? '9px' : maxTabLen > 13 ? '9.5px' : maxTabLen > 11 ? '10px' : maxTabLen > 9 ? '10.8px' : '11.5px'
  const tabLetterSpacing = maxTabLen > 13 ? '-0.03em' : maxTabLen > 10 ? '-0.015em' : '0'

  return (
    <AnimatePresence mode="wait">
      {settingsSubView === 'changelog' ? (
        <motion.div
          key="changelog-view"
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -12 }}
          transition={{ type: 'spring', stiffness: 400, damping: 36, mass: 0.6 }}
          style={{ width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden' }}
        >
          <ChangelogView />
        </motion.div>
      ) : (
        <motion.div
          key="main-settings"
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 12 }}
          transition={{ type: 'spring', stiffness: 400, damping: 36, mass: 0.6 }}
          style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
        >
          {/* ── Stationary Fixed Header (Tab Selector) ────────────────── */}
          <div className="settings-fixed-header">
            <div className="settings-tab-bar">
              {TABS.map((tab) => {
                const active = activeTab === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`settings-tab-btn${active ? ' active' : ''}`}
                    onClick={() => handleTabSwitch(tab.id)}
                    style={{
                      fontSize: `calc(${tabFontSize} * var(--font-scale, 1))`,
                      letterSpacing: tabLetterSpacing
                    }}
                  >
                    <span className="settings-tab-text">{tab.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Scrollable Content Area (Independent per section) ───────── */}
          <div className="settings-scroll-list" ref={scrollListRef} onWheel={handleFooterOverscroll} onScroll={handleFooterScroll}>

            {/* ── Tab 1: Behaviour (First) ──────────────────────────────── */}
            <AnimatePresence mode="wait">
              {activeTab === 'behaviour' && (
                <motion.div
                  key="tab-behaviour"
                  initial={{ opacity: 0, scale: 0.98, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                  {/* ── GROUP: Behaviour ─────────────────────────────────── */}
                  <div className="setting-group-label">{t('tabs.behaviour')}</div>

                  {/* ── Landing page & restore time (ADR-0004) ── */}
                  <div className="setting-row vertical" style={{ gap: 8 }}>
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.landingTitle')}</div>
                      <div className="setting-desc">{t('behaviour.landingDesc')}</div>
                    </div>
                    {/* Level 1: top-level view, one row. */}
                    <div className="setting-pills" style={{ opacity: settings.restoreTime === 'forever' ? 0.45 : 1, transition: 'opacity 0.2s ease' }}>
                      {([
                        { id: 'clipboard' as const, label: t('filters.clipboard') },
                        { id: 'tasks' as const, label: t('filters.tasks') },
                        { id: 'files' as const, label: t('filters.files') }
                      ]).map((opt) => (
                        <button
                          key={opt.id}
                          className={`pill ${settings.landing.view === opt.id ? 'active' : ''}`}
                          disabled={settings.restoreTime === 'forever'}
                          onClick={() => {
                            playButtonClickSound()
                            // Switching the level-1 view resets the level-2
                            // filter to that view's default.
                            if (opt.id === 'clipboard') patch({ landing: { view: 'clipboard', filter: 'all' } })
                            else if (opt.id === 'tasks') patch({ landing: { view: 'tasks', filter: 'existing' } })
                            else patch({ landing: { view: 'files' } })
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {/* Level 2: follows the selected view. Files has no
                        second level — always 'all' (ADR-0004). */}
                    <div className="setting-pills" style={{ opacity: settings.restoreTime === 'forever' ? 0.45 : 1, transition: 'opacity 0.2s ease' }}>
                      {settings.landing.view === 'clipboard' && (
                        ([
                          { id: 'all', label: t('filters.all') },
                          { id: 'text', label: t('filters.text') },
                          { id: 'links', label: t('filters.links') },
                          { id: 'images', label: t('filters.images') }
                        ]).map((opt) => (
                          <button
                            key={opt.id}
                            className={`pill ${settings.landing.view === 'clipboard' && settings.landing.filter === opt.id ? 'active' : ''}`}
                            disabled={settings.restoreTime === 'forever'}
                            onClick={() => { playButtonClickSound(); patch({ landing: { view: 'clipboard', filter: opt.id as ClipboardFilter } }) }}
                          >
                            {opt.label}
                          </button>
                        ))
                      )}
                      {settings.landing.view === 'tasks' && (
                        ([
                          { id: 'existing', label: t('filters.existingTasks') },
                          { id: 'candidates', label: t('filters.candidateTasks') }
                        ]).map((opt) => (
                          <button
                            key={opt.id}
                            className={`pill ${settings.landing.view === 'tasks' && settings.landing.filter === opt.id ? 'active' : ''}`}
                            disabled={settings.restoreTime === 'forever'}
                            onClick={() => { playButtonClickSound(); patch({ landing: { view: 'tasks', filter: opt.id as 'existing' | 'candidates' } }) }}
                          >
                            {opt.label}
                          </button>
                        ))
                      )}
                      {settings.landing.view === 'files' && (
                        <button
                          className="pill active"
                          disabled
                        >
                          {t('filters.all')}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row vertical" style={{ gap: 8 }}>
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.restoreTimeTitle')}</div>
                      <div className="setting-desc">{t('behaviour.restoreTimeDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {([
                        { id: 'instant' as const, label: t('behaviour.restoreInstant') },
                        { id: 'relaxed' as const, label: t('behaviour.restoreRelaxed') },
                        { id: 'delayed' as const, label: t('behaviour.restoreDelayed') },
                        { id: 'forever' as const, label: t('behaviour.restoreForever') }
                      ]).map((opt) => (
                        <button
                          key={opt.id}
                          className={`pill ${settings.restoreTime === opt.id ? 'active' : ''}`}
                          onClick={() => { playButtonClickSound(); patch({ restoreTime: opt.id as RestoreTime }) }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="setting-desc" style={{ fontSize: 11 }}>
                      {settings.restoreTime === 'instant' ? t('behaviour.restoreInstantDesc')
                        : settings.restoreTime === 'relaxed' ? t('behaviour.restoreRelaxedDesc')
                        : settings.restoreTime === 'delayed' ? t('behaviour.restoreDelayedDesc')
                        : t('behaviour.restoreForeverDesc')}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  {/* ── Language Selector ── */}
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: '2px 0'
                  }}>
                    <div>
                      <div className="setting-title">{t('behaviour.languageTitle')}</div>
                      <div className="setting-desc" style={{ marginTop: 2 }}>{t('behaviour.languageDesc')}</div>
                    </div>
                    <LanguageDropdown />
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row">
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.launchAtLoginTitle')}</div>
                      <div className="setting-desc">{t('behaviour.launchAtLoginDesc')}</div>
                    </div>
                    <Toggle
                      checked={settings.launchAtLogin}
                      onChange={(v) => patch({ launchAtLogin: v })}
                    />
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row">
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.incognitoTitle')}</div>
                      <div className="setting-desc">{t('behaviour.incognitoDesc')}</div>
                    </div>
                    <Toggle
                      checked={settings.incognito}
                      onChange={(v) => patch({ incognito: v })}
                    />
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row">
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.hoverActivationTitle')}</div>
                      <div className="setting-desc" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '3px 5px', marginTop: 2 }}>
                        {(settings.hoverActivation ?? true) ? (
                          <span>{t('behaviour.hoverActivationDescOn')}</span>
                        ) : (
                          <span>{t('behaviour.hoverActivationDescOff')}</span>
                        )}
                      </div>
                    </div>
                    <Toggle
                      checked={settings.hoverActivation ?? true}
                      onChange={(v) => {
                        if (!v) {
                          patch({ hoverActivation: false, suppressInFullscreen: false })
                        } else {
                          patch({ hoverActivation: true, suppressInFullscreen: true })
                        }
                      }}
                    />
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row" style={{ opacity: (settings.hoverActivation ?? true) ? 1 : 0.45, transition: 'opacity 0.2s ease' }}>
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.fullscreenProtectionTitle')}</div>
                      <div className="setting-desc">
                        {(settings.hoverActivation ?? true)
                          ? t('behaviour.fullscreenProtectionDesc')
                          : t('behaviour.disabledHoverOff')}
                      </div>
                    </div>
                    <Toggle
                      checked={(settings.hoverActivation ?? true) ? settings.suppressInFullscreen : false}
                      onChange={(v) => (settings.hoverActivation ?? true) && patch({ suppressInFullscreen: v })}
                      disabled={!(settings.hoverActivation ?? true)}
                    />
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row">
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.clearUnpinnedTitle')}</div>
                      <div className="setting-desc">{t('behaviour.clearUnpinnedDesc')}</div>
                    </div>
                    <Toggle
                      checked={settings.clearUnpinnedOnRestart}
                      onChange={(v) => patch({ clearUnpinnedOnRestart: v })}
                    />
                  </div>


                  <div className="setting-divider" />

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.autoDeleteTitle')}</div>
                      <div className="setting-desc">{t('behaviour.autoDeleteDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {[
                        { label: t('behaviour.never'), val: 0 },
                        { label: '1h', val: 1 },
                        { label: '6h', val: 6 },
                        { label: '24h', val: 24 },
                        { label: '7d', val: 168 }
                      ].map((opt) => (
                        <button
                          key={opt.val}
                          className={`pill ${settings.autoDeleteHours === opt.val ? 'active' : ''}`}
                          onClick={() => { playButtonClickSound(); patch({ autoDeleteHours: opt.val }) }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.capacityTitle')}</div>
                      <div className="setting-desc">{t('behaviour.capacityDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {[
                        { label: '100', val: 100 },
                        { label: '250', val: 250 },
                        { label: '500', val: 500 },
                        { label: '1000', val: 1000 }
                      ].map((opt) => (
                        <button
                          key={opt.val}
                          className={`pill ${settings.historyLimit === opt.val ? 'active' : ''}`}
                          onClick={() => { playButtonClickSound(); patch({ historyLimit: opt.val }) }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  {PersistentFooter}
                </motion.div>
              )}

              {/* ── Tab 2: Position (Second) ─────────────────────────────── */}
              {activeTab === 'position' && (
                <motion.div
                  key="tab-position"
                  initial={{ opacity: 0, scale: 0.98, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                  {/* ── GROUP: Position ──────────────────────────────────── */}
                  <div className="setting-group-label">{t('tabs.position')}</div>

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('position.edgePlacementTitle')}</div>
                      <div className="setting-desc">{t('position.edgePlacementDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {[
                        { label: t('position.leftEdge'), val: 'left' as const },
                        { label: t('position.rightEdge'), val: 'right' as const }
                      ].map((opt) => (
                        <button
                          key={opt.val}
                          className={`pill ${settings.stickPosition === opt.val ? 'active' : ''}`}
                          onClick={() => {
                            playButtonClickSound()
                            patch({ stickPosition: opt.val })
                            useStore.getState().notifyPositionChanged()
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  {/* Vertical Position Range Slider */}
                  <div className="setting-row vertical" style={{ gap: 10 }}>
                    <div className="setting-slider-header">
                      <div className="setting-info">
                        <div className="setting-title">{t('position.verticalPositionTitle')}</div>
                        <div className="setting-desc">{t('position.verticalPositionDesc')}</div>
                      </div>
                      <div className="setting-slider-val">
                        {`${Math.round((settings.verticalOffset ?? 0.5) * 100)}%`}
                      </div>
                    </div>

                    <div className="setting-slider-wrap">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.002"
                        className="setting-range-input"
                        value={settings.verticalOffset ?? 0.5}
                        style={{
                          background: `linear-gradient(to right, #ffffff 0%, #ffffff ${(settings.verticalOffset ?? 0.5) * 100}%, rgba(255, 255, 255, 0.12) ${(settings.verticalOffset ?? 0.5) * 100}%, rgba(255, 255, 255, 0.12) 100%)`
                        }}
                        onPointerDown={() => {
                          void window.edge.setInteractive(true)
                          setSliderActive(true)
                        }}
                        onPointerUp={(e) => {
                          setSliderActive(false)
                          const val = parseFloat((e.target as HTMLInputElement).value)
                          handleSliderRelease(val)
                        }}
                        onPointerCancel={(e) => {
                          setSliderActive(false)
                          const val = parseFloat((e.target as HTMLInputElement).value)
                          handleSliderRelease(val)
                        }}
                        onLostPointerCapture={(e) => {
                          setSliderActive(false)
                          const val = parseFloat((e.target as HTMLInputElement).value)
                          handleSliderRelease(val)
                        }}
                        onChange={(e) => {
                          const raw = parseFloat(e.target.value)
                          handleSliderInput(raw)
                        }}
                      />

                      <div className="setting-slider-ticks">
                        {Array.from({ length: 21 }, (_, i) => {
                          const tickVal = i * 0.05
                          const currentVal = settings.verticalOffset ?? 0.5
                          const isMajor = i === 0 || i === 10 || i === 20
                          const isActive = Math.abs(currentVal - tickVal) < 0.025
                          return (
                            <span
                              key={i}
                              className={`slider-tick${isMajor ? ' major' : ''}${isActive ? ' active' : ''}`}
                            />
                          )
                        })}
                      </div>

                      <div className="setting-slider-labels">
                        {[
                          { label: '0%', val: 0 },
                          { label: '50%', val: 0.5 },
                          { label: '100%', val: 1.0 }
                        ].map((pos) => {
                          const currentVal = settings.verticalOffset ?? 0.5
                          const active = Math.abs(currentVal - pos.val) < 0.04
                          return (
                            <button
                              key={pos.val}
                              type="button"
                              className={`slider-label-btn${active ? ' active' : ''}`}
                              onClick={() => handleSliderRelease(pos.val)}
                            >
                              {pos.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('position.displayTitle')}</div>
                      <div className="setting-desc">{t('position.displayDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {displays.length === 0 && <div className="pill disabled">Loading...</div>}
                      {displays.map((d) => {
                        const currentDisplay = displays.find((disp) => disp.isCurrent)
                        const activeDisplayId = currentDisplay
                          ? currentDisplay.id
                          : (settings.stickDisplayId ?? displays.find((disp) => disp.isPrimary)?.id ?? displays[0]?.id)
                        const isActive = activeDisplayId === d.id
                        const displayName = d.isPrimary ? t('position.primaryDisplay') : d.name
                        return (
                          <button
                            key={d.id}
                            className={`pill display-pill ${isActive ? 'active' : ''}`}
                            onClick={() => {
                              playButtonClickSound()
                              patch({ stickDisplayId: d.id })
                              useStore.getState().notifyPositionChanged()
                            }}
                          >
                            <div className="pill-name">{displayName}</div>
                            <div className="pill-res">{d.resolution}</div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* ── GROUP: Trigger Zone ──────────────────────────────── */}
                  <div className="setting-group-label" style={{ marginTop: 20 }}>{t('position.triggerZone')}</div>

                  <div className="setting-row">
                    <div className="setting-info">
                      <div className="setting-title">{t('position.edgeLocationHintTitle')}</div>
                      <div className="setting-desc">{t('position.edgeLocationHintDesc')}</div>
                    </div>
                    <Toggle
                      checked={settings.showEdgeLocationHint ?? true}
                      onChange={(v) => patch({ showEdgeLocationHint: v })}
                    />
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('position.edgeTriggerPositionTitle')}</div>
                      <div className="setting-desc">{t('position.edgeTriggerPositionDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {[
                        { label: t('position.top'), val: 'top' as const },
                        { label: t('position.center'), val: 'center' as const },
                        { label: t('position.bottom'), val: 'bottom' as const }
                      ].map((opt) => (
                        <button
                          key={opt.label}
                          className={`pill ${(settings.triggerAlignment || 'center') === opt.val ? 'active' : ''}`}
                          onClick={() => {
                            playButtonClickSound()
                            patch({ triggerAlignment: opt.val })
                            useStore.getState().notifyPositionChanged()
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('position.hoverAreaSizeTitle')}</div>
                      <div className="setting-desc">{t('position.hoverAreaSizeDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {[
                        { label: t('appearance.small'), val: 0.25 },
                        { label: t('position.medium'), val: 0.4 },
                        { label: t('appearance.large'), val: 0.6 }
                      ].map((opt) => (
                        <button
                          key={opt.label}
                          className={`pill ${Math.abs(settings.hotZoneHeight - opt.val) < 0.08 ? 'active' : ''}`}
                          onClick={() => {
                            playButtonClickSound()
                            patch({ hotZoneHeight: opt.val })
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('position.edgeTriggerThicknessTitle')}</div>
                      <div className="setting-desc">{t('position.edgeTriggerThicknessDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {[
                        { label: t('appearance.small'), val: 3 },
                        { label: t('position.medium'), val: 6 },
                        { label: t('appearance.large'), val: 12 }
                      ].map((opt) => (
                        <button
                          key={opt.label}
                          className={`pill ${settings.hotZoneWidth === opt.val ? 'active' : ''}`}
                          onClick={() => {
                            playButtonClickSound()
                            patch({ hotZoneWidth: opt.val })
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('position.panelHeightTitle')}</div>
                      <div className="setting-desc">{t('position.panelHeightDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {[
                        { label: t('appearance.small'), val: 0.5 },
                        { label: t('position.medium'), val: 0.65 },
                        { label: t('appearance.large'), val: 0.8 }
                      ].map((opt) => (
                        <button
                          key={opt.label}
                          className={`pill ${Math.abs((settings.panelHeight || 0.6) - opt.val) < 0.08 ? 'active' : ''}`}
                          onClick={() => {
                            playButtonClickSound()
                            patch({ panelHeight: opt.val })
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {PersistentFooter}
                </motion.div>
              )}

              {/* ── Tab 3: Appearance (Third) ────────────────────────────── */}
              {activeTab === 'appearance' && (
                <motion.div
                  key="tab-appearance"
                  initial={{ opacity: 0, scale: 0.98, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                  {/* ── GROUP: Theme color ──────────────────────────────── */}
                  <div className="setting-group-label">{t('appearance.themeTitle')}</div>

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('appearance.themeTitle')}</div>
                      <div className="setting-desc">{t('appearance.themeDesc')}</div>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: 10,
                        marginTop: 10
                      }}
                    >
                      {THEME_COLORS.map((color) => {
                        const selected = (settings.themeColor ?? 'graphite') === color
                        return (
                          <div
                            key={color}
                            role="button"
                            title={t(`appearance.theme${color.charAt(0).toUpperCase() + color.slice(1)}`)}
                            onClick={() => {
                              playButtonClickSound()
                              patch({ themeColor: color })
                            }}
                            style={{
                              cursor: 'pointer',
                              width: 26,
                              height: 26,
                              borderRadius: '50%',
                              background: THEME_ACCENTS[color].color,
                              border: selected ? '2px solid #ffffff' : '2px solid rgba(255,255,255,0.2)',
                              boxShadow: selected ? '0 0 0 2px rgba(255,255,255,0.35)' : 'none',
                              transform: selected ? 'scale(1.08)' : 'scale(1)',
                              transition: 'all 0.15s ease',
                              boxSizing: 'border-box'
                            }}
                          />
                        )
                      })}
                    </div>
                    {(() => {
                      const selected = settings.themeColor ?? 'graphite'
                      const name = 'theme' + selected.charAt(0).toUpperCase() + selected.slice(1)
                      return (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: THEME_ACCENTS[selected].color }}>
                            {t(`appearance.${name}`)}
                          </div>
                          <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.45)', lineHeight: 1.4, marginTop: 2 }}>
                            {t(`appearance.${name}Desc`)}
                          </div>
                        </div>
                      )
                    })()}
                  </div>

                  {/* ── GROUP: Copy Indicator ────────────────────────────── */}
                  <div className="setting-group-label">{t('appearance.copyIndicatorTitle')}</div>

                  <div className="setting-row">
                    <div className="setting-info">
                      <div className="setting-title">{t('appearance.copyIndicatorTitle')}</div>
                      <div className="setting-desc">{t('appearance.copyIndicatorDesc')}</div>
                    </div>
                    <Toggle
                      checked={settings.showCopyIndicator ?? true}
                      onChange={(v) => patch({ showCopyIndicator: v })}
                    />
                  </div>

                  {(settings.showCopyIndicator ?? true) && (
                    <>
                      <div className="setting-divider" />

                      <div className="setting-row">
                        <div className="setting-info">
                          <div className="setting-title">{t('appearance.indicatorStyleTitle')}</div>
                          <div className="setting-desc">
                            {t('appearance.indicatorStyleDesc')}
                          </div>
                        </div>
                        
                        <button
                          type="button"
                          className={`icon-btn style-preview-toggle-btn ${isFlyoutActive ? 'active' : ''}`}
                          title={isFlyoutActive ? 'Close Style Selector' : 'Open Indicator Style Selector'}
                          onClick={() => {
                            playButtonClickSound()
                            handleToggleFlyout()
                          }}
                        >
                          {isFlyoutActive ? <CloseIcon /> : <ChevronRightIcon />}
                        </button>
                      </div>

                      {isTutorial && localInlineOpen && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.22, ease: 'easeOut' }}
                          style={{ overflow: 'hidden', marginTop: 12, marginBottom: 8 }}
                        >
                          <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(2, 1fr)',
                            gap: 10,
                            padding: 12,
                            background: '#09090b',
                            borderRadius: 12,
                            border: '1px solid rgba(255, 255, 255, 0.08)'
                          }}>
                            {/* Logo Card */}
                            <div
                              onClick={() => {
                                playButtonClickSound()
                                patch({ copyIndicatorStyle: 'logo' })
                              }}
                              style={{
                                background: (settings.copyIndicatorStyle || 'logo') === 'logo' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
                                border: (settings.copyIndicatorStyle || 'logo') === 'logo' ? '1px solid rgba(255, 255, 255, 0.3)' : '1px solid rgba(255, 255, 255, 0.06)',
                                borderRadius: 10,
                                padding: '12px 8px',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                gap: 8,
                                transition: 'all 0.2s ease'
                              }}
                            >
                              <div style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <LiquidOctopusLoader fillColor="#ffffff" glowColor="rgba(255, 255, 255, 0.85)" speed={1.2} />
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#ffffff' }}>{t('appearance.logoStyle')}</div>
                            </div>

                            {/* Tick Card */}
                            <div
                              onClick={() => {
                                playButtonClickSound()
                                patch({ copyIndicatorStyle: 'check' })
                              }}
                              style={{
                                background: settings.copyIndicatorStyle === 'check' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
                                border: settings.copyIndicatorStyle === 'check' ? '1px solid rgba(255, 255, 255, 0.3)' : '1px solid rgba(255, 255, 255, 0.06)',
                                borderRadius: 10,
                                padding: '12px 8px',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                gap: 8,
                                transition: 'all 0.2s ease'
                              }}
                            >
                              <div style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <TickIndicatorIcon fillColor="#ffffff" glowColor="rgba(255, 255, 255, 0.85)" size={30} />
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#ffffff' }}>{t('appearance.tickStyle')}</div>
                            </div>

                            {/* Copy Card */}
                            <div
                              onClick={() => {
                                playButtonClickSound()
                                patch({ copyIndicatorStyle: 'copy' })
                              }}
                              style={{
                                background: settings.copyIndicatorStyle === 'copy' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
                                border: settings.copyIndicatorStyle === 'copy' ? '1px solid rgba(255, 255, 255, 0.3)' : '1px solid rgba(255, 255, 255, 0.06)',
                                borderRadius: 10,
                                padding: '12px 8px',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                gap: 8,
                                transition: 'all 0.2s ease'
                              }}
                            >
                              <div style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <CopyIndicatorIcon fillColor="#ffffff" glowColor="rgba(255, 255, 255, 0.85)" size={30} />
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#ffffff' }}>{t('appearance.copyStyle')}</div>
                            </div>

                            {/* Sparkle Card */}
                            <div
                              onClick={() => {
                                playButtonClickSound()
                                patch({ copyIndicatorStyle: 'sparkle' })
                              }}
                              style={{
                                background: settings.copyIndicatorStyle === 'sparkle' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
                                border: settings.copyIndicatorStyle === 'sparkle' ? '1px solid rgba(255, 255, 255, 0.3)' : '1px solid rgba(255, 255, 255, 0.06)',
                                borderRadius: 10,
                                padding: '12px 8px',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                gap: 8,
                                transition: 'all 0.2s ease'
                              }}
                            >
                              <div style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <SparkleIndicatorIcon fillColor="#ffffff" glowColor="rgba(255, 255, 255, 0.85)" size={30} />
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#ffffff' }}>{t('appearance.sparkleStyle')}</div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </>
                  )}

                  {/* ── GROUP: Typography ────────────────────────────────── */}
                  <div className="setting-group-label" style={{ marginTop: 20 }}>{t('appearance.typography')}</div>

                  <div className="setting-row vertical">
                    <div className="setting-info">
                      <div className="setting-title">{t('appearance.textSizeTitle')}</div>
                      <div className="setting-desc">{t('appearance.textSizeDesc')}</div>
                    </div>
                    <div className="setting-pills">
                      {[
                        { label: t('appearance.small'), val: 0.85 },
                        { label: t('appearance.normal'), val: 1.0 },
                        { label: t('appearance.large'), val: 1.15 }
                      ].map((opt) => (
                        <button
                          key={opt.label}
                          className={`pill ${Math.abs((settings.fontSizeScale ?? 1.0) - opt.val) < 0.05 ? 'active' : ''}`}
                          onClick={() => {
                            playButtonClickSound()
                            patch({ fontSizeScale: opt.val })
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="setting-divider" />

                  {/* ── GROUP: Audio & Feedback ──────────────────────────── */}
                  <div className="setting-group-label" style={{ marginTop: 20 }}>{t('appearance.audioAndFeedback')}</div>

                  <div className="setting-row">
                    <div className="setting-info">
                      <div className="setting-title">{t('behaviour.soundEffectsTitle')}</div>
                      <div className="setting-desc">{t('behaviour.soundEffectsDesc')}</div>
                    </div>
                    <Toggle
                      checked={settings.soundEffects ?? true}
                      onChange={(v) => {
                        if (v) playToggleSound(true)
                        patch({ soundEffects: v })
                      }}
                    />
                  </div>

                  {PersistentFooter}
                </motion.div>
              )}

              {/* ── Tab 4: Tasks (fork additions: AI providers & memory) ── */}
              {activeTab === 'tasks' && (
                <motion.div
                  key="tab-tasks"
                  initial={{ opacity: 0, scale: 0.98, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                  {/* ── GROUP: Tasks ──────────────────────────────────────── */}
                  <div className="setting-group-label">{t('tabs.tasks')}</div>

                  <AIProviderSection />

                  <div className="setting-divider" />

                  <MemorySection />

                  {PersistentFooter}
                </motion.div>
              )}
            </AnimatePresence>

          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`setting-toggle${checked ? ' checked' : ''}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        playToggleSound(!checked)
        onChange(!checked)
      }}
      style={{
        flexShrink: 0,
        width: 38,
        height: 22,
        borderRadius: 999,
        background: disabled ? 'rgba(255, 255, 255, 0.05)' : checked ? '#ffffff' : 'rgba(255, 255, 255, 0.12)',
        border: disabled ? '1px solid rgba(255, 255, 255, 0.08)' : checked ? '1px solid #ffffff' : '1px solid rgba(255, 255, 255, 0.18)',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 0,
        outline: 'none',
        transition: 'background 0.22s ease, border-color 0.22s ease',
        boxShadow: !disabled && checked ? '0 0 12px rgba(255, 255, 255, 0.25)' : 'none',
        opacity: disabled ? 0.45 : 1
      }}
    >
      <motion.span
        className="toggle-thumb"
        initial={false}
        animate={{
          x: checked ? 18 : 2,
          backgroundColor: checked ? '#000000' : '#ffffff'
        }}
        transition={{
          type: 'spring',
          stiffness: 600,
          damping: 35
        }}
        style={{
          position: 'absolute',
          top: 2,
          left: 0,
          width: 16,
          height: 16,
          borderRadius: '50%',
          boxShadow: '0 1.5px 4px rgba(0, 0, 0, 0.4)'
        }}
      />
    </button>
  )
}

function LanguageDropdown() {
  const { language, languages } = useTranslation()
  const patch = useStore((s) => s.patchSettings)
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const lastScrollTick = useRef<number>(0)

  const selectedLang = languages.find((l) => l.code === (language || 'system')) || languages[0]

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      window.addEventListener('mousedown', handleClickOutside)
    }
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  useEffect(() => {
    if (isOpen && listRef.current) {
      const activeBtn = listRef.current.querySelector<HTMLButtonElement>('[data-active="true"]')
      if (activeBtn) {
        if (selectedLang.code === 'system') {
          listRef.current.scrollTop = 0
        } else {
          listRef.current.scrollTop = Math.max(0, activeBtn.offsetTop - 4)
        }
      }
    }
  }, [isOpen, selectedLang.code])

  return (
    <div ref={dropdownRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        onClick={() => {
          playButtonClickSound()
          setIsOpen(!isOpen)
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: isOpen ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.05)',
          color: '#ffffff',
          border: isOpen ? '1px solid rgba(255, 255, 255, 0.22)' : '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 10,
          padding: '8px 12px',
          fontSize: 12.5,
          fontWeight: 500,
          outline: 'none',
          cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
          transition: 'all 0.15s ease'
        }}
      >
        <span>{selectedLang.nativeName}</span>
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          style={{ display: 'flex', alignItems: 'center', color: 'rgba(255, 255, 255, 0.6)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </motion.span>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            ref={listRef}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            onScroll={(e) => {
              const tick = Math.floor(e.currentTarget.scrollTop / 28)
              if (tick !== lastScrollTick.current) {
                lastScrollTick.current = tick
                playDialTickSound()
              }
            }}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              maxHeight: 200,
              overflowY: 'auto',
              background: '#121214',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              borderRadius: 10,
              padding: '4px',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05)',
              zIndex: 100,
              scrollbarWidth: 'none'
            }}
          >
            {languages.map((lang) => {
              const active = lang.code === (language || 'system')
              return (
                <button
                  key={lang.code}
                  type="button"
                  data-active={active ? 'true' : 'false'}
                  onClick={() => {
                    playButtonClickSound()
                    patch({ language: lang.code })
                    setIsOpen(false)
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 10px',
                    borderRadius: 7,
                    background: active ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
                    color: active ? '#ffffff' : 'rgba(255, 255, 255, 0.8)',
                    fontSize: 12,
                    fontWeight: active ? 600 : 400,
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.12s ease'
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.07)'
                    playDialTickSound()
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <span>{lang.nativeName}</span>
                  {active && <span style={{ color: '#4caf50', fontSize: 13, fontWeight: 700 }}>✓</span>}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * AI Provider chain editor: ordered list (first = primary, auto-failover),
 * inline editing, per-provider connection test with status, local Ollama
 * detection. State is local to the section; the chain itself lives in
 * settings.aiProviders (main is the single source of truth).
 */
function AIProviderSection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)
  const patch = useStore((s) => s.patchSettings)
  const providers = settings.aiProviders ?? []

  const [testStates, setTestStates] = useState<Record<string, { status: 'testing' | 'ok' | 'fail'; detail?: string; thinkingModel?: boolean }>>({})
  const [detectState, setDetectState] = useState<{ status: 'idle' | 'detecting' | 'ok' | 'fail'; detail?: string }>({ status: 'idle' })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderConfig | null>(null)

  const hasChainFailure = Object.values(testStates).some((s) => s.status === 'fail')

  const setProviders = (next: ProviderConfig[]) => patch({ aiProviders: next })

  const moveProvider = (index: number, dir: -1 | 1) => {
    const target = index + dir
    if (target < 0 || target >= providers.length) return
    const next = [...providers]
    ;[next[index], next[target]] = [next[target], next[index]]
    playButtonClickSound()
    setProviders(next)
  }

  /** Add a blank custom cloud provider and open it for editing right away. */
  const addCloudProvider = () => {
    const provider: ProviderConfig = {
      id: `cloud-${Date.now().toString(36)}`,
      baseUrl: '',
      model: '',
      apiKey: '',
      kind: 'cloud',
      supportsSchemaOutput: false
    }
    playButtonClickSound()
    setProviders([...providers, provider])
    setExpandedId(provider.id)
    setDraft({ ...provider })
  }

  /**
   * Add local model = detect Ollama on the machine, then wire it up. When a
   * local provider already exists the card is revealed instead of duplicated.
   */
  const addLocalModel = async () => {
    playButtonClickSound()
    setDetectState({ status: 'detecting' })
    const res = await window.edge.detectOllama()
    if (!res.found) {
      setDetectState({ status: 'fail', detail: res.error ?? '' })
      return
    }
    const existing = providers.find((p) => p.kind === 'local' && p.baseUrl.includes('127.0.0.1:11434'))
    if (existing) {
      setDetectState({ status: 'ok', detail: res.models?.join(', ') ?? '' })
      setExpandedId(existing.id)
      setDraft({ ...existing })
      return
    }
    const model = res.models?.find((m) => /qwen3/i.test(m)) ?? res.models?.[0] ?? 'qwen3:8b'
    const provider: ProviderConfig = {
      id: `local-${Date.now().toString(36)}`,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model,
      kind: 'local',
      supportsSchemaOutput: true
    }
    setProviders([...providers, provider])
    setExpandedId(provider.id)
    setDraft({ ...provider })
    setDetectState({ status: 'ok', detail: model })
  }

  /** Click a card to open/close its editor; reopening syncs the draft. */
  const toggleExpand = (id: string) => {
    playButtonClickSound()
    if (expandedId === id) {
      setExpandedId(null)
      setDraft(null)
      return
    }
    const provider = providers.find((p) => p.id === id)
    setExpandedId(id)
    setDraft(provider ? { ...provider } : null)
  }

  const commitDraft = () => {
    if (!draft || draft.id !== expandedId) return
    setProviders(providers.map((p) => (p.id === draft.id ? { ...draft, baseUrl: draft.baseUrl.trim() } : p)))
  }

  const testProvider = async (p: ProviderConfig) => {
    setTestStates((s) => ({ ...s, [p.id]: { status: 'testing' } }))
    const res = await window.edge.testProvider(p)
    setTestStates((s) => ({
      ...s,
      [p.id]: res.ok
        ? { status: 'ok', detail: String(res.latencyMs ?? 0), thinkingModel: res.thinkingModel }
        : { status: 'fail', detail: res.error ?? '' }
    }))
  }

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.15)',
    background: 'rgba(255, 255, 255, 0.06)',
    color: '#fff',
    fontSize: 12,
    outline: 'none',
    boxSizing: 'border-box'
  }

  const iconBtn: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: 6,
    border: 'none',
    background: 'rgba(255, 255, 255, 0.08)',
    color: 'rgba(255, 255, 255, 0.85)',
    cursor: 'pointer',
    fontSize: 11,
    lineHeight: 1,
    padding: 0,
    flexShrink: 0
  }

  return (
    <>
      <div className="setting-group-label">{t('ai.sectionTitle')}</div>
      <div className="setting-desc" style={{ marginTop: 2, marginBottom: 8 }}>{t('ai.sectionDesc')}</div>

      {providers.length === 0 && (
        <div className="setting-desc" style={{ marginBottom: 8, opacity: 0.7 }}>{t('ai.noProviders')}</div>
      )}

      {providers.map((p, i) => {
        const test = testStates[p.id]
        const isExpanded = expandedId === p.id
        const isDraft = draft && draft.id === p.id ? draft : p
        return (
          <div key={p.id} className="setting-row vertical" style={{ gap: 8 }}>
            {/* Layer 1: click-to-edit summary (chevron + status + model + actions) */}
            <div
              className="provider-summary"
              role="button"
              tabIndex={0}
              aria-expanded={isExpanded}
              title={t('ai.edit')}
              onClick={() => toggleExpand(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleExpand(p.id)
                }
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', cursor: 'pointer', outline: 'none' }}
            >
              <motion.span
                animate={{ rotate: isExpanded ? 90 : 0 }}
                transition={{ duration: 0.15 }}
                style={{ display: 'flex', alignItems: 'center', flexShrink: 0, color: 'rgba(255, 255, 255, 0.5)' }}
              >
                <ChevronRightIcon width={12} height={12} />
              </motion.span>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: p.kind === 'local' ? '#4ade80' : '#60a5fa'
                }}
                title={p.kind === 'local' ? t('ai.kindLocal') : t('ai.kindCloud')}
              />
              <span
                className="setting-title"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  ...(isDraft.model ? {} : { color: 'rgba(255, 255, 255, 0.45)', fontWeight: 500 })
                }}
                title={isDraft.model || t('ai.unnamedModel')}
              >
                {isDraft.model || t('ai.unnamedModel')}
              </span>
              <button
                style={{ ...iconBtn, ...(i === 0 ? { opacity: 0.35, cursor: 'default' } : {}) }}
                disabled={i === 0}
                title={t('ai.moveUp')}
                onClick={(e) => { e.stopPropagation(); moveProvider(i, -1) }}
              >
                <ChevronRightIcon width={12} height={12} style={{ transform: 'rotate(-90deg)' }} />
              </button>
              <button
                style={{ ...iconBtn, ...(i === providers.length - 1 ? { opacity: 0.35, cursor: 'default' } : {}) }}
                disabled={i === providers.length - 1}
                title={t('ai.moveDown')}
                onClick={(e) => { e.stopPropagation(); moveProvider(i, 1) }}
              >
                <ChevronRightIcon width={12} height={12} style={{ transform: 'rotate(90deg)' }} />
              </button>
              <button
                style={iconBtn}
                title={t('ai.remove')}
                onClick={(e) => {
                  e.stopPropagation()
                  playButtonClickSound()
                  setProviders(providers.filter((x) => x.id !== p.id))
                  if (expandedId === p.id) {
                    setExpandedId(null)
                    setDraft(null)
                  }
                }}
              >
                <CloseIcon width={10} height={10} />
              </button>
            </div>
            {/* Layer 2: baseUrl + test button + full test status (wraps, never truncates) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', flexWrap: 'wrap' }}>
              <div
                className="setting-desc"
                style={{ flex: 1, minWidth: 0, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(p.baseUrl ? {} : { color: 'rgba(255, 255, 255, 0.35)' }) }}
                title={p.baseUrl}
              >
                {p.baseUrl || 'https://api.example.com/v1'}
              </div>
              <button
                className="pill display-pill"
                style={{ padding: '4px 10px', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}
                onClick={() => { playButtonClickSound(); void testProvider(isDraft) }}
              >
                {t('ai.test')}
              </button>
              {test?.status === 'testing' && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' }}>{t('ai.testing')}</span>}
              {test?.status === 'ok' && <span style={{ fontSize: 11, color: '#4caf50', whiteSpace: 'nowrap' }}>✓ {t('ai.testOk', { ms: test.detail ?? '' })}</span>}
              {test?.status === 'fail' && <span style={{ fontSize: 11, color: '#ff6b6b', overflowWrap: 'anywhere' }}>✗ {t('ai.testFailed', { error: test.detail ?? '' })}</span>}
              {test?.status === 'ok' && test.thinkingModel && (
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', overflowWrap: 'anywhere' }}>
                  {t('ai.thinkingModelHint')}
                </span>
              )}
            </div>

            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  className="provider-editor"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                    {t('ai.baseUrl')}
                    <input
                      style={{ ...inputStyle, marginTop: 4 }}
                      value={isDraft.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={(e) => setDraft({ ...isDraft, baseUrl: e.target.value })}
                      onBlur={commitDraft}
                    />
                  </label>
                  <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                    {t('ai.apiKey')}
                    <input
                      style={{ ...inputStyle, marginTop: 4 }}
                      value={isDraft.apiKey ?? ''}
                      placeholder="sk-…"
                      onChange={(e) => setDraft({ ...isDraft, apiKey: e.target.value })}
                      onBlur={commitDraft}
                    />
                  </label>
                  <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                    {t('ai.model')}
                    <input
                      style={{ ...inputStyle, marginTop: 4 }}
                      value={isDraft.model}
                      placeholder="model-name"
                      onChange={(e) => setDraft({ ...isDraft, model: e.target.value })}
                      onBlur={commitDraft}
                    />
                  </label>
                  <div className="setting-row" style={{ width: '100%' }}>
                    <div className="setting-info">
                      <div className="setting-title" style={{ fontSize: 12 }}>{t('ai.schemaOutput')}</div>
                    </div>
                    <Toggle
                      checked={isDraft.supportsSchemaOutput !== false}
                      onChange={(v) => { setDraft({ ...isDraft, supportsSchemaOutput: v }); setProviders(providers.map((x) => (x.id === p.id ? { ...x, supportsSchemaOutput: v } : x))) }}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button
          className="pill display-pill"
          style={{ flex: '1 1 auto', minWidth: 'max-content', flexDirection: 'row', gap: 6, padding: '8px 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}
          onClick={() => void addLocalModel()}
        >
          <PlusIcon width={12} height={12} />
          {t('ai.addLocalModel')}
        </button>
        <button
          className="pill display-pill"
          style={{ flex: '1 1 auto', minWidth: 'max-content', flexDirection: 'row', gap: 6, padding: '8px 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}
          onClick={addCloudProvider}
        >
          <PlusIcon width={12} height={12} />
          {t('ai.addCloudProvider')}
        </button>
      </div>

      {detectState.status === 'detecting' && <div className="setting-desc" style={{ marginTop: 8, fontSize: 11.5 }}>{t('ai.detecting')}</div>}
      {detectState.status === 'ok' && <div className="setting-desc" style={{ marginTop: 8, color: '#4caf50', fontSize: 11.5 }}>{t('ai.detectFound', { model: detectState.detail ?? '' })}</div>}
      {detectState.status === 'fail' && <div className="setting-desc" style={{ marginTop: 8, color: '#ff6b6b', fontSize: 11.5 }}>{t('ai.detectNotFound')}{detectState.detail ? ` (${detectState.detail})` : ''}</div>}
      {hasChainFailure && <div className="setting-desc" style={{ marginTop: 8, opacity: 0.7 }}>{t('ai.chainHint')}</div>}
    </>
  )
}

/**
 * Long-term memory panel: candidates await a decision, confirmed memories are
 * viewable/deletable, cleanup candidates are the decayed ones the user
 * confirms for deletion, banned patterns are viewable and un-bannable. Decay
 * thresholds are shown read-only (their only editor is settings:update).
 */
function MemorySection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)
  const memories = useStore((s) => s.memories)
  const loadMemories = useStore((s) => s.loadMemories)
  const actMemory = useStore((s) => s.actMemory)

  useEffect(() => {
    void loadMemories()
  }, [loadMemories])

  const typeLabel = (type: Memory['type']): string => {
    switch (type) {
      case 'identity': return t('memory.typeIdentity')
      case 'tool': return t('memory.typeTool')
      case 'project': return t('memory.typeProject')
      case 'workflow': return t('memory.typeWorkflow')
    }
  }

  const sourceLabel = (m: Memory): string => {
    switch (m.source) {
      case 'task-feedback': return t('memory.sourceTaskFeedback')
      case 'ai-suggest': return t('memory.sourceAiSuggest')
      case 'user': return t('memory.sourceUser')
    }
  }

  const act = (id: string, action: MemoryAction): void => {
    playButtonClickSound()
    void actMemory(id, action)
  }

  const rowActions = (m: Memory, actions: Array<{ action: MemoryAction; label: string; danger?: boolean }>) => (
    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
      {actions.map((a) => (
        <button
          key={a.action}
          className="pill display-pill"
          style={{
            padding: '3px 8px',
            fontSize: 10.5,
            cursor: 'pointer',
            ...(a.danger ? { color: '#ff8a8a' } : {})
          }}
          onClick={() => act(m.id, a.action)}
        >
          {a.label}
        </button>
      ))}
    </div>
  )

  const metaLine = (m: Memory) => (
    <div className="setting-desc" style={{ fontSize: 10, opacity: 0.75 }}>
      {typeLabel(m.type)} · {sourceLabel(m)} · {t('memory.confidence', { value: Math.round(m.confidence * 100) })} · {t('memory.hitCount', { count: m.hitCount })}
    </div>
  )

  const memoryRow = (m: Memory, actions: Array<{ action: MemoryAction; label: string; danger?: boolean }>) => (
    <div key={m.id} className="setting-row vertical" style={{ gap: 2, padding: '6px 0' }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.35, wordBreak: 'break-word' }}>{m.content}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
        <div style={{ flex: 1, minWidth: 0 }}>{metaLine(m)}</div>
        {rowActions(m, actions)}
      </div>
    </div>
  )

  return (
    <>
      <div className="setting-group-label">{t('memory.sectionTitle')}</div>
      <div className="setting-desc" style={{ marginTop: 2, marginBottom: 8 }}>{t('memory.sectionDesc')}</div>

      {/* Decay thresholds, read-only: their editor is settings:update. */}
      <div className="setting-row vertical" style={{ gap: 2 }}>
        <div className="setting-title" style={{ fontSize: 12 }}>{t('memory.thresholdsTitle')}</div>
        <div className="setting-desc" style={{ fontSize: 10.5 }}>
          {t('memory.thresholdsDesc', {
            lambda: settings.memoryLambda,
            days: settings.memoryStaleDays,
            score: settings.memoryCleanupScore
          })}
        </div>
      </div>

      <div className="setting-divider" />

      {/* Candidates: pending user decisions. */}
      <div className="setting-title" style={{ fontSize: 12, marginBottom: 2 }}>{t('memory.candidatesTitle')}</div>
      {!memories ? null : memories.candidates.length === 0 ? (
        <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.6 }}>{t('memory.candidatesEmpty')}</div>
      ) : (
        memories.candidates.map((m) => memoryRow(m, [
          { action: 'confirm', label: t('memory.save') },
          { action: 'ignore', label: t('memory.ignore') },
          { action: 'ban', label: t('memory.ban'), danger: true }
        ]))
      )}

      <div className="setting-divider" />

      {/* Confirmed: live memories, deletable. */}
      <div className="setting-title" style={{ fontSize: 12, marginBottom: 2 }}>{t('memory.confirmedTitle')}</div>
      {!memories ? null : memories.confirmed.length === 0 ? (
        <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.6 }}>{t('memory.confirmedEmpty')}</div>
      ) : (
        memories.confirmed.map((m) => memoryRow(m, [{ action: 'delete', label: t('memory.delete'), danger: true }]))
      )}

      <div className="setting-divider" />

      {/* Cleanup: stale + low-score, deletion awaits the user. */}
      <div className="setting-title" style={{ fontSize: 12, marginBottom: 2 }}>{t('memory.cleanupTitle')}</div>
      <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.75, marginBottom: 4 }}>{t('memory.cleanupDesc')}</div>
      {!memories ? null : memories.cleanup.length === 0 ? (
        <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.6 }}>{t('memory.cleanupEmpty')}</div>
      ) : (
        memories.cleanup.map((m) => memoryRow(m, [{ action: 'delete', label: t('memory.delete'), danger: true }]))
      )}

      <div className="setting-divider" />

      {/* Banned: pattern vetoes, viewable and un-bannable. */}
      <div className="setting-title" style={{ fontSize: 12, marginBottom: 2 }}>{t('memory.bannedTitle')}</div>
      {!memories ? null : memories.banned.length === 0 ? (
        <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.6 }}>{t('memory.bannedEmpty')}</div>
      ) : (
        memories.banned.map((m) => memoryRow(m, [{ action: 'unban', label: t('memory.unban') }]))
      )}
    </>
  )
}
