/**
 * 智能收起 (Smart Collapse Fallbacks) — main-side signal hub.
 *
 * Passive external-activity signals (wheel outside the panel, external copy,
 * lock/suspend) funnel through here. The switcher-session branch abandons
 * the session main-side (瞬态会话不受 hoverActivation 门控 — the 30s session
 * timeout was removed in favor of this strategy, so a pinned session must
 * never lose its passive fallback). The panel branch forwards to the
 * renderer, which force-collapses past the notes-editor focus hold.
 */
import { loadSettings } from '../store/settings'
import { runtime } from './config'
import { getMainWindow } from './window'
import { abandonSwitcherSession } from './switcher'
import type { SmartExternalKind } from '../../shared/ipc'

/**
 * Dispatch a passive external-activity signal. Gated on
 * `smartCollapseFallbacks`; the panel branch additionally requires hover
 * activation (Q4: fixed mode is a deliberately persistent panel).
 */
export function signalSmartExternalActivity(kind: SmartExternalKind): void {
  const settings = loadSettings()
  if (!settings.smartCollapseFallbacks) return
  // Switcher session: same strategy, abandon the session like Esc/click-outside.
  if (runtime.switcherActive) {
    abandonSwitcherSession()
    return
  }
  // Panel collapse: only in hover mode.
  if (!settings.hoverActivation) return
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send('smart:external-activity', kind)
}
