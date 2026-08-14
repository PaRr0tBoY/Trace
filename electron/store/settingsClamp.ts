/**
 * Settings clamping — pure module.
 *
 * settings.ts cannot be imported from vitest (it pulls in electron via PATHS),
 * so the clamp rules live here, keeping the merge/load/persist glue in
 * settings.ts thin. Behaviour is identical to the pre-t11 inline clamps.
 */
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types'
import { isThemeColor } from '../../shared/themes'
import { normalizeExePath } from './privacyGate'

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
  if (out.moveMode !== 'copy' && out.moveMode !== 'move') {
    out.moveMode = 'move'
  }
  // Animation richness: enum only; anything else falls back to standard.
  if (out.motionLevel !== 'standard' && out.motionLevel !== 'extended') {
    out.motionLevel = 'standard'
  }
  if (typeof out.language !== 'string' || !out.language.trim()) {
    out.language = 'system'
  }
  // Task domain (t11): master switches default on; anything but an explicit false is true.
  out.taskCaptureEnabled = out.taskCaptureEnabled !== false
  out.l0CaptureEnabled = out.l0CaptureEnabled !== false
  // Evidence timeline retention (t39, spec decision 2): 1-365 days, default 30.
  // Floor 1 keeps the events table bounded — unlike clipboard items
  // (autoDeleteHours 0 = never), the timeline must eventually reclaim space;
  // cap 365 mirrors the memoryStaleDays (7-365) range convention.
  out.evidenceRetentionDays = clampInt(out.evidenceRetentionDays, 1, 365, 30)
  // State machine: idle-to-paused threshold in minutes (1-120, default 15).
  out.taskPauseThresholdMinutes = clampInt(out.taskPauseThresholdMinutes, 1, 120, 15)
  // Current-task switch hysteresis (t55, spec 决策 5): candidate dwell 30-60s
  // (default 45), score margin 0-1 (default 0.1) — both gate switch execution.
  out.switchDwellSeconds = clampInt(out.switchDwellSeconds, 30, 60, 45)
  out.switchMargin = clampNum(out.switchMargin, 0, 1, 0.1)
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
  // AI trace retention (t41, spec 决策 8): unadopted rows purge after N days (1-365, default 30).
  out.traceRetentionDays = clampInt(out.traceRetentionDays, 1, 365, 30)
  // Provider chain: must stay an array (priority order = array order).
  out.aiProviders = Array.isArray(out.aiProviders) ? out.aiProviders : []
  // Privacy domain (t45, spec 决策 7/12; consumed by privacyGate in main).
  // Defaults mirror DEFAULT_POLICY: 全开显式可见.
  out.aiEnabled = out.aiEnabled !== false
  // Denied apps are exePath keys, normalized by the same rule privacyGate
  // matches on; dedupe + drop empty entries. Garbage → empty list (deny nothing).
  out.deniedApps = Array.isArray(out.deniedApps)
    ? [...new Set(out.deniedApps.filter((p): p is string => typeof p === 'string').map(normalizeExePath).filter((p) => p.length > 0))]
    : []
  // Content types: only the three known literals survive. Non-array garbage
  // falls back to all three; a valid array keeps its members ([] = the user
  // explicitly blocked every type, which privacyGate enforces as deny-all).
  out.allowedContentTypes = Array.isArray(out.allowedContentTypes)
    ? out.allowedContentTypes.filter((c) => c === 'text' || c === 'image' || c === 'files')
    : ['text', 'image', 'files']
  // Daily AI window end hour: 0–24 per privacyGate semantics; undefined = all
  // day. 24 is semantically all-day (hourOfDay < 24 always holds), so both
  // garbage and an explicit 24 normalize to undefined — every persisted value
  // then maps to a UI pill state (all-day/12/18/21/23) instead of a dangling 24.
  if (out.aiTimeRangeHours !== undefined) {
    const h = clampInt(out.aiTimeRangeHours, 0, 24, 24)
    out.aiTimeRangeHours = h === 24 ? undefined : h
  }
  out.clipboardAccess = out.clipboardAccess !== false
  out.memoryAccess = out.memoryAccess !== false
  out.memoryEnabled = out.memoryEnabled !== false
  // Local model (t54, spec 决策 11): optional enhancement — must be
  // EXPLICITLY true to enable (default off; 不变量 H: 关闭 = 功能等价).
  out.localModelEnabled = out.localModelEnabled === true
  // Source is the manager's LocalModelSource union; garbage → 'auto'.
  out.localModelSource = out.localModelSource === 'manual' ? 'manual' : 'auto'
  // Manual .gguf path: trimmed non-empty string or undefined. Existence is
  // validated by the manager at load time (fs belongs to the Electron glue,
  // not the pure clamp).
  out.localModelManualPath =
    typeof out.localModelManualPath === 'string' && out.localModelManualPath.trim().length > 0
      ? out.localModelManualPath.trim()
      : undefined
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
  // Alt+Tab window grouping: explicit true only (default off).
  out.switcherGroupWindows = out.switcherGroupWindows === true
  return out
}
