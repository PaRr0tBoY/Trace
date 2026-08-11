/**
 * Theme: writes dynamic CSS properties to :root.
 */
import type { ThemeColor } from '../../shared/types'
import { THEME_ACCENTS } from '../../shared/themes'


/** Apply reduce-motion preference as a data attribute the CSS can key off. */
export function applyReduceMotion(reduce: boolean): void {
  document.documentElement.dataset.motion = reduce ? 'reduce' : 'full'
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
