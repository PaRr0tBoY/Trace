/**
 * Electron main process entry point.
 *
 * Lifecycle:
 *   1. Single-instance lock (only one Trace may run).
 *   2. App 'ready' -> ensure dirs, create the edge window + tray, register the
 *      image protocol + IPC handlers, start the clipboard watcher.
 *   3. On 'window-all-closed' we DON'T quit (the panel is hidden, not closed).
 *   4. Quit from the tray menu tears everything down cleanly.
 */
import { app, BrowserWindow, protocol, session, screen } from 'electron'
import { APP_CONFIG, runtime } from './config'
import { ensureDirs, cleanTemp, PATHS } from '../store/paths'
import { configureAiLog } from './aiLog'
import { createWindow, getMainWindow, isInteractive, setInteractive, setVisible, startCursorPoll, stopCursorPoll, stopHeartbeat, setHotZoneWidth } from './window'
import { createTray, registerIncognitoApplier } from './tray'
import { registerIpc, registerSendListeners, getProviderChain } from './ipc'
import { prewarmDragIcons } from './drag'
import { initState, getWatcher, getTaskStore, loadSettings, saveSettings, pushState, stopStateTimers, setSuggestionChat, setSuggestionOcr } from './state'
import { createOnboardingWindow } from './onboardingWindow'
import { startFullscreenMonitor, stopFullscreenMonitor, triggerFullscreenCheck } from './fullscreen'
import { startKeyboardHook, stopKeyboardHook } from './hookManager'
import { switcherShow, switcherAdvance, switcherExecute, switcherTapExecute } from './switcher'
import { ForegroundWatcher } from './foreground'
import { ocrFromForeground } from './ocr'
import { createAttributor, type Attributor } from './attributor'
import { subscribe as subscribeEvents } from './eventBus'
import { extname, normalize } from 'node:path'
import { existsSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolveStoredImage, resolveThumbnail } from './imageProtocol'
import { loadReactDevTools } from './devtools'

// Trace renders a small, mostly static transparent panel. Chromium's GPU
// process costs substantially more memory (~150–250 MB) than the iGPU compositing
// savings are worth for such a simple UI. Software compositing keeps the process
// count and RAM footprint minimal without meaningfully affecting visual quality.
// Electron requires this call before the ready event.
app.disableHardwareAcceleration()

// Restrict the renderer to a single webContents and forbid remote module usage.
app.enableSandbox()

// ---- single instance -------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // If a second copy launches, just reveal the existing panel.
    setVisible(true)
    getMainWindow()?.focus()
  })
  app.on('browser-window-blur', () => {
    triggerFullscreenCheck()
  })
}

// ---- before ready: register privileged protocol ----------------------------
// Must happen before app is ready so we can declare it as privileged (bypass
// CSP for image loads).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_CONFIG.imageProtocol,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// ---- app lifecycle ---------------------------------------------------------
let foregroundWatcher: ForegroundWatcher | null = null
let attributor: Attributor | null = null

app.on('before-quit', () => {
  runtime.quitting = true
  stopCursorPoll()
  stopHeartbeat()
  stopStateTimers()
  stopFullscreenMonitor()
  stopKeyboardHook()
  foregroundWatcher?.stop()
  attributor?.dispose()
  getWatcher().stop()
  try {
    const { globalShortcut } = require('electron')
    globalShortcut.unregisterAll()
  } catch { /* ignore */ }
})

app.whenReady().then(async () => {
  // Set App User Model ID so native notifications are branded as "Trace" on Windows
  app.setAppUserModelId('com.edgedrop.app')

  ensureDirs()
  cleanTemp()
  configureAiLog(PATHS.aiLogFile())

  // Lock the renderer session down: block all permission requests by default.
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  // Register the image protocol: tracelocal://<imageId> -> the staged image file.
  registerImageProtocol()

  // Dev-only: make the React tab available in the F12 DevTools (no-op when packaged).
  await loadReactDevTools(ses)

  createWindow()
  startCursorPoll()
  startFullscreenMonitor()
  createTray()

  // Alt+Tab takeover (ADR-0005): the hook state machine feeds the switcher.
  // onMouseDown feeds click-outside collapse (see panelMouseDown).
  startKeyboardHook({
    onShow: switcherShow,
    onAdvance: switcherAdvance,
    onExecute: switcherExecute,
    onTapExecute: switcherTapExecute,
    onMouseDown: panelMouseDown
  })

  // Register Alt+C global shortcut to toggle panel
  try {
    const { globalShortcut } = require('electron')
    let lastToggleTime = 0
    globalShortcut.register('Alt+C', () => {
      if (runtime.quitting || runtime.switcherActive) return // switcher session owns Alt
      const now = Date.now()
      if (now - lastToggleTime < 500) return // Throttle to once per 500ms
      lastToggleTime = now
      pushState.togglePanel()
    })
  } catch (err) {
    console.error('[Main] Failed to register global shortcut Alt+C:', err)
  }
  registerIpc()
  registerSendListeners()
  initState()
  prewarmDragIcons()

  // Wire the provider chain into the suggestion engine (after initState so the
  // engine's singletons exist; the 30s+ silence floor guarantees the chain is
  // in place long before any analysis can trigger).
  setSuggestionChat((req) => getProviderChain().callChat(req))
  // OCR context for LLM annotations (t30): one capture per analysis trigger,
  // silent degradation — the engine treats it as optional input.
  setSuggestionOcr(ocrFromForeground)

  // Reflect settings immediately.
  let settings = loadSettings()
  if (!settings.tutorialCompleted) {
    // When onboarding is active (initial launch or reset tutorial), reset language to system default so onboarding always begins in System Default
    if (settings.language !== 'system') {
      settings = saveSettings({ language: 'system' })
    }
    setTimeout(() => {
      createOnboardingWindow()
    }, 2000)
  }
  setHotZoneWidth(settings.hotZoneWidth || 3)
  
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({
        openAtLogin: settings.launchAtLogin,
        path: app.getPath('exe')
      })
    } catch { /* ignore in non-packaged / sandbox */ }
  }
  foregroundWatcher = new ForegroundWatcher({
    isEnabled: () => {
      const s = loadSettings()
      return s.taskCaptureEnabled && s.l0CaptureEnabled
    }
  })
  registerIncognitoApplier((v) => {
    getWatcher().setPaused(v)
    foregroundWatcher?.setPaused(v)
  })
  attributor = createAttributor({
    store: getTaskStore(),
    subscribe: subscribeEvents,
    onAttributed: () => pushState.tasks()
  })
  getWatcher().setPaused(settings.incognito)
  foregroundWatcher.setPaused(settings.incognito)
  foregroundWatcher.start()
  pushState.settings(settings)

  // Keep the tray checkmarks in sync after settings change from the UI.
  // (Tray menu is rebuilt on each open, so no extra wiring is needed here.)
})

app.on('window-all-closed', () => {
  // Never quit automatically when panel hides/closes; lifecycle is managed by tray.
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ---- image protocol handler ------------------------------------------------
function registerImageProtocol(): void {
  protocol.handle(APP_CONFIG.imageProtocol, async (request) => {
    try {
      // Support streaming full-resolution local image files: tracelocal://file/<encodedPath>
      if (request.url.startsWith(`${APP_CONFIG.imageProtocol}://file/`)) {
        const rawPath = request.url.slice(`${APP_CONFIG.imageProtocol}://file/`.length)
        const filePath = normalize(decodeURIComponent(rawPath))
        if (existsSync(filePath)) {
          const ext = extname(filePath).toLowerCase()
          let contentType = 'image/png'
          if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg'
          else if (ext === '.gif') contentType = 'image/gif'
          else if (ext === '.webp') contentType = 'image/webp'
          else if (ext === '.svg') contentType = 'image/svg+xml'
          else if (ext === '.bmp') contentType = 'image/bmp'
          else if (ext === '.avif') contentType = 'image/avif'

          const stream = createReadStream(filePath)
          const body = new Response(stream as unknown as ReadableStream<Uint8Array>).body
          return new Response(body, {
            status: 200,
            headers: new Headers({
              'Content-Type': contentType,
              'Cache-Control': 'max-age=3600'
            })
          })
        }
        return new Response('Not found', { status: 404 })
      }

      // Display-sized thumbnails: tracelocal://thumb/<imageId | encodedPath>
      if (request.url.startsWith(`${APP_CONFIG.imageProtocol}://thumb/`)) {
        const rawKey = request.url.slice(`${APP_CONFIG.imageProtocol}://thumb/`.length)

        if (/^[a-z0-9-]+$/i.test(rawKey)) {
          const storedImage = resolveStoredImage(PATHS.imagesDir(), rawKey)
          if (!storedImage) return new Response('Not found', { status: 404 })
          const thumb = resolveThumbnail(storedImage.filePath)
          if (!thumb) return new Response('Not found', { status: 404 })
          return new Response(thumb.bytes, {
            status: 200,
            headers: new Headers({
              'Content-Type': thumb.contentType,
              'Cache-Control': 'max-age=3600'
            })
          })
        }

        let filePath: string
        try {
          filePath = normalize(decodeURIComponent(rawKey))
        } catch {
          return new Response('Bad request', { status: 400 })
        }
        if (!existsSync(filePath)) return new Response('Not found', { status: 404 })
        const thumb = resolveThumbnail(filePath)
        if (!thumb) return new Response('Not found', { status: 404 })
        return new Response(thumb.bytes, {
          status: 200,
          headers: new Headers({
            'Content-Type': thumb.contentType,
            'Cache-Control': 'max-age=3600'
          })
        })
      }

      const imageId = new URL(request.url).hostname
      if (!/^[a-z0-9-]+$/i.test(imageId)) {
        return new Response('Forbidden', { status: 403 })
      }

      const storedImage = resolveStoredImage(PATHS.imagesDir(), imageId)
      if (!storedImage) {
        return new Response('Not found', { status: 404 })
      }

      const stream = createReadStream(storedImage.filePath)
      const body = new Response(stream as unknown as ReadableStream<Uint8Array>).body
      const headers = new Headers({
        'Content-Type': storedImage.contentType,
        'Cache-Control': 'no-cache',
        'ETag': `"${createHash('sha256').update(storedImage.filePath).digest('hex')}"`
      })
      return new Response(body, { status: 200, headers })
    } catch {
      return new Response('Error', { status: 500 })
    }
  })
}

/**
 * Left-button down while the panel is interactive (mouse hook). The panel
 * is WS_EX_NOACTIVATE and often never reaches the OS foreground, so focus
 * events can't detect click-outside (blur never fires for a window that
 * never had focus) — the hook reports the physical screen point and we
 * collapse when it lands outside the panel's bounds. Clicks inside the
 * panel pass through untouched (the hook never swallows).
 */
function panelMouseDown(pt: { x: number; y: number }): void {
  if (runtime.switcherActive) return // the switcher owns click-outside
  const win = getMainWindow()
  if (!win || win.isDestroyed() || !win.isVisible() || !isInteractive()) return
  try {
    // Physical screen point vs the panel's screen rect (DIP → physical).
    const b = win.getBounds()
    const sr = screen.dipToScreenRect(win, b)
    if (pt.x >= sr.x && pt.x <= sr.x + sr.width && pt.y >= sr.y && pt.y <= sr.y + sr.height) return
    console.log('[Panel] click outside panel — collapse')
    setInteractive(false)
    pushState.togglePanel(false)
  } catch (err) {
    console.error('[Panel] click-outside check failed:', err)
  }
}
