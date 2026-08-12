/**
 * Restore mechanism decision (ADR-0004).
 *
 * Anchor = the moment the panel collapses. Within the TTL a re-open keeps
 * the last page; after the TTL (or on first launch) the landing page is
 * applied. An active task/suggestion editor always blocks the restore.
 */
import type { Settings } from '../../shared/types'

export const RESTORE_TTL_MS = {
  instant: 0,
  relaxed: 10_000,
  delayed: 600_000
} as const

export interface RestoreContext {
  settings: Settings
  lastClosedAt: number
  editingTask: string | 'new' | null
  now?: number
}

/**
 * True when opening the panel must apply the landing page instead of keeping
 * the previous page.
 */
export function shouldRestoreToLanding(ctx: RestoreContext): boolean {
  // First launch (never closed): apply the landing page, even with 'forever'.
  if (ctx.lastClosedAt === 0) return true
  // Tutorial in progress: never restore. The onboarding window keeps this
  // flag false while it's open (it flips true the moment it closes).
  if (!ctx.settings.tutorialCompleted) return false
  // Edit protection: never clobber an active editor.
  if (ctx.editingTask !== null) return false
  if (ctx.settings.restoreTime === 'forever') return false
  const ttl = RESTORE_TTL_MS[ctx.settings.restoreTime as keyof typeof RESTORE_TTL_MS]
  if (ttl === undefined) return true
  const now = ctx.now ?? Date.now()
  return now - ctx.lastClosedAt >= ttl
}
