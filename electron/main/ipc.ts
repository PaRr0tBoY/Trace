/**
 * IPC handler registration.
 *
 * Each `ipcMain.handle` here mirrors a contract in `shared/ipc.ts`. The
 * renderer calls them through the typed preload bridge, so a signature mismatch
 * is a compile-time error rather than a runtime one.
 */
import { app, ipcMain, clipboard, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { psHost } from './powershell'
import { requestPanelFocus, releasePanelFocus } from './focus'
import { type InvokeMap, type InvokeChannel, type SendMap, type SendChannel, type SuggestTitleContext } from '../../shared/ipc'
import { getStore, loadSettings, saveSettings, pushState, addFiles, getWatcher, getTaskStore, getSuggestionEngine, getMemoryStore } from './state'
import { getMainWindow } from './window'
import { setInteractive, setHeartbeatPaused, setHotZoneWidth, setPreviewMode, getDisplayListOptions, repositionWindow } from './window'
import { getOnboardingWindow } from './onboardingWindow'
import { startDragOut, resolveDragData } from './drag'
import { clipboardSignature } from '../clipboard/formats'
import { buildClipboardRef } from '../store/TaskStore'
import { acceptWithResource } from './suggestionDrop'
import { ProviderChain, buildLocalProvider, detectOllama, testProvider } from './provider'
import type { ItemData, MergeResult, MemoryListPayload, ResourceRef } from '../../shared/types'

/**
 * Returns true if the current system clipboard content matches the given item data.
 *
 * Used before delete to decide whether to clear the system clipboard. Clearing
 * is only done when the deleted item IS the thing currently on the clipboard;
 * deleting an old history entry that the user has since replaced must never
 * wipe their current clipboard contents.
 */
function clipboardMatchesItem(data: ItemData): boolean {
  const sig = clipboardSignature()
  if (data.kind === 'text') return sig === `text:${data.text}`
  if (data.kind === 'files') return sig === `files:${data.paths.join('\n')}`
  if (data.kind === 'image') {
    // sig format: "image:<W>x<H>:<hash>" — check the dimension prefix to avoid a full pixel read.
    // If another image with the same dimensions is on the clipboard, we over-clear, which is
    // acceptable (user loses clipboard content they were about to paste from a deleted item anyway).
    return sig.startsWith(`image:${data.width}x${data.height}:`)
  }
  // image-collection: clear if any image is on the clipboard (conservative but safe)
  if (data.kind === 'image-collection') return sig.startsWith('image:')
  return false
}

/** Fire a transient toast to the renderer (best-effort; renderer may be closed). */
function toast(message: string, tone: 'info' | 'error' = 'info'): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ui:toast', { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, message, tone })
  }
}

/** Simulate pressing Ctrl+V via PowerShell after returning focus to the previous active window. */
function simulatePaste(): void {
  if (process.platform === 'win32') {
    // Run via the persistent powershell host for near-zero latency (no process spawn overhead)
    psHost.run("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')", 2000)
      .catch((err) => {
        console.error('[Main] simulatePaste psHost failed, using fallback:', err)
        // Fallback to spawning a new powershell process
        execFile('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
        ], (fallbackErr) => {
          if (fallbackErr) console.error('[Main] simulatePaste fallback error:', fallbackErr)
        })
      })
  }
}

/**
 * Write file *references* onto the system clipboard so that paste in Explorer,
 * Word, Slack, and every other shell-aware app copies the actual files.
 *
 * WHY POWERSHELL: Electron's clipboard API calls EmptyClipboard() on every
 * write. Sequential calls (writeBuffer then writeText) leave only the LAST
 * format — which was always the plain path string, making every paste land as
 * text. PowerShell's Clipboard.SetFileDropList writes CF_HDROP + FileNameW +
 * Shell IDList Array + all other shell formats in a single atomic transaction.
 * Paths are base64-encoded so any character (spaces, quotes, Unicode) is safe.
 */
async function writeFileListToClipboard(paths: string[]): Promise<void> {
  if (process.platform === 'win32' && paths.length > 0) {
    try {
      const addLines = paths
        .map(p => `$c.Add([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(p, 'utf8').toString('base64')}')))|Out-Null`)
        .join(';')
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$c=New-Object System.Collections.Specialized.StringCollection',
        addLines,
        '[Windows.Forms.Clipboard]::SetFileDropList($c)'
      ].join(';')
      await psHost.run(script, 3000)
      return
    } catch (err) {
      console.error('[ipc] writeFileListToClipboard PowerShell failed, using text fallback:', err)
    }
  }
  // Non-Windows fallback: plain text paths (best-effort)
  clipboard.clear()
  clipboard.writeText(paths.join('\r\n'))
}

async function writeImageToClipboard(imagePath: string | null, previewDataUrl: string): Promise<void> {
  if (process.platform === 'win32' && imagePath && existsSync(imagePath)) {
    try {
      const b64Path = Buffer.from(imagePath, 'utf8').toString('base64')
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Path}'))`,
        '$bmp=[Drawing.Image]::FromFile($p)',
        '$d=New-Object Windows.Forms.DataObject',
        '$d.SetImage($bmp)',
        '$c=New-Object System.Collections.Specialized.StringCollection',
        '$c.Add($p)|Out-Null',
        '$d.SetFileDropList($c)',
        '[Windows.Forms.Clipboard]::SetDataObject($d,$true)',
        '$bmp.Dispose()'
      ].join(';')
      await psHost.run(script, 3000)
      return
    } catch (err) {
      console.error('[ipc] writeImageToClipboard PowerShell failed, using bitmap fallback:', err)
    }
  }
  // Fallback: write bitmap only via Electron (no file reference)
  try {
    const img = nativeImage.createFromDataURL(previewDataUrl)
    if (!img.isEmpty()) {
      clipboard.clear()
      clipboard.writeImage(img)
    }
  } catch { /* ignore */ }
}

/**
 * Type-checked registration helper: guarantees the handler's return matches the
 * contract declared in InvokeMap.
 */
function handle<C extends InvokeChannel>(
  channel: C,
  fn: (...args: InvokeMap[C]['args']) => Promise<InvokeMap[C]['result']> | InvokeMap[C]['result']
): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as InvokeMap[C]['args'])))
}

export function registerIpc(): void {
  handle('state:load', () => {
    return {
      items: getStore().toDto(),
      settings: loadSettings(),
      version: app.getVersion(),
      tasks: getTaskStore().toDto()
    }
  })

  /* --------------------------- ai provider --------------------------- */

  handle('ai:test-provider', (config) => testProvider(config))
  handle('ai:detect-ollama', (baseUrl) => detectOllama(baseUrl))
  void detectOllamaAtStartup()

  /* --------------------------- task domain --------------------------- */

  handle('task:load', () => {
    return getTaskStore().toDto()
  })

  handle('task:create', (title, note) => {
    getTaskStore().create(title, note !== undefined ? { note } : undefined)
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:update', (id, patch) => {
    getTaskStore().update(id, patch)
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:delete', (id) => {
    getTaskStore().delete(id)
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:merge', (targetId, sourceId) => {
    getTaskStore().merge(targetId, sourceId)
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:link-item', (taskId, itemId) => {
    const item = getStore().get(itemId)
    if (item) {
      getTaskStore().linkItem(taskId, buildClipboardRef(item))
    }
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:link-files', (taskId, paths) => {
    getTaskStore().linkFiles(taskId, paths)
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:unlink-item', (taskId, target) => {
    getTaskStore().unlinkItem(taskId, target)
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:suggest-title', (ctx: SuggestTitleContext) => {
    return getSuggestionEngine().suggestTitle(ctx)
  })

  /* --------------------------- suggestions --------------------------- */

  handle('suggestion:accept', (id, titleOverride) => {
    const accepted = getSuggestionEngine().accept(id, titleOverride)
    if (accepted !== null) pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('suggestion:accept-with-resource', (id, titleOverride, resource) => {
    // Build the clipboard snapshot here (ItemStore access lives in this layer),
    // then let the pure composition accept + link atomically.
    const ref: ResourceRef | null =
      resource.kind === 'clipboard'
        ? (() => {
            const item = getStore().get(resource.itemId)
            return item ? buildClipboardRef(item) : null
          })()
        : { kind: 'files', paths: resource.paths }
    const accepted = ref
      ? acceptWithResource(getSuggestionEngine(), getTaskStore(), id, titleOverride, ref)
      : getSuggestionEngine().accept(id, titleOverride)
    if (accepted !== null) pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('suggestion:ignore', (id) => {
    getSuggestionEngine().ignore(id)
  })

  /* --------------------------- memory --------------------------- */

  /** The panel's four buckets, decay-aware (MemoryStore computes time-aware confidence). */
  const memoryListPayload = (): MemoryListPayload => {
    const store = getMemoryStore()
    const all = store.list()
    return {
      candidates: store.candidates(),
      confirmed: all.filter((m) => m.userState === 'confirmed'),
      banned: all.filter((m) => m.userState === 'banned'),
      cleanup: store.cleanupCandidates()
    }
  }

  handle('memory:list', () => memoryListPayload())

  handle('memory:act', (id, action) => {
    // Action names mirror MemoryStore methods; each returns whether it applied.
    getMemoryStore()[action](id)
    return memoryListPayload()
  })

  handle('app:get-releases', async () => {
    if (_releasesCache) {
      // Re-validate in background asynchronously without blocking UI render
      fetchAndCacheReleases().catch(() => {})
      return _releasesCache
    }
    return fetchAndCacheReleases()
  })

  handle('item:set-pinned', (id, pinned) => {
    getStore().setPinned(id, pinned)
    pushState.items()
    return getStore().toDto()
  })

  handle('item:delete', (id) => {
    const item = getStore().get(id)
    getStore().delete(id)
    // If the deleted item is still on the system clipboard, clear the clipboard.
    // This is the fix for the copy→delete→copy cycle bug:
    //   Without this, resyncSignature() would lock lastSig to the current
    //   clipboard state. When the user immediately re-copies the same image the
    //   clipboard never changes, so the watcher never fires and the item stays
    //   invisible. Clearing makes the clipboard transition to 'empty', so the
    //   next re-copy IS a detectable change.
    if (item && clipboardMatchesItem(item.data)) {
      clipboard.clear()
    }
    getWatcher().resyncSignature()
    pushState.items()
    return getStore().toDto()
  })

  handle('item:clear', () => {
    getStore().clearUnpinned()
    // Clear the system clipboard unconditionally: the user wiped their history,
    // so whatever is on the clipboard should not zombie-reappear, and clearing
    // ensures any subsequent re-copy of the same content is detectable.
    clipboard.clear()
    getWatcher().resyncSignature()
    pushState.items()
    return getStore().toDto()
  })

  handle('item:copy', async (id) => {
    const item = getStore().get(id)
    console.log('[IPC] item:copy id=', id, 'found=', !!item)
    if (!item) return false

    const watcher = getWatcher()
    watcher.setPaused(true)
    await writeItemToClipboard(item.data)
    console.log('[IPC] item:copy wrote to clipboard, kind=', item.data.kind)

    // Promote the copied item to the top of the history stack
    getStore().add(item.data, loadSettings().historyLimit)
    pushState.items()

    // Unpause after a short delay to allow OS clipboard event to settle.
    // Respect the current incognito state when unpausing.
    setTimeout(() => {
      watcher.setPaused(loadSettings().incognito)
    }, 200)

    return true
  })

  handle('item:copy-subitem', async (req) => {
    // Resolve a single sub-item (one file of a bundle, or one image of a
    // collection) and write just that onto the clipboard — not the whole item.
    const dto = getStore().toDto().find((d) => d.id === req.id)
    if (!dto) return false

    let wrote = false
    if (dto.data.kind === 'files' && req.paths && req.paths.length > 0) {
      // Write real file references so pasting into Explorer copies the file,
      // not a path string.
      await writeFileListToClipboard(req.paths)
      wrote = true
    } else if (dto.data.kind === 'image-collection' && req.imageId) {
      const img = dto.data.images.find((i) => i.imageId === req.imageId)
      if (img) {
        // Single image from a collection: write full bitmap + file reference atomically.
        const src = getStore().getImagePath(img.imageId, img.ext)
        const preview = img.preview ?? ''
        await writeImageToClipboard(src && existsSync(src) ? src : null, preview)
        wrote = true
      }
    }

    if (!wrote) return false

    // Promote the parent item to the top of the history stack
    const parentItem = getStore().get(req.id)
    if (parentItem) {
      getStore().add(parentItem.data, loadSettings().historyLimit)
      pushState.items()
    }

    const watcher = getWatcher()
    watcher.setPaused(true)
    setTimeout(() => {
      watcher.setPaused(loadSettings().incognito)
    }, 200)

    return true
  })

  // ---------------------------------------------------------------------------
  // Paste guard — prevents double-paste from rapid/double clicks.
  // Stored at module scope so it's authoritative across all renderer invocations.
  // The renderer-side tryPaste() is a best-effort pre-filter; this is the hard gate.
  // ---------------------------------------------------------------------------
  let _lastPasteTime = 0
  const PASTE_GUARD_MS = 600

  handle('item:paste', async (id) => {
    const now = Date.now()
    if (now - _lastPasteTime < PASTE_GUARD_MS) {
      console.log('[IPC] item:paste blocked — too soon after last paste')
      return false
    }
    _lastPasteTime = now

    const item = getStore().get(id)
    console.log('[IPC] item:paste id=', id, 'found=', !!item)
    if (!item) return false

    const watcher = getWatcher()
    watcher.setPaused(true)

    try {
      await writeItemToClipboard(item.data)
      console.log('[IPC] item:paste wrote to clipboard, kind=', item.data.kind)

      // DO NOT call store.add() here. hitCount must only increment when the user
      // genuinely copies the content from a source app (detected by the watcher).
      // Pasting from Trace is a retrieval action, not a new copy.

      // Close panel so focus returns to the user's active input/text box.
      // Pass false to explicitly close and avoid toggle race conditions.
      pushState.togglePanel(false)

      // Wait 50ms for layout updates, then simulate Ctrl+V
      setTimeout(() => {
        simulatePaste()
      }, 50)
    } finally {
      // Invalidate (not resync) the watcher signature after the pause expires.
      // This ensures that if the user re-copies the SAME content from the source
      // app right after paste, the watcher detects it as new (clipboard sig never
      // changed, but our sentinel '__post-paste__' guarantees the next poll sees a diff).
      setTimeout(() => {
        watcher.invalidateSignature()
        watcher.setPaused(loadSettings().incognito)
      }, 350)
    }

    return true
  })

  handle('item:paste-subitem', async (req) => {
    const now = Date.now()
    if (now - _lastPasteTime < PASTE_GUARD_MS) {
      console.log('[IPC] item:paste-subitem blocked — too soon after last paste')
      return false
    }
    _lastPasteTime = now

    const dto = getStore().toDto().find((d) => d.id === req.id)
    if (!dto) return false

    const watcher = getWatcher()
    watcher.setPaused(true)

    try {
      let wrote = false
      if (dto.data.kind === 'files' && req.paths && req.paths.length > 0) {
        await writeFileListToClipboard(req.paths)
        wrote = true
      } else if (dto.data.kind === 'image-collection' && req.imageId) {
        const img = dto.data.images.find((i) => i.imageId === req.imageId)
        if (img) {
          // Single image from a collection: write full bitmap + file reference atomically.
          const src = getStore().getImagePath(img.imageId, img.ext)
          const preview = img.preview ?? ''
          await writeImageToClipboard(src && existsSync(src) ? src : null, preview)
          wrote = true
        }
      }

      if (!wrote) return false

      // DO NOT promote/bump hitCount here — same reason as item:paste.
      // Only the watcher (genuine user Ctrl+C) should increment hitCount.

      // Pass false to explicitly close and avoid toggle race conditions.
      pushState.togglePanel(false)

      // Wait 50ms for layout updates, then simulate Ctrl+V
      setTimeout(() => {
        simulatePaste()
      }, 50)
    } finally {
      setTimeout(() => {
        watcher.invalidateSignature()
        watcher.setPaused(loadSettings().incognito)
      }, 350)
    }

    return true
  })

  handle('item:add-files', (paths) => {
    const result = addFiles(paths)
    // If a large drop was split into several stacks, let the user know why
    // they suddenly see multiple items instead of one bundle.
    if (result.stacksCreated > 1) {
      toast(`Split into ${result.stacksCreated} stacks (max 10 each)`, 'info')
    }
    return getStore().toDto()
  })

  handle('item:remove-subitem', (req) => {
    const success = getStore().removeSubitem(req)
    if (success) pushState.items()
    return success
  })

  handle('item:merge', (sourceId, targetId) => {
    const result: MergeResult = getStore().merge(sourceId, targetId)
    if (result.ok) {
      pushState.items()
    } else if (result.reason === 'full') {
      toast(result.message || 'Collection is full (10 max)', 'info')
    } else if (result.reason === 'incompatible') {
      toast(result.message || 'Cannot combine different item types', 'info')
    }
    // 'notfound' fails silently
    return result
  })

  handle('item:split', (req) => {
    console.log('[IPC] item:split called with req=', JSON.stringify(req))
    const success = getStore().split(req)
    console.log('[IPC] item:split success=', success)
    if (success) pushState.items()
    return success
  })

  handle('settings:update', (patch) => {
    const next = saveSettings(patch)
    if (patch.launchAtLogin !== undefined && app.isPackaged) {
      try {
        app.setLoginItemSettings({
          openAtLogin: next.launchAtLogin,
          path: app.getPath('exe')
        })
      } catch { /* ignore */ }
    }
    if (patch.hotZoneWidth !== undefined) {
      setHotZoneWidth(patch.hotZoneWidth)
    }
    if (patch.stickPosition !== undefined) {
      // The window anchors to the opposite edge — move it now, not on the
      // next pop-up (the setting was persisted but the window stayed put
      // until a display event or restart).
      repositionWindow()
    }
    if (patch.taskPauseThresholdMinutes !== undefined) {
      // A changed threshold may immediately flip Active tasks; re-evaluate now.
      getTaskStore().setPauseThreshold(next.taskPauseThresholdMinutes)
      if (getTaskStore().sweep() > 0) pushState.tasks()
    }
    // Memory decay thresholds live in Settings; keep the store's decay params
    // in lockstep (idempotent, so this also covers the unchanged case).
    getMemoryStore().setDecay({
      lambda: next.memoryLambda,
      staleDays: next.memoryStaleDays,
      cleanupScore: next.memoryCleanupScore
    })
    pushState.settings(next)
    return next
  })

  handle('window:set-interactive', (value) => {
    setInteractive(value)
  })

  handle('window:set-preview-mode', (active) => {
    // Restored from upstream (lost in the 0.2.6 merge, same class as file:reveal):
    // widens the window so the preview flyout renders beside the blade.
    setPreviewMode(active)
  })

  handle('displays:list', () => {
    // Restored from upstream (lost in the 0.2.6 merge): the settings display
    // picker + tray menu both consume this.
    return getDisplayListOptions()
  })

  handle('file:reveal', (filePath) => {
    // Restored from upstream (lost in the 0.2.6 merge): reveal an existing
    // path in Explorer; false for missing paths so the UI stays silent.
    if (typeof filePath === 'string' && existsSync(filePath)) {
      try {
        shell.showItemInFolder(filePath)
        return true
      } catch (err) {
        console.error('[IPC] file:reveal failed:', err)
      }
    }
    return false
  })

  handle('window:minimize', () => {
    const win = getOnboardingWindow()
    if (win && !win.isDestroyed()) {
      win.minimize()
    }
  })
}

/** Singleton provider chain for the suggestion engine (t19); settings-driven. */
let providerChain: ProviderChain | null = null

export function getProviderChain(): ProviderChain {
  if (!providerChain) {
    providerChain = new ProviderChain({ getProviders: () => loadSettings().aiProviders })
    console.log(`[AI] provider chain ready (${loadSettings().aiProviders.length} providers)`)
  }
  return providerChain
}

/**
 * Silent one-shot detection at startup: when no provider is configured yet
 * (fresh install -> onboarding) and Ollama is running, prefill the local
 * provider. Never overwrites a user-configured chain.
 */
async function detectOllamaAtStartup(): Promise<void> {
  if (loadSettings().aiProviders.length > 0) return
  const result = await detectOllama()
  if (!result.found) return
  const provider = buildLocalProvider(result.models)
  const next = saveSettings({ aiProviders: [provider] })
  pushState.settings(next)
  console.log(`[AI] ollama detected at startup, prefilled local provider (${provider.model})`)
}

/**
 * Register fire-and-forget (send) listeners.
 *
 * These use `ipcMain.on` + `event.sender` instead of `ipcMain.handle` because
 * the drag-out gesture must be synchronous — `event.sender.startDrag(...)` only
 * works correctly when called from the same event-loop turn as the renderer's
 * `dragstart` event.
 */
function on<C extends SendChannel>(
  channel: C,
  fn: (sender: Electron.WebContents, ...args: SendMap[C]['args']) => void
): void {
  ipcMain.on(channel, (event, ...args) => fn(event.sender, ...(args as SendMap[C]['args'])))
}

export function registerSendListeners(): void {
  on('ui:input-focus', () => {
    requestPanelFocus()
  })

  on('ui:input-blur', () => {
    releasePanelFocus()
  })

  on('item:start-drag', (sender, req) => {
    console.log('[IPC] item:start-drag req=', JSON.stringify(req))
    const data = resolveDragData(req)
    if (!data) {
      console.log('[IPC] start-drag: no data resolved')
      return
    }
    console.log('[IPC] start-drag: kind=', data.kind)

    // Pause the always-on-top heartbeat for the duration of the drag.
    // The heartbeat fires SetWindowPos(HWND_TOPMOST) every 500 ms, which
    // pushes our window in front of the DWM drag-ghost image — making the
    // dragged item appear to vanish ~0.5 s into any drag gesture.
    setHeartbeatPaused(true)

    startDragOut(sender, data)
    console.log('[IPC] start-drag returned, sending drag-end')
    sender.send('item:drag-end')

    // Re-enable the heartbeat now that the drag is over.
    setHeartbeatPaused(false)

    // Workaround for Electron/Windows not firing drop events on the source window:
    // Check if the user dropped the item back onto our window!
    const { screen, BrowserWindow } = require('electron')
    const point = screen.getCursorScreenPoint()
    const win = BrowserWindow.fromWebContents(sender)
    if (win) {
      const bounds = win.getBounds()
      const isInside = point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
                       point.y >= bounds.y && point.y <= bounds.y + bounds.height
      if (isInside) {
        console.log(`[IPC] Drag ended inside window! Triggering internal-drop at x=${point.x - bounds.x}, y=${point.y - bounds.y}`)
        sender.send('item:internal-drop', { x: point.x - bounds.x, y: point.y - bounds.y })
      }
    }
  })
}

/** Write any item payload back onto the system clipboard. */
export async function writeItemToClipboard(data: ItemData): Promise<void> {
  switch (data.kind) {
    case 'text':
      clipboard.clear()
      clipboard.write({ text: data.text, html: data.html })
      break

    case 'image': {
      const dto = getStore().toDto().find(
        (d) => d.data.kind === 'image' && d.data.imageId === data.imageId
      )
      if (dto && dto.data.kind === 'image') {
        // Write bitmap AND file reference atomically via PowerShell DataObject.
        // This lets the user paste into Slack/Word (reads bitmap) AND into
        // Explorer (reads CF_HDROP file reference) from the same clipboard write.
        const src = getStore().getImagePath(dto.data.imageId, dto.data.ext)
        await writeImageToClipboard(src && existsSync(src) ? src : null, dto.data.preview)
      }
      break
    }

    case 'image-collection': {
      // Write all image file references so pasting into Explorer copies all files.
      // Also write the first image as bitmap so single-image paste targets work.
      const dto = getStore().toDto().find(
        (d) => d.data.kind === 'image-collection'
      )
      if (dto && dto.data.kind === 'image-collection') {
        const paths: string[] = []
        for (const img of dto.data.images) {
          const src = getStore().getImagePath(img.imageId, img.ext)
          if (existsSync(src)) paths.push(src)
        }
        if (paths.length > 0) {
          // For multi-image collections, write all file refs atomically.
          // Also include the first image as bitmap using DataObject.
          const firstImg = dto.data.images[0]
          const firstPreview = firstImg?.preview ?? ''
          if (paths.length === 1) {
            // Single resolved path: use full atomic image+file write
            await writeImageToClipboard(paths[0], firstPreview)
          } else {
            // Multiple files: write CF_HDROP for all + bitmap for first
            try {
              const addLines = paths
                .map(p => `$c.Add([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(p, 'utf8').toString('base64')}')))|Out-Null`)
                .join(';')
              const b64First = Buffer.from(paths[0], 'utf8').toString('base64')
              const script = [
                'Add-Type -AssemblyName System.Windows.Forms',
                'Add-Type -AssemblyName System.Drawing',
                `$fp=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64First}'))`,
                '$bmp=[Drawing.Image]::FromFile($fp)',
                '$d=New-Object Windows.Forms.DataObject',
                '$d.SetImage($bmp)',
                '$c=New-Object System.Collections.Specialized.StringCollection',
                addLines,
                '$d.SetFileDropList($c)',
                '[Windows.Forms.Clipboard]::SetDataObject($d,$true)',
                '$bmp.Dispose()'
              ].join(';')
              await psHost.run(script, 3000)
            } catch (err) {
              console.error('[ipc] image-collection clipboard write failed:', err)
              // Fallback: write first image bitmap only
              try {
                const img = nativeImage.createFromDataURL(firstPreview)
                if (!img.isEmpty()) { clipboard.clear(); clipboard.writeImage(img) }
              } catch { /* ignore */ }
            }
          }
        }
      }
      break
    }

    case 'files':
      // Write real file references so pasting into Explorer copies the files,
      // not path strings.
      await writeFileListToClipboard(data.paths)
      break
  }
}
/** Parses raw GitHub markdown release notes into clean plain text highlights (stripping image/video/HTML tags). */
function parseReleaseBodyToCleanText(body: string): { summary: string; highlights: Array<{ title: string; description: string }> } {
  // 1. Strip images, videos, and raw HTML tags completely (pure plain text)
  const clean = body
    .replace(/!\[.*?\]\(.*?\)/g, '') // Strip markdown images ![alt](url)
    .replace(/<img[^>]*>/gi, '')     // Strip HTML img tags
    .replace(/<video[^>]*>.*?<\/video>/gi, '') // Strip HTML video tags
    .replace(/<[^>]+>/g, '')         // Strip any remaining HTML tags

  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  let summary = ''
  const highlights: Array<{ title: string; description: string }> = []

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('>')) {
      const text = line.replace(/^[#>\s]+/, '').trim()
      if (!summary && text && !text.toLowerCase().includes('what\'s changed') && !text.toLowerCase().includes('full changelog')) {
        summary = text
      }
      continue
    }

    if (line.startsWith('-') || line.startsWith('*') || line.startsWith('•') || /^\d+\./.test(line)) {
      const content = line.replace(/^[-*•\d.\s]+/, '').trim()
      if (!content) continue

      const boldMatch = content.match(/^\*\*(.*?)\*\*[\s:-]*(.*)/)
      if (boldMatch) {
        const title = boldMatch[1].trim()
        const description = boldMatch[2].trim()
        if (title) {
          highlights.push({ title, description: description || title })
          continue
        }
      }

      const colonIdx = content.indexOf(':')
      if (colonIdx > 0 && colonIdx < 45) {
        const title = content.substring(0, colonIdx).trim()
        const description = content.substring(colonIdx + 1).trim()
        if (title) {
          highlights.push({ title, description: description || title })
          continue
        }
      }

      highlights.push({ title: content, description: '' })
    } else if (!summary && line.length > 10) {
      summary = line
    }
  }

  return {
    summary: summary || 'Latest updates and fixes.',
    highlights: highlights.length > 0 ? highlights : [{ title: 'Bug Fixes & Performance Enhancements', description: 'Includes minor bug fixes and stability improvements.' }]
  }
}

const STATIC_CHANGELOG_FALLBACK = [
  {
    version: 'v0.2.6',
    date: 'Aug 05, 2026',
    isLatest: true,
    summary: 'Performance optimizations, redesigned settings footer, custom support portal integration, and enhanced 30-language typography.',
    highlights: [
      {
        title: 'Performance Improvements',
        description: 'Removed CPU blur effects across UI components for smoother panel opening and scrolling.'
      },
      {
        title: 'Settings UI & Navigation Redesign',
        description: 'Reordered settings footer to place the Support section above the Quit button, redesigned buttons into matching pill shapes with a soft pastel red support button, and simplified Quit into a low-profile bottom button.'
      },
      {
        title: 'Official Support Portal Integration',
        description: 'Updated support link to open official Edge-Drop support page supporting both International Ko-fi and Indian UPI options.'
      },
      {
        title: 'Localization & Typography Enhancements',
        description: 'Updated filter category labels across 30 languages with shorter native terms and added dynamic font scaling so filter text fits cleanly without overlapping.'
      }
    ]
  },
  {
    version: 'v0.2.5',
    date: 'Aug 03, 2026',
    isLatest: false,
    summary: 'Full 30-language localization with auto-scroll selector, powerMonitor sleep/wake protection, text size typography settings, and multi-file action bar.',
    highlights: [
      {
        title: 'Complete 30-Language Localization & Smart Language Selector',
        description: 'Implemented full translation dictionaries across 30 languages, added RTL layout support for Arabic and Hebrew, integrated audio haptics, and added auto-scrolling to position the selected language in the dropdown viewport.'
      },
      {
        title: 'Laptop Sleep & Unlock Protection',
        description: 'Eliminated false Copy Indicator activations when opening laptop lid or unlocking screen using native powerMonitor lifecycle handlers.'
      },
      {
        title: 'Text Size Typography Scale Setting',
        description: 'Added customizable typography scale settings (Small, Normal, Medium, Large) applying dynamic font scaling across the app.'
      },
      {
        title: 'Multi-File Selection & Preview Action Bar',
        description: 'Added tap-to-toggle multi-file selection with a batch action bar (Select All, Copy Selected, Paste Selected, Clear Selection).'
      }
    ]
  },
  {
    version: 'v0.2.2',
    date: 'Jul 29, 2026',
    isLatest: false,
    summary: 'Stationary 3-category Settings navigation, Web Audio API haptic sound suite, edge trigger alignment presets, and magnetic 5% tick slider.',
    highlights: [
      {
        title: 'Stationary 3-Category Settings Navigation',
        description: 'Organized Settings into three clean tabs (Behaviour, Position, Appearance) with a stationary header and independent scroll position memory per section.'
      },
      {
        title: 'Synthesized Web Audio Haptic Suite',
        description: 'Zero-asset Web Audio API sound engine providing tactile audio feedback for dial ticks, button clicks, toggle pops, and mechanical delete thuds.'
      },
      {
        title: 'Independent Edge Trigger Alignment & Proximity Beacon',
        description: 'Choose Top, Center, or Bottom trigger strip placement with dynamic clipPath alignment, alongside an edge location hint hairline pulse.'
      },
      {
        title: '5% Magnetic Tick Slider & Quit Action',
        description: 'Continuous 0.002 1-to-1 real-time drag tracking with magnetic 5% snapping on release, plus an integrated Quit Edge-Drop button.'
      }
    ]
  },
  {
    version: 'v0.2.1',
    date: 'Jul 28, 2026',
    isLatest: false,
    summary: 'Cross-reboot multi-monitor display persistence, 5-category macOS segmented filter control, unified image classification, and HD anti-aliased curved edges.',
    highlights: [
      {
        title: 'Cross-Reboot Display Persistence',
        description: '4-tier display resolution pipeline (geometry fuzzy-matching) remembers your chosen monitor across device restarts with an automatic primary display fallback.'
      },
      {
        title: '5-Category Segmented Filter Bar',
        description: 'Integrated All, Text, Links, Images, and Files quick filter chips with a persistent sliding spring pill and zero shape distortion.'
      },
      {
        title: 'Unified Image Entity Classification',
        description: 'Native screenshots (Win+Shift+S) and copied image files (.png, .jpg, .webp, .svg) are unified under the Images filter tab.'
      },
      {
        title: 'HD Anti-Aliased Curved Edges',
        description: 'GPU layer promotion (transform: translateZ(0)) and padding-box clipping deliver crisp, vector-smooth curved borders across all display scales.'
      }
    ]
  },
  {
    version: 'v0.2.0',
    date: 'Jul 26, 2026',
    isLatest: false,
    summary: 'Silent background auto-updater, GitHub Releases changelog synchronization, and glassmorphic pinned deck.',
    highlights: [
      {
        title: 'Silent Background Auto-Updater',
        description: 'GitHub releases feature silent background downloading and a single-click Restart to Update installation button.'
      },
      {
        title: 'Microsoft Store Build Isolation',
        description: 'Isolated build pipelines ensure Microsoft Store (MSIX) builds remain 100% compliant with Store policies.'
      },
      {
        title: 'Direct URL Launcher',
        description: 'Added quick action buttons to launch links in your default web browser directly from item cards and preview flyouts.'
      },
      {
        title: 'Pinned Items Deck Container',
        description: 'Encapsulated pinned items inside a dedicated deck container with smooth spring height animations.'
      }
    ]
  },
  {
    version: 'v0.1.5',
    date: 'Jul 24, 2026',
    isLatest: false,
    summary: 'Customizable Copy Indicator styles with a 2x2 grid selector flyout alongside panel hover stability fixes.',
    highlights: [
      {
        title: 'Four Vector Indicator Options',
        description: 'Added support for 4 customizable copy indicator styles including Logo, Tick, Copy, and Sparkle.'
      },
      {
        title: 'Balanced 2x2 Grid Flyout Selector',
        description: 'Integrated a 2x2 grid selector flyout inside Settings under Indicator Style for quick previews.'
      }
    ]
  }
]

let _releasesCache: Array<{
  version: string
  date: string
  isLatest: boolean
  summary: string
  highlights: Array<{ title: string; description: string }>
}> | null = null

async function fetchAndCacheReleases() {
  try {
    const response = await fetch('https://api.github.com/repos/PaRr0tBoY/Trace/releases', {
      headers: { 'User-Agent': 'Trace-App' },
      signal: AbortSignal.timeout(12000)
    })
    if (!response.ok) {
      return _releasesCache || STATIC_CHANGELOG_FALLBACK
    }
    const data = (await response.json()) as any[]
    if (!Array.isArray(data) || data.length === 0) {
      return _releasesCache || STATIC_CHANGELOG_FALLBACK
    }

    const parsed = data.slice(0, 10).map((rel, index) => {
      const tag = rel.tag_name || rel.name || `v0.1.${index}`
      const dateStr = rel.published_at
        ? new Date(rel.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : ''

      const rawBody = rel.body || ''
      const { summary, highlights } = parseReleaseBodyToCleanText(rawBody)

      return {
        version: tag.startsWith('v') ? tag : `v${tag}`,
        date: dateStr,
        isLatest: index === 0,
        summary: summary || `Release ${tag}`,
        highlights
      }
    })

    _releasesCache = parsed
    return parsed
  } catch {
    console.log('[IPC] GitHub releases fetch offline or timed out; using static fallback.')
    return _releasesCache || STATIC_CHANGELOG_FALLBACK
  }
}

