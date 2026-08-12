import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { clampSettings } from '../electron/store/settingsClamp'

/** A full settings object with every field overridden to an out-of-range value. */
function corrupt(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    hotZoneHeight: 9,
    historyLimit: 1,
    autoDeleteHours: -5,
    verticalOffset: 7,
    uiStyle: 'garbage' as never,
    triggerAlignment: 'garbage' as never,
    language: '  ',
    taskPauseThresholdMinutes: 0,
    suggestionMinEvents: 0,
    suggestionSilenceSeconds: 10,
    evidenceRetentionDays: 999,
    confidenceHigh: 0.1,
    confidenceLow: 0.9,
    memoryLambda: 99,
    memoryStaleDays: 1,
    memoryCleanupScore: -1,
    aiProviders: 'nope' as never
  }
}

describe('clampSettings — task domain fields', () => {
  it('clamps the idle-to-paused threshold to 1-120 minutes', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS, taskPauseThresholdMinutes: 0 }).taskPauseThresholdMinutes).toBe(1)
    expect(clampSettings({ ...DEFAULT_SETTINGS, taskPauseThresholdMinutes: 999 }).taskPauseThresholdMinutes).toBe(120)
    expect(clampSettings({ ...DEFAULT_SETTINGS, taskPauseThresholdMinutes: 15.6 }).taskPauseThresholdMinutes).toBe(16)
    expect(clampSettings({ ...DEFAULT_SETTINGS, taskPauseThresholdMinutes: NaN }).taskPauseThresholdMinutes).toBe(15)
  })

  it('clamps suggestion triggers to their ranges with defaults on garbage', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS, suggestionMinEvents: 0 }).suggestionMinEvents).toBe(1)
    expect(clampSettings({ ...DEFAULT_SETTINGS, suggestionMinEvents: 99 }).suggestionMinEvents).toBe(50)
    expect(clampSettings({ ...DEFAULT_SETTINGS, suggestionSilenceSeconds: 10 }).suggestionSilenceSeconds).toBe(30)
    expect(clampSettings({ ...DEFAULT_SETTINGS, suggestionSilenceSeconds: 999 }).suggestionSilenceSeconds).toBe(300)
    expect(clampSettings({ ...DEFAULT_SETTINGS, suggestionMinEvents: NaN }).suggestionMinEvents).toBe(5)
    expect(clampSettings({ ...DEFAULT_SETTINGS, suggestionSilenceSeconds: NaN }).suggestionSilenceSeconds).toBe(60)
  })

  it('keeps θ_high strictly above θ_low after clamping', () => {
    const out = clampSettings(corrupt()) // low=0.9, high=0.1 -> low stays 0.9, high pushed up
    expect(out.confidenceLow).toBe(0.9)
    expect(out.confidenceHigh).toBeGreaterThan(out.confidenceLow)
    expect(out.confidenceHigh).toBe(0.91)
  })

  it('clamps memory decay params', () => {
    const out = clampSettings({ ...DEFAULT_SETTINGS, memoryLambda: 99, memoryStaleDays: 1, memoryCleanupScore: -1 })
    expect(out.memoryLambda).toBe(1)
    expect(out.memoryStaleDays).toBe(7)
    expect(out.memoryCleanupScore).toBe(0)
  })

  it('clamps evidence retention to 1-365 days with a 30-day default', () => {
    expect(clampSettings(corrupt()).evidenceRetentionDays).toBe(365)
    expect(clampSettings({ ...DEFAULT_SETTINGS, evidenceRetentionDays: 0 }).evidenceRetentionDays).toBe(1)
    expect(clampSettings({ ...DEFAULT_SETTINGS, evidenceRetentionDays: -3 }).evidenceRetentionDays).toBe(1)
    expect(clampSettings({ ...DEFAULT_SETTINGS, evidenceRetentionDays: 'garbage' as never }).evidenceRetentionDays).toBe(30)
    expect(clampSettings(DEFAULT_SETTINGS).evidenceRetentionDays).toBe(30)
  })

  it('forces the provider chain to be an array', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS, aiProviders: undefined as never }).aiProviders).toEqual([])
    const providers = [{ id: 'p1', baseUrl: 'http://localhost:8080/v1', model: 'qwen3' }]
    expect(clampSettings({ ...DEFAULT_SETTINGS, aiProviders: providers }).aiProviders).toEqual(providers)
  })

  it('keeps master switches on unless explicitly false', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS }).taskCaptureEnabled).toBe(true)
    expect(clampSettings({ ...DEFAULT_SETTINGS }).l0CaptureEnabled).toBe(true)
    const off = clampSettings({
      ...DEFAULT_SETTINGS,
      taskCaptureEnabled: false,
      l0CaptureEnabled: false
    })
    expect(off.taskCaptureEnabled).toBe(false)
    expect(off.l0CaptureEnabled).toBe(false)
  })

  it('clamps the landing page to a valid view + matching second level', () => {
    const ok = clampSettings({ ...DEFAULT_SETTINGS, landing: { view: 'tasks', filter: 'candidates' } })
    expect(ok.landing).toEqual({ view: 'tasks', filter: 'candidates' })
    expect(clampSettings({ ...DEFAULT_SETTINGS, landing: { view: 'tasks', filter: 'bogus' as never } }).landing).toEqual({ view: 'tasks', filter: 'existing' })
    expect(clampSettings({ ...DEFAULT_SETTINGS, landing: { view: 'clipboard', filter: 'images' } }).landing).toEqual({ view: 'clipboard', filter: 'images' })
    expect(clampSettings({ ...DEFAULT_SETTINGS, landing: { view: 'clipboard', filter: 'bogus' as never } }).landing).toEqual({ view: 'clipboard', filter: 'all' })
    expect(clampSettings({ ...DEFAULT_SETTINGS, landing: { view: 'files', filter: 'anything' as never } }).landing).toEqual({ view: 'files' })
    expect(clampSettings({ ...DEFAULT_SETTINGS, landing: 'garbage' as never }).landing).toEqual(DEFAULT_SETTINGS.landing)
  })

  it('clamps restore time to the four presets', () => {
    expect(clampSettings({ ...DEFAULT_SETTINGS, restoreTime: 'instant' }).restoreTime).toBe('instant')
    expect(clampSettings({ ...DEFAULT_SETTINGS, restoreTime: 'delayed' }).restoreTime).toBe('delayed')
    expect(clampSettings({ ...DEFAULT_SETTINGS, restoreTime: 'forever' }).restoreTime).toBe('forever')
    expect(clampSettings({ ...DEFAULT_SETTINGS, restoreTime: 'bogus' as never }).restoreTime).toBe('relaxed')
  })
})

describe('clampSettings — privacy domain (t45, spec 决策 12)', () => {
  it('keeps privacy master switches on unless explicitly false', () => {
    const all = clampSettings(DEFAULT_SETTINGS)
    expect(all.aiEnabled).toBe(true)
    expect(all.clipboardAccess).toBe(true)
    expect(all.memoryAccess).toBe(true)
    expect(all.memoryEnabled).toBe(true)
    const off = clampSettings({
      ...DEFAULT_SETTINGS,
      aiEnabled: false,
      clipboardAccess: false,
      memoryAccess: false,
      memoryEnabled: false
    })
    expect(off.aiEnabled).toBe(false)
    expect(off.clipboardAccess).toBe(false)
    expect(off.memoryAccess).toBe(false)
    expect(off.memoryEnabled).toBe(false)
  })

  it('normalizes and dedupes the denied-app list with the privacyGate key rule', () => {
    const out = clampSettings({
      ...DEFAULT_SETTINGS,
      deniedApps: ['  C:\\Windows\\Notepad.EXE  ', 'c:/windows/notepad.exe', 'chrome.exe', '', 42 as never]
    })
    expect(out.deniedApps).toEqual(['c:/windows/notepad.exe', 'chrome.exe'])
    expect(clampSettings({ ...DEFAULT_SETTINGS, deniedApps: 'garbage' as never }).deniedApps).toEqual([])
  })

  it('keeps only the three known content types; garbage falls back to all three', () => {
    expect(clampSettings(DEFAULT_SETTINGS).allowedContentTypes).toEqual(['text', 'image', 'files'])
    const out = clampSettings({ ...DEFAULT_SETTINGS, allowedContentTypes: ['text', 'video' as never, 'files'] })
    expect(out.allowedContentTypes).toEqual(['text', 'files'])
    // An explicit empty list survives — the user blocked every type on purpose.
    expect(clampSettings({ ...DEFAULT_SETTINGS, allowedContentTypes: [] }).allowedContentTypes).toEqual([])
    expect(clampSettings({ ...DEFAULT_SETTINGS, allowedContentTypes: 'garbage' as never }).allowedContentTypes).toEqual(['text', 'image', 'files'])
  })

  it('clamps the daily AI window hour to 0-24; undefined stays all-day', () => {
    expect(clampSettings(DEFAULT_SETTINGS).aiTimeRangeHours).toBeUndefined()
    expect(clampSettings({ ...DEFAULT_SETTINGS, aiTimeRangeHours: 18 }).aiTimeRangeHours).toBe(18)
    expect(clampSettings({ ...DEFAULT_SETTINGS, aiTimeRangeHours: -1 }).aiTimeRangeHours).toBe(0)
    // 24 is semantically all-day (hourOfDay < 24 always holds); normalize to
    // undefined so every persisted value maps to a UI pill (all-day/12/18/21/23).
    expect(clampSettings({ ...DEFAULT_SETTINGS, aiTimeRangeHours: 24 }).aiTimeRangeHours).toBeUndefined()
    expect(clampSettings({ ...DEFAULT_SETTINGS, aiTimeRangeHours: 99 }).aiTimeRangeHours).toBeUndefined()
    expect(clampSettings({ ...DEFAULT_SETTINGS, aiTimeRangeHours: NaN }).aiTimeRangeHours).toBeUndefined()
  })
})

describe('clampSettings — existing fields keep their behaviour', () => {
  it('preserves the legacy slider/enum clamps', () => {
    const out = clampSettings(corrupt())
    expect(out.hotZoneHeight).toBe(0.6)
    expect(out.historyLimit).toBe(50)
    expect(out.autoDeleteHours).toBe(0)
    expect(out.verticalOffset).toBe(1.0)
    expect(out.uiStyle).toBe('modern')
    expect(out.triggerAlignment).toBe('center')
    expect(out.language).toBe('system')
  })

  it('leaves valid settings untouched', () => {
    const valid = {
      ...DEFAULT_SETTINGS,
      hotZoneHeight: 0.3,
      historyLimit: 500,
      taskPauseThresholdMinutes: 30,
      confidenceHigh: 0.8,
      confidenceLow: 0.5
    }
    expect(clampSettings(valid)).toEqual(valid)
  })
})
