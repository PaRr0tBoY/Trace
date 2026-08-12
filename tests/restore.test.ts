/**
 * Restore decision (ADR-0004): TTL presets, first-launch, edit protection,
 * tutorial exclusion.
 */
import { describe, expect, it } from 'vitest'
import { RESTORE_TTL_MS, shouldRestoreToLanding, type RestoreContext } from '../src/lib/restore'
import type { Settings } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

function ctx(overrides: Partial<RestoreContext> & { restoreTime?: Settings['restoreTime']; tutorialCompleted?: boolean; now?: number } = {}): RestoreContext {
  const { restoreTime = 'relaxed', tutorialCompleted = true, now, ...rest } = overrides
  return {
    settings: { ...DEFAULT_SETTINGS, restoreTime, tutorialCompleted },
    lastClosedAt: 0,
    editingTask: null,
    editingSuggestionId: null,
    now,
    ...rest
  }
}

describe('RESTORE_TTL_MS presets', () => {
  it('maps the four documented presets', () => {
    expect(RESTORE_TTL_MS.instant).toBe(0)
    expect(RESTORE_TTL_MS.relaxed).toBe(10_000)
    expect(RESTORE_TTL_MS.delayed).toBe(600_000)
  })
})

describe('shouldRestoreToLanding', () => {
  it('restores on first launch regardless of restore time', () => {
    expect(shouldRestoreToLanding(ctx({ restoreTime: 'forever', lastClosedAt: 0 }))).toBe(true)
    expect(shouldRestoreToLanding(ctx({ restoreTime: 'instant', lastClosedAt: 0 }))).toBe(true)
  })

  it('keeps the page within the TTL and restores after it', () => {
    expect(shouldRestoreToLanding(ctx({ lastClosedAt: 1000, now: 5000 }))).toBe(false)
    expect(shouldRestoreToLanding(ctx({ lastClosedAt: 1000, now: 11_000 }))).toBe(true)
  })

  it('restores immediately with instant (TTL 0)', () => {
    expect(shouldRestoreToLanding(ctx({ restoreTime: 'instant', lastClosedAt: 1000, now: 1001 }))).toBe(true)
  })

  it('keeps the page for 10 minutes with delayed', () => {
    expect(shouldRestoreToLanding(ctx({ restoreTime: 'delayed', lastClosedAt: 1000, now: 1000 + 600_000 - 1 }))).toBe(false)
    expect(shouldRestoreToLanding(ctx({ restoreTime: 'delayed', lastClosedAt: 1000, now: 1000 + 600_000 }))).toBe(true)
  })

  it('never restores when the clock reads before the close anchor', () => {
    expect(shouldRestoreToLanding(ctx({ restoreTime: 'instant', lastClosedAt: 5000, now: 1000 }))).toBe(false)
  })

  it('never restores with forever after first launch', () => {
    expect(shouldRestoreToLanding(ctx({ restoreTime: 'forever', lastClosedAt: 1000, now: 999_999_999 }))).toBe(false)
  })

  it('skips the restore while the tutorial is in progress', () => {
    expect(shouldRestoreToLanding(ctx({ lastClosedAt: 1, now: 999_999_999, tutorialCompleted: false }))).toBe(false)
  })

  it('applies the landing page on first launch even mid-tutorial', () => {
    expect(shouldRestoreToLanding(ctx({ lastClosedAt: 0, now: 999_999_999, tutorialCompleted: false }))).toBe(true)
  })

  it('skips the restore while any editor is active (edit protection)', () => {
    expect(shouldRestoreToLanding(ctx({ lastClosedAt: 1, now: 999_999_999, editingTask: 'new' }))).toBe(false)
    expect(shouldRestoreToLanding(ctx({ lastClosedAt: 1, now: 999_999_999, editingTask: 't1' }))).toBe(false)
  })

  it('falls back to restoring on an unknown restore time', () => {
    expect(shouldRestoreToLanding(ctx({ restoreTime: 'relaxed' as Settings['restoreTime'], lastClosedAt: 1000, now: 999_999 }))).toBe(true)
  })
})
