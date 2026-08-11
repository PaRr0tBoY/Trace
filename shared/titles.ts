/**
 * Title fallbacks shared by the suggestion engine (algorithmic mode) and the
 * renderer's save flow (ADR-0003: silent fallback when AI generation fails).
 * One source so both sides can never drift.
 */

/** Cap for generated titles (same limit the suggestion engine sanitizes to). */
export const MAX_TITLE_CHARS = 60

/**
 * Deterministic title from app names, no AI involved: "Code + Chrome task".
 * Empty when there is nothing to name — callers must not call it with no
 * apps (the guided-form save path guarantees at least one app when it uses
 * the fallback).
 */
export function algorithmicTitle(appNames: string[]): string {
  const names = appNames.slice(0, 2).join(' + ')
  return names.length > 0 ? `${names} task` : 'Untitled task'
}
