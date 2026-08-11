/**
 * App identity key — the one rule that maps a foreground app (L0 event or
 * clipboard sourceApp) to an AppRef.id. Lives in shared/ because main builds
 * ids (attributor, app options) and the renderer matches clipboard rows
 * against selected apps; both must apply the identical normalization.
 */

/** Lowercase + slash-normalize an app identity string (Windows path case-insensitivity). */
export function normalizeAppKey(s: string): string {
  return s.trim().toLowerCase().replace(/\\/g, '/')
}

/**
 * Identity key for an app: lowercase-normalized exePath, falling back to the
 * process name when no exePath is known. Empty input yields '' (callers skip
 * it — a key must never collide with a real app).
 */
export function appKeyFromIdentity(identity: { name: string; exePath?: string }): string {
  const exe = normalizeAppKey(identity.exePath ?? '')
  return exe.length > 0 ? exe : normalizeAppKey(identity.name)
}
