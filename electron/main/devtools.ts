/**
 * Dev-only React DevTools loader.
 *
 * Loads the unpacked React DevTools extension from a locally installed
 * browser profile (Chrome / Edge / Chromium) so the panel renderer can be
 * inspected through the F12 DevTools "React" tab. No-op in packaged builds;
 * failures degrade to "no React tab" — never blocks app startup.
 */
import { app, type Session } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REACT_DEVTOOLS_ID = 'fmkadmapgofadopljbjfkapdkoienihi'

function browserProfiles(): Array<{ name: string; profile: string }> {
  const local = process.env.LOCALAPPDATA
  if (!local) return []
  return [
    { name: 'Chrome', profile: join(local, 'Google', 'Chrome', 'User Data', 'Default') },
    { name: 'Edge', profile: join(local, 'Microsoft', 'Edge', 'User Data', 'Default') },
    { name: 'Chromium', profile: join(local, 'Chromium', 'User Data', 'Default') }
  ]
}

function findExtensionDir(): string | null {
  for (const { profile } of browserProfiles()) {
    const extRoot = join(profile, 'Extensions', REACT_DEVTOOLS_ID)
    if (!existsSync(extRoot)) continue
    const versions = readdirSync(extRoot)
      .filter((v) => existsSync(join(extRoot, v, 'manifest.json')))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (versions.length > 0) return join(extRoot, versions[0])
  }
  return null
}

export async function loadReactDevTools(ses: Session): Promise<void> {
  if (app.isPackaged) return
  try {
    const dir = findExtensionDir()
    if (!dir) {
      console.warn(
        '[DevTools] React DevTools not found in Chrome/Edge/Chromium profiles; install it to get the React tab in F12 DevTools'
      )
      return
    }
    await ses.loadExtension(dir)
    console.log('[DevTools] React DevTools loaded from', dir)
  } catch (err) {
    console.warn('[DevTools] Failed to load React DevTools:', err)
  }
}
