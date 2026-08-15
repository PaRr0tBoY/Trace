/**
 * IPC handler registration.
 *
 * Each `ipcMain.handle` here mirrors a contract in `shared/ipc.ts`. The
 * renderer calls them through the typed preload bridge, so a signature mismatch
 * is a compile-time error rather than a runtime one.
 */
import { app, ipcMain, clipboard, nativeImage, shell, dialog, BrowserWindow } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { psHost } from './powershell'
import { requestPanelFocus, releasePanelFocus, releasePanelFocusNow } from './focus'
import { type InvokeMap, type InvokeChannel, type SendMap, type SendChannel, type SuggestTitleContext } from '../../shared/ipc'
import { rehomeTraceAfterMerge } from '../store/traceStore'
import { getStore, getStationStore, stationClipboardItem, loadSettings, saveSettings, pushState, addFiles, getWatcher, getTaskStore, getNoteStore, getSuggestionEngine, getTitleSuggester, getMemoryStore, getMemoryGraph, getTraceStore, getLocalModelManager, getLocalModelRuntime, resetLocalModelRuntime, ensureLocalModelLoaded } from './state'
import type { FactRecord } from '../store/memoryGraph'
import { isTraceRecordDto, renderTraceReportHtml } from './traceReport'
import { sendToMainWindow, setVisible, setInteractive, setHeartbeatPaused, setHotZoneWidth, setPreviewMode, getDisplayListOptions, repositionWindow } from './window'
import { getOnboardingWindow } from './onboardingWindow'
import { startDragOut, resolveDragData, prefetchFileIcons, stageMoveDrag } from './drag'
import { disposeToRecycleBin } from './recycleBin'
import { enterContentToStation } from './contentToFile'
import { activateAppWindow } from './windowSwitch'
import { switcherHover, switcherClick, switcherCancel } from './switcher'
import { clipboardSignature } from '../clipboard/formats'
import { buildClipboardRef } from '../store/TaskStore'
import { mergeAppOptions } from './appOptions'
import { resolveAppIcon } from './appIcons'
import { recentEvents } from './eventBus'
import { acceptWithResource } from './suggestionDrop'
import { ProviderChain, testProvider } from './provider'
import { logAi } from './aiLog'
import { applyIncognito } from './tray'
import { checkForUpdatesManual, isStoreBuild, quitAndInstallUpdate, startUpdateDownload, syncAutoUpdaterState } from './updater'
import type { ItemData, MemoryFactDto, MemoryFactPanelPayload, MemoryListPayload, ResourceRef, Task } from '../../shared/types'

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
  sendToMainWindow('ui:toast', { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, message, tone })
}

/** Broadcast the local model manager status to every window (t54: progress / state / error). */
function pushLocalModelStatus(): void {
  const status = getLocalModelManager().status()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('local-model:status', status)
    }
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

/**
 * Build clipboard resource refs for the given item ids, snapshotting each
 * still-alive item (ADR-0002). Missing items are skipped silently — unless
 * the task already links them, in which case the existing snapshot survives
 * (evicted/dead resources must not vanish just because the form was saved).
 */
function buildResourcesFromIds(itemIds: string[] | undefined, existing?: Task): ResourceRef[] | undefined {
  if (itemIds === undefined) return undefined
  const refs: ResourceRef[] = []
  for (const itemId of itemIds) {
    const item = getStore().get(itemId)
    if (item) {
      refs.push(buildClipboardRef(item))
    } else {
      const old = existing?.resources.find((r) => r.kind === 'clipboard' && r.itemId === itemId)
      if (old) refs.push(old)
    }
  }
  return refs
}

/** Synchronizes launch at login settings with Windows Registry, resolving path drift after updates. */
export function syncLoginItemSettings(launchAtLogin?: boolean): void {
  if (!app.isPackaged) return
  const wantLaunch = launchAtLogin ?? loadSettings().launchAtLogin
  try {
    const exePath = app.getPath('exe')
    if (wantLaunch) {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: exePath,
        args: ['--hidden'],
        name: 'Edge-Drop'
      })
    } else {
      app.setLoginItemSettings({
        openAtLogin: false,
        path: exePath,
        name: 'Edge-Drop'
      })
    }
  } catch (err) {
    console.error('[IPC] Failed to sync login item settings:', err)
  }
}

export function registerIpc(): void {
  handle('state:load', () => {
    return {
      items: getStore().toDto(),
      station: getStationStore().toDto(),
      settings: loadSettings(),
      version: app.getVersion(),
      tasks: getTaskStore().toDto(),
      isStoreBuild: isStoreBuild(),
      notes: getNoteStore().toDto()
    }
  })

  /* --------------------------- transfer station (ADR-0006) --------------------------- */

  handle('station:list', () => getStationStore().toDto())

  handle('station:enter', (paths) => {
    const result = addFiles(paths)
    if (result.stacksCreated > 1) {
      toast(`Split into ${result.stacksCreated} station entries (max 10 each)`, 'info')
    }
    return getStationStore().toDto()
  })

  handle('station:enter-content', (input) => enterContentToStation(input))

  handle('station:pin', (id, pinned) => {
    getStationStore().pin(id, pinned)
    return getStationStore().toDto()
  })

  handle('station:delete', (id) => {
    const entry = getStationStore().get(id)
    // An in-transit entry holds its files in the staging area: deleting it
    // sends them to the Recycle Bin (ADR-0007). A failed disposal keeps the
    // entry so the user can retry — nothing is ever permanently deleted.
    if (entry?.inTransit && entry.paths.length > 0 && !disposeToRecycleBin(entry.paths)) {
      toast('Held files could not be sent to the Recycle Bin; entry kept for retry', 'error')
      return getStationStore().toDto()
    }
    getStationStore().remove(id)
    // A deleted entry that is still on the clipboard must not zombie
    // re-enter on the next watcher tick (same contract as item:delete).
    getWatcher().resyncSignature()
    return getStationStore().toDto()
  })

  handle('station:copy-member', async (req) => {
    if (!req || typeof req.id !== 'string' || !req.paths || req.paths.length === 0) return false
    const entry = getStationStore().get(req.id)
    if (!entry) return false
    const paths = req.paths.filter((p) => entry.paths.includes(p))
    if (paths.length === 0) return false
    await writeFileListToClipboard(paths)
    return true
  })

  handle('station:paste-member', async (req) => {
    const watcher = getWatcher()
    const now = Date.now()
    if (now - _lastPasteTime < PASTE_GUARD_MS) return false
    _lastPasteTime = now
    if (!req || typeof req.id !== 'string' || !req.paths || req.paths.length === 0) return false
    const entry = getStationStore().get(req.id)
    if (!entry) return false
    const paths = req.paths.filter((p) => entry.paths.includes(p))
    if (paths.length === 0) return false

    watcher.setPaused(true)
    try {
      await writeFileListToClipboard(paths)
      pushState.togglePanel(false)
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

  /* --------------------------- ai provider --------------------------- */

  /* --------------------------- ai provider --------------------------- */

  handle('ai:test-provider', (config) => testProvider(config))

  /* --------------------------- local model (t54) --------------------------- */

  handle('local-model:status', () => getLocalModelManager().status())

  handle('local-model:start-download', async () => {
    const manager = getLocalModelManager()
    const status = manager.status()
    if (status.state === 'downloading' || status.state === 'ready') return
    try {
      await manager.startDownload(() => pushLocalModelStatus())
    } finally {
      pushLocalModelStatus()
      ensureLocalModelLoaded()
    }
  })

  handle('local-model:remove', async () => {
    await getLocalModelManager().removeModel()
    getLocalModelRuntime().dispose().catch(() => {})
    resetLocalModelRuntime()
    pushLocalModelStatus()
    return getLocalModelManager().status()
  })

  handle('local-model:set-source', (source) => {
    const manager = getLocalModelManager()
    manager.selectSource(source)
    saveSettings({ localModelSource: source })
    pushLocalModelStatus()
    ensureLocalModelLoaded()
    return manager.status()
  })

  handle('local-model:set-path', (path) => {
    const manager = getLocalModelManager()
    manager.setManualPath(path)
    saveSettings({ localModelManualPath: path ?? undefined })
    pushLocalModelStatus()
    ensureLocalModelLoaded()
    return manager.status()
  })

  handle('local-model:pick-path', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Select local model (.gguf)',
      properties: ['openFile'],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }]
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })

  /* --------------------------- task domain --------------------------- */

  handle('task:load', () => {
    return getTaskStore().toDto()
  })

  handle('task:create', (title, opts) => {
    getTaskStore().create(title, {
      note: opts?.note,
      apps: opts?.apps,
      resources: buildResourcesFromIds(opts?.clipboardItemIds)
    })
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:update', (id, patch) => {
    // Clipboard resources are snapshotted main-side (the renderer only sends
    // item ids); files resources are untouched by the form. Evicted items the
    // task already links keep their old snapshot instead of vanishing.
    const clipboardRefs =
      patch.clipboardItemIds !== undefined
        ? buildResourcesFromIds(patch.clipboardItemIds, getTaskStore().get(id))
        : undefined
    getTaskStore().update(id, { ...patch, clipboardRefs })
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:delete', (id) => {
    getTaskStore().delete(id)
    // Adopted AI-rationale trace lives with its task (spec 决策 8): a hard
    // delete cascades, so no orphan rows point at a dead task id.
    getTraceStore()?.deleteByTaskId(id)
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:merge', (targetId, sourceId) => {
    const merged = getTaskStore().merge(targetId, sourceId)
    // The absorbed task's decision chains stay relevant to the survivor:
    // rehome its trace rows only when the merge actually succeeded.
    rehomeTraceAfterMerge(getTraceStore(), merged, sourceId, targetId)
    pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('task:link-item', (taskId, itemId) => {
    // Station entries link as files resources (ADR-0006): the station lookup
    // falls back when the id is not a clipboard-stack item.
    const item = getStore().get(itemId) ?? stationClipboardItem(itemId)
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
    // t56：保存时自动标题迁入决策模块（ADR-0003 通道与触发条件不变）。
    return getTitleSuggester().suggestTitle(ctx)
  })

  handle('task:app-options', () => {
    // L0-tracked apps (event bus) ∪ clipboard sourceApps (persisted) — same
    // foreground tracker, two views (ADR-0002).
    return mergeAppOptions(recentEvents(), getStore().list())
  })

  /* --------------------------- notes domain --------------------------- */

  handle('note:load', () => getNoteStore().toDto())

  handle('note:create', (content) => {
    const createdId = getNoteStore().create(content)
    pushState.notes()
    return { notes: getNoteStore().toDto(), createdId }
  })

  handle('note:update', (id, patch) => {
    getNoteStore().update(id, patch)
    pushState.notes()
    return getNoteStore().toDto()
  })

  handle('note:delete', (id) => {
    getNoteStore().delete(id)
    pushState.notes()
    return getNoteStore().toDto()
  })

  handle('app:icons', (exePaths) => {
    const unique = [...new Set(exePaths)]
    const icons: Record<string, string | null> = {}
    return Promise.all(
      unique.map(async (p) => {
        icons[p] = await resolveAppIcon(p)
      })
    ).then(() => icons)
  })

  handle('app:open-linked-window', (appRef) => {
    return activateAppWindow(appRef)
  })

  /* --------------------------- suggestions --------------------------- */

  /**
   * Resolve the convert panel's clipboard selection into final refs: live
   * items snapshot fresh; evicted-but-linked items keep the suggestion's
   * own snapshot (dead rows can't be unchecked in the panel).
   */
  const suggestionClipboardRefs = (id: string, itemIds: string[] | undefined): ResourceRef[] | undefined => {
    if (itemIds === undefined) return undefined
    const suggestion = getSuggestionEngine().suggestions().find((s) => s.id === id)
    const own = new Map(
      (suggestion?.clipboardRefs ?? [])
        .filter((r): r is Extract<ResourceRef, { kind: 'clipboard' }> => r.kind === 'clipboard')
        .map((r) => [r.itemId, r])
    )
    const refs: ResourceRef[] = []
    for (const itemId of itemIds) {
      const item = getStore().get(itemId)
      if (item) refs.push(buildClipboardRef(item))
      else {
        const old = own.get(itemId)
        if (old) refs.push(old)
      }
    }
    return refs
  }

  handle('suggestion:accept', (id, opts) => {
    const accepted = getSuggestionEngine().accept(id, {
      title: opts?.title,
      note: opts?.note,
      apps: opts?.apps,
      clipboardRefs: suggestionClipboardRefs(id, opts?.clipboardItemIds)
    })
    if (accepted !== null) pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('suggestion:accept-with-resource', (id, titleOverride, resource) => {
    // Build the clipboard snapshot here (ItemStore access lives in this layer),
    // then let the pure composition accept + link atomically.
    const ref: ResourceRef | null =
      resource.kind === 'clipboard'
        ? (() => {
            // Station entries link as files resources (ADR-0006): the station
            // lookup falls back when the id is not a clipboard-stack item.
            const item = getStore().get(resource.itemId) ?? stationClipboardItem(resource.itemId)
            return item ? buildClipboardRef(item) : null
          })()
        : { kind: 'files', paths: resource.paths }
    const accepted = ref
      ? acceptWithResource(getSuggestionEngine(), getTaskStore(), id, titleOverride, ref)
      : getSuggestionEngine().accept(id, { title: titleOverride })
    if (accepted !== null) pushState.tasks()
    return getTaskStore().toDto()
  })

  handle('suggestion:ignore', (id, reason) => {
    getSuggestionEngine().ignore(id, reason)
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

  /* --------------------------- memory graph panel (t51) --------------------------- */

  /**
   * 记忆图面板载荷：未失效 facts（UI 按 type 过滤分组）+ 待裁决冲突对（含
   * 被失效方）+ 每条内联来源链 episode 摘要。DB 故障（graph null）→ 空载荷，
   * 面板降级只读空态（不阻塞设置页其余部分）。
   */
  const memoryGraphPayload = (): MemoryFactPanelPayload => {
    const graph = getMemoryGraph()
    if (!graph) return { facts: [], conflicts: [], degraded: true }
    const episodes = new Map(graph.listEpisodes().map((e) => [e.id, e]))
    const toDto = (f: FactRecord): MemoryFactDto => {
      const ep = f.episodeId !== null ? episodes.get(f.episodeId) : undefined
      return {
        id: f.id,
        type: f.type,
        content: f.content,
        source: f.source,
        userState: f.userState,
        intent: f.intent,
        weight: f.weight,
        validAt: f.validAt,
        invalidAt: f.invalidAt,
        expiredAt: f.expiredAt,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        hitCount: f.hitCount,
        episodeId: f.episodeId,
        episode: ep ? { id: ep.id, startedAt: ep.startedAt, endedAt: ep.endedAt, summary: ep.summary } : null
      }
    }
    return {
      facts: graph.listFacts().map(toDto),
      conflicts: graph.listConflicts().map((c) => ({ active: toDto(c.active), invalidated: toDto(c.invalidated) })),
      degraded: false
    }
  }

  handle('memory-graph:list', () => memoryGraphPayload())
  handle('memory-graph:set-state', (id, userState) => {
    const graph = getMemoryGraph()
    return graph && graph.updateFactState(id, userState) ? memoryGraphPayload() : null
  })
  handle('memory-graph:adjudicate', (activeId, invalidatedId, resolution) => {
    getMemoryGraph()?.adjudicateConflict(activeId, invalidatedId, resolution)
    return memoryGraphPayload()
  })

  /* --------------------------- ai rationale (trace, t42) --------------------------- */

  handle('trace:list-by-decision', (decisionId) => {
    const store = getTraceStore()
    return store ? store.listByDecisionId(decisionId) : []
  })

  handle('trace:list-by-task', (taskId) => {
    const store = getTraceStore()
    return store ? store.listByTaskId(taskId) : []
  })

  handle('trace:get-by-id', (id) => {
    const store = getTraceStore()
    return store ? (store.getById(id) ?? null) : null
  })

  /**
   * Clear AI-rationale data: unadopted rows only (taskId IS NULL) — the same
   * boundary traceStore.cleanupBefore enforces for retention. Adopted trace
   * lives with its task and is untouched (it dies with the task instead).
   * The +1 ms guard avoids leaving rows created in the same millisecond.
   */
  handle('trace:clear', () => {
    const store = getTraceStore()
    return store ? store.cleanupBefore(Date.now() + 1) : 0
  })

  /** Export the chain the panel is showing as a standalone HTML report (save dialog). */
  handle('trace:export-report', async (records) => {
    if (!Array.isArray(records) || !records.every((r) => isTraceRecordDto(r))) {
      console.error('[IPC] trace:export-report rejected malformed records payload')
      return null
    }
    const html = renderTraceReportHtml(records)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export AI Rationale Report',
      defaultPath: `trace-ai-rationale-${Date.now()}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (canceled || !filePath) return null
    try {
      writeFileSync(filePath, html, 'utf8')
      return filePath
    } catch (err) {
      console.error('[IPC] trace:export-report write failed:', err)
      return null
    }
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

  handle('item:delete-batch', (ids) => {
    if (!ids || ids.length === 0) return getStore().toDto()
    const items = ids.map((id) => getStore().get(id)).filter(Boolean)
    getStore().deleteBatch(ids)
    if (items.some((item) => item && clipboardMatchesItem(item.data))) {
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

  handle('item:get-full-text', (id) => {
    return getStore().getFullText(id)
  })

  handle('item:copy', async (id) => {
    const item = getStore().get(id)
    console.log('[IPC] item:copy id=', id, 'found=', !!item)
    if (!item) return false

    const watcher = getWatcher()
    watcher.setPaused(true)
    const fullText = item.data.kind === 'text' ? getStore().getFullText(id) : undefined
    const itemDataWithFullText = item.data.kind === 'text' && fullText ? { ...item.data, text: fullText } : item.data
    await writeItemToClipboard(itemDataWithFullText)
    console.log('[IPC] item:copy wrote to clipboard, kind=', item.data.kind)

    // Promote the copied item to the top of the history stack
    getStore().add(itemDataWithFullText, loadSettings().historyLimit)
    pushState.items()

    // Unpause after a short delay to allow OS clipboard event to settle.
    // Respect the current incognito state when unpausing.
    setTimeout(() => {
      watcher.setPaused(loadSettings().incognito)
    }, 200)

    return true
  })

  handle('item:copy-subitem', async (req) => {
    // Resolve a single image of a collection and write just that onto the
    // clipboard — not the whole item. (File members live in the station and
    // use station:copy-member.)
    const dto = getStore().toDto().find((d) => d.id === req.id)
    if (!dto) return false

    let wrote = false
    if (dto.data.kind === 'image-collection' && req.imageId) {
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

      // 2. Write item to system clipboard
      const fullText = item.data.kind === 'text' ? getStore().getFullText(id) : undefined
      const itemDataWithFullText = item.data.kind === 'text' && fullText ? { ...item.data, text: fullText } : item.data
      await writeItemToClipboard(itemDataWithFullText)
      console.log('[IPC] item:paste wrote to clipboard, kind=', item.data.kind)

      // 3. Touch item timestamp — moves unpinned items to the top of Recent.
      getStore().touch(id)

      // 4. Simulate Ctrl+V after 50ms
      setTimeout(() => {
        simulatePaste()
      }, 50)

      // 5. Broadcast updated items list after panel has fully closed off-screen (250ms)
      setTimeout(() => {
        pushState.items()
      }, 250)
    } finally {
      // Resync the watcher signature after paste so standard OS Ctrl+V does NOT
      // increment item hitCounts or re-order items.
      setTimeout(() => {
        watcher.resyncSignature()
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
      if (dto.data.kind === 'image-collection' && req.imageId) {
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

  handle('item:remove-subitem', (req) => {
    const success = getStore().removeSubitem(req)
    if (success) pushState.items()
    return success
  })

  handle('settings:update', (patch) => {
    const next = saveSettings(patch)
    if (patch.incognito !== undefined) {
      // The tray toggle applies the watcher pause through this hook; the
      // settings sheet must too — otherwise capture keeps polling until the
      // next event gate (still correct, but the pause is the contract).
      applyIncognito(next.incognito)
    }
    if (patch.launchAtLogin !== undefined) {
      syncLoginItemSettings(next.launchAtLogin)
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
    // Keep the memory graph's decay in lockstep too (it snapshots λ at startup).
    getMemoryGraph()?.setLambda(next.memoryLambda)
    // Enabling the local model enhancement must eagerly load the runtime —
    // otherwise the first suggestion degrades silently until a restart
    // (t54: the lazy optimizer gates on manager state, not on this hook).
    if (patch.localModelEnabled === true) {
      ensureLocalModelLoaded()
    }
    if (patch.autoUpdates !== undefined) {
      // Keep electron-updater's download flags in lockstep with the setting.
      syncAutoUpdaterState()
    }
    pushState.settings(next)
    return next
  })

  handle('window:set-interactive', (value) => {
    setInteractive(value)
    // Panel closed (interactive -> non-interactive): drop any active input
    // focus immediately so the NOACTIVATE style is restored and later plain
    // clicks don't activate the window (see focus.ts).
    if (!value) {
      releasePanelFocusNow()
    }
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

  handle('app:quit', () => {
    app.quit()
  })

  /* --------------------------- auto-update --------------------------- */

  handle('updater:check-manual', () => checkForUpdatesManual())

  handle('updater:start-download', () => startUpdateDownload())

  handle('app:install-update', () => {
    quitAndInstallUpdate()
  })
}

/** Singleton provider chain for the suggestion engine (t19); settings-driven. */
let providerChain: ProviderChain | null = null

export function getProviderChain(): ProviderChain {
  if (!providerChain) {
    providerChain = new ProviderChain({
      getProviders: () => loadSettings().aiProviders,
      log: (entry) => logAi(entry)
    })
    console.log(`[AI] provider chain ready (${loadSettings().aiProviders.length} providers)`)
  }
  return providerChain
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

  on('panel:expand', () => {
    setVisible(true)
    setInteractive(true)
    pushState.togglePanel(true)
  })

  on('switcher:hover', (_sender, index) => {
    switcherHover(index)
  })

  on('switcher:click', (_sender, index) => {
    switcherClick(index)
  })

  on('switcher:cancel', () => {
    switcherCancel()
  })

  on('item:start-drag', (sender, req) => {
    console.log('[IPC] item:start-drag req=', JSON.stringify(req))
    // Station whole-entry drags (no explicit paths) fall back to a files
    // bundle built from the entry's paths (ADR-0006). Member drags carry
    // explicit paths and are resolved by resolveDragData directly.
    let data = resolveDragData(req)
    if (!data) {
      const entry = req.paths && req.paths.length > 0 ? undefined : getStationStore().get(req.id)
      if (entry) {
        const paths = entry.paths.filter((p) => existsSync(p))
        if (paths.length > 0) {
          data = { kind: 'files', paths }
          prefetchFileIcons(paths)
        }
      }
    }
    if (!data) {
      console.log('[IPC] start-drag: no data resolved')
      return
    }
    console.log('[IPC] start-drag: kind=', data.kind)

    // ADR-0007 M-a: in move mode a station file drag stages the originals
    // into the takeover area before the OS drag sources them; the entry is
    // retargeted and marked in-transit. 'skip' means a file is missing — the
    // drag must not start at all.
    if (data.kind === 'files' && loadSettings().moveMode === 'move') {
      const staged = stageMoveDrag(req, data)
      if (staged.ok) {
        data = staged.data
      } else if (staged.reason === 'skip') {
        console.log('[IPC] start-drag: skipped — entry has missing files')
        return
      }
    }

    // Pause the always-on-top heartbeat for the duration of the drag.
    // The heartbeat fires SetWindowPos(HWND_TOPMOST) every 500 ms, which
    // pushes our window in front of the DWM drag-ghost image — making the
    // dragged item appear to vanish ~0.5 s into any drag gesture.
    setHeartbeatPaused(true)

    try {
      // Every kind — text included — rides the DWM file drag-out. Text is
      // staged as a temp .txt (see drag.ts); the main-process OLE drag
      // (oleDrag.ts, git history) could not marshal its koffi IDataObject to
      // out-of-process drop targets and always failed with RPC_E_CALL_REJECTED.
      startDragOut(sender, data)
    } finally {
      console.log('[IPC] start-drag returned, sending drag-end')
      sender.send('item:drag-end')

      // Re-enable the heartbeat now that the drag is over.
      setHeartbeatPaused(false)
    }

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
    case 'text': {
      const textToUse = data.text
      clipboard.clear()
      clipboard.write({ text: textToUse, html: data.html })
      break
    }

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
    version: 'v2026.8.12',
    date: 'Aug 12, 2026',
    isLatest: true,
    summary: "Trace's first release — task layer (candidates, guided editor, linked windows), AI observability, dual-row navigation with restore, 5 accent themes.",
    highlights: [
      {
        title: 'Task Layer',
        description: 'Candidate task cards from foreground-activity clustering; guided create/edit editor with app grid, clipboard material picker and AI title fallback; task detail with linked windows (switch/launch); drop-to-bind from the panel.'
      },
      {
        title: 'Dual-Row Navigation & Restore',
        description: 'Clipboard / Files / Tasks views with second-level filters; the panel remembers the last page across opens (instant to forever) with edit protection.'
      },
      {
        title: 'Accent Themes',
        description: 'Five accent colors (Graphite / Cobalt / Verdigris / Amber / Violet) applied across panel, drag ghost and copy indicator.'
      },
      {
        title: 'AI Observability & Provider Hardening',
        description: 'ai-log.jsonl for chat calls and algorithm outputs; adaptive retry with thinking-model detection and output-budget scaling; OCR context for suggestions.'
      },
      {
        title: 'Performance',
        description: 'Thumbnail protocol keeps base64 out of IPC; movement-only cursor IPC; FLIP layout animation on short lists; drag-out text via temp file.'
      }
    ]
  },
  {
    version: 'v0.2.6',
    date: 'Aug 05, 2026',
    isLatest: false,
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

