/**
 * Settings clamping — pure module.
 *
 * settings.ts cannot be imported from vitest (it pulls in electron via PATHS),
 * so the clamp rules live here, keeping the merge/load/persist glue in
 * settings.ts thin. Behaviour is identical to the pre-t11 inline clamps.
 */
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types'
import { isThemeColor } from '../../shared/themes'

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : fallback)))
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback))
}

/** Clamp every settable field into its valid range; fall back on garbage. */
export function clampSettings(input: Settings): Settings {
  const out = { ...input } as Settings
  // Existing clipboard/UI sliders (moved verbatim from settings.ts merge()).
  out.hotZoneHeight = Math.min(0.6, Math.max(0.2, out.hotZoneHeight))
  out.historyLimit = Math.min(2000, Math.max(50, Math.round(out.historyLimit)))
  out.autoDeleteHours = Math.max(0, Number(out.autoDeleteHours) || 0)
  out.verticalOffset = Math.min(1.0, Math.max(0.0, typeof out.verticalOffset === 'number' ? out.verticalOffset : 0.5))
  if (out.uiStyle !== 'modern' && out.uiStyle !== 'compact') {
    out.uiStyle = 'modern'
  }
  if (!isThemeColor(out.themeColor)) {
    out.themeColor = DEFAULT_SETTINGS.themeColor
  }
  if (out.triggerAlignment !== 'top' && out.triggerAlignment !== 'center' && out.triggerAlignment !== 'bottom') {
    out.triggerAlignment = 'center'
  }
  if (typeof out.language !== 'string' || !out.language.trim()) {
    out.language = 'system'
  }
  // Task domain (t11): master switches default on; anything but an explicit false is true.
  out.taskCaptureEnabled = out.taskCaptureEnabled !== false
  out.l0CaptureEnabled = out.l0CaptureEnabled !== false
  // State machine: idle-to-paused threshold in minutes (1-120, default 15).
  out.taskPauseThresholdMinutes = clampInt(out.taskPauseThresholdMinutes, 1, 120, 15)
  // Proposal triggers.
  out.suggestionMinEvents = clampInt(out.suggestionMinEvents, 1, 50, 5)
  out.suggestionSilenceSeconds = clampInt(out.suggestionSilenceSeconds, 30, 300, 60)
  // Confidence thresholds: θ_low in [0,1]; θ_high in [0,1] and strictly above θ_low.
  out.confidenceLow = clampNum(out.confidenceLow, 0, 1, 0.45)
  out.confidenceHigh = clampNum(out.confidenceHigh, out.confidenceLow + 0.01, 1, 0.7)
  // Memory decay params.
  out.memoryLambda = clampNum(out.memoryLambda, 0.01, 1, 0.25)
  out.memoryStaleDays = clampInt(out.memoryStaleDays, 7, 365, 60)
  out.memoryCleanupScore = clampNum(out.memoryCleanupScore, 0, 1, 0.1)
  // Provider chain: must stay an array (priority order = array order).
  out.aiProviders = Array.isArray(out.aiProviders) ? out.aiProviders : []
  // Landing page (ADR-0004): view must be a valid top-level view, filters
  // must match the view's second level; anything else falls back to defaults.
  const landing = out.landing
  if (!landing || typeof landing !== 'object') {
    out.landing = { ...DEFAULT_SETTINGS.landing }
  } else if (landing.view === 'clipboard') {
    const ok = ['all', 'text', 'links', 'images'].includes(landing.filter as string)
    out.landing = ok ? { view: 'clipboard', filter: landing.filter } : { view: 'clipboard', filter: 'all' }
  } else if (landing.view === 'tasks') {
    const ok = landing.filter === 'existing' || landing.filter === 'candidates'
    out.landing = ok ? { view: 'tasks', filter: landing.filter } : { view: 'tasks', filter: 'existing' }
  } else if (landing.view === 'files') {
    out.landing = { view: 'files' }
  } else {
    out.landing = { ...DEFAULT_SETTINGS.landing }
  }
  // Restore time (ADR-0004): enum only.
  const restoreTime = out.restoreTime
  out.restoreTime = restoreTime === 'instant' || restoreTime === 'relaxed' || restoreTime === 'delayed' || restoreTime === 'forever'
    ? restoreTime
    : 'relaxed'
  return out
}
