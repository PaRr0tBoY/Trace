/**
 * Theme: writes dynamic CSS properties to :root.
 */
import type { MotionLevel, ThemeColor } from '../../shared/types'
import { THEME_ACCENTS } from '../../shared/themes'


/**
 * Push the motion level onto :root as a data attribute the CSS keys off:
 * - `data-motion='standard'` → baseline (no CSS-only extras).
 * - `data-motion='extended'` → CSS-only delight rules (e.g. .act press scale)
 *   activate.
 * Framer Motion is covered separately by <MotionConfig> in App.tsx.
 */
export function applyMotionLevel(level: MotionLevel): void {
  document.documentElement.dataset.motion = level
}

/**
 * Push the accent palette for the chosen theme onto :root. CSS consumes the
 * variables (--accent, --accent-glow, --accent-rgb) via var() / rgba(var()).
 * Called from App's settings effect, so it always runs in the browser context.
 */
export function applyTheme(themeColor: ThemeColor): void {
  const accent = THEME_ACCENTS[themeColor]
  const style = document.documentElement.style
  style.setProperty('--accent', accent.color)
  style.setProperty('--accent-glow', accent.glow)
  style.setProperty('--accent-rgb', accent.rgb)
}
