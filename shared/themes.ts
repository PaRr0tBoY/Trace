/**
 * Accent themes (Ticket 3) — the single source of truth for the five
 * theme colors, shared by the renderer (CSS variables, copy indicator,
 * settings palette) and the main process (drag-ghost icons).
 *
 * The color values deliberately live here instead of an ADR: they are code
 * constants, easy to tweak, and the ADRs only record the decisions.
 */
import type { ThemeColor } from './types'

export interface ThemeAccent {
  /** Main accent color. */
  color: string
  /** "r, g, b" triplet so CSS can build rgba(var(--accent-rgb), X) variants. */
  rgb: string
  /** Soft glow used for shadows and the copy indicator. */
  glow: string
}

export const THEME_ACCENTS: Record<ThemeColor, ThemeAccent> = {
  graphite: { color: '#9ca3af', rgb: '156, 163, 175', glow: 'rgba(156, 163, 175, 0.55)' },
  cobalt: { color: '#3b82f6', rgb: '59, 130, 246', glow: 'rgba(59, 130, 246, 0.55)' },
  verdigris: { color: '#14b8a6', rgb: '20, 184, 166', glow: 'rgba(20, 184, 166, 0.55)' },
  amber: { color: '#f59e0b', rgb: '245, 158, 11', glow: 'rgba(245, 158, 11, 0.55)' },
  violet: { color: '#8b5cf6', rgb: '139, 92, 246', glow: 'rgba(139, 92, 246, 0.55)' }
}

/** Display order for the settings palette. */
export const THEME_COLORS: readonly ThemeColor[] = ['graphite', 'cobalt', 'verdigris', 'amber', 'violet']

export function isThemeColor(value: unknown): value is ThemeColor {
  return typeof value === 'string' && (THEME_COLORS as readonly string[]).includes(value)
}
