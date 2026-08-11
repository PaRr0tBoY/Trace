/**
 * AppIcon — 16-20px Windows app icon badge (t26).
 *
 * Renders the dataURL filled by main at push time; without one it degrades to
 * a gray rounded square with the app's first letter. Tooltip always carries
 * the app name (i18n-free by design).
 */
import type { AppRef } from '../../../shared/types'

interface Props {
  app: Pick<AppRef, 'name' | 'iconUrl'>
  size?: number
}

export function AppIcon({ app, size = 16 }: Props) {
  if (app.iconUrl) {
    return (
      <img
        className="app-icon"
        src={app.iconUrl}
        alt=""
        width={size}
        height={size}
        title={app.name}
        draggable={false}
      />
    )
  }
  const glyph = app.name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="app-icon app-icon-fallback"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      title={app.name}
    >
      {glyph}
    </span>
  )
}
