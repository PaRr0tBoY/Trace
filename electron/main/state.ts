/**
 * Central runtime state & renderer notification hub.
 *
 * Owns the single ItemStore and ClipboardWatcher instances and provides typed
 * helpers to broadcast changes to the renderer. Every mutation goes through
 * here so there's one path that re-pushes the DTO list.
 */
import { ItemStore } from '../store/ItemStore'
import { ClipboardWatcher } from '../clipboard/ClipboardWatcher'
import { loadSettings, saveSettings } from '../store/settings'
import { TaskStore, type TaskIndex } from '../store/TaskStore'
import { openDatabase, closeDatabase, type TraceDatabase } from '../store/db'
import { createSqliteSessionStore } from '../store/sessionStore'
import { MemoryStore, type MemoryIndex } from '../store/MemoryStore'
import type { ClipboardItem, ClipboardItemDto, Settings, TaskProposal, TaskDto } from '../../shared/types'
import { MAX_STACK } from '../../shared/types'
import { createId } from '../store/ids'
import { nativeImage, BrowserWindow, powerMonitor, safeStorage, app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../store/paths'
import { prefetchFileIcons } from './drag'
import { attachAppIcons, attachSuggestionIcons } from './appIcons'
import { runtime } from './config'
import { queryForegroundSnapshot, type ForegroundSnapshot } from './foreground'
import { emit, recentEvents } from './eventBus'
import { buildClipboardEvent } from './attributor'
import { createSuggestionEngine, TICK_INTERVAL_MS, type ChatFn, type OcrFn, type SuggestionEngine } from './suggestionEngine'
import { createIgnoredTable } from './ignored'
import { logAi } from './aiLog'

const store = new ItemStore()
const watcher = new ClipboardWatcher(600)
let pruneTimer: ReturnType<typeof setInterval> | null = null
let wakeTimer: ReturnType<typeof setTimeout> | null = null
let taskSweepTimer: ReturnType<typeof setInterval> | null = null
let suggestionTimer: ReturnType<typeof setInterval> | null = null
let suggestionEngine: SuggestionEngine | null = null
let memoryStore: MemoryStore | null = null
/** SQLite canonical store handle (opened after app ready; closed on quit). */
let traceDb: TraceDatabase | null = null

/**
 * Task persistence adapter: tasks.json with DPAPI encryption when available
 * (same envelope as items.json — task titles are work context, not public).
 * The pure TaskStore never sees Electron; it only gets load/save here.
 */
const taskStore = new TaskStore({
  load: () => loadTasksFile(),
  save: (index) => saveTasksFile(index),
  isItemAlive: (itemId) => store.get(itemId) !== undefined
})

function loadTasksFile(): TaskIndex | null {
  try {
    const file = PATHS.tasksFile()
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8').trim()
    if (!text) return null
    const parsed = JSON.parse(text) as { encrypted?: boolean; payload?: string; tasks?: unknown }
    if (parsed.encrypted === true && typeof parsed.payload === 'string') {
      if (!safeStorage.isEncryptionAvailable()) return null
      return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.payload, 'base64'))) as TaskIndex
    }
    if (Array.isArray(parsed.tasks)) return parsed as TaskIndex
    return null
  } catch (err) {
    console.error('[Task] tasks.json load failed:', err)
    return null
  }
}

function saveTasksFile(index: TaskIndex): void {
  try {
    const file = PATHS.tasksFile()
    if (safeStorage.isEncryptionAvailable()) {
      const envelope = {
        v: 2,
        encrypted: true,
        payload: safeStorage.encryptString(JSON.stringify(index)).toString('base64')
      }
      writeFileSync(file, JSON.stringify(envelope, null, 2), 'utf8')
    } else {
      writeFileSync(file, JSON.stringify(index, null, 2), 'utf8')
    }
  } catch (err) {
    console.error('[Task] tasks.json save failed:', err)
  }
}

/**
 * Memory persistence adapter: memories.json with the same DPAPI envelope as
 * tasks.json — memory content (identity/workflow) is strictly more sensitive
 * than task titles, so it never sits on disk as plaintext when the OS key
 * store is available.
 */
function loadMemoriesFile(): MemoryIndex | null {
  try {
    const file = PATHS.memoriesFile()
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8').trim()
    if (!text) return null
    const parsed = JSON.parse(text) as { encrypted?: boolean; payload?: string; memories?: unknown }
    if (parsed.encrypted === true && typeof parsed.payload === 'string') {
      if (!safeStorage.isEncryptionAvailable()) return null
      return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.payload, 'base64'))) as MemoryIndex
    }
    if (Array.isArray(parsed.memories)) return parsed as MemoryIndex
    return null
  } catch (err) {
    console.error('[Memory] memories.json load failed:', err)
    return null
  }
}

function saveMemoriesFile(index: MemoryIndex): void {
  try {
    const file = PATHS.memoriesFile()
    if (safeStorage.isEncryptionAvailable()) {
      const envelope = {
        v: 1,
        encrypted: true,
        payload: safeStorage.encryptString(JSON.stringify(index)).toString('base64')
      }
      writeFileSync(file, JSON.stringify(envelope, null, 2), 'utf8')
    } else {
      writeFileSync(file, JSON.stringify(index, null, 2), 'utf8')
    }
  } catch (err) {
    console.error('[Memory] memories.json save failed:', err)
  }
}

/**
 * Ignored-suggestion signatures (userData/ignored.json, LRU 200). Plain JSON:
 * signatures are one-way hashes of app+time-slot material, no titles or paths.
 */
const ignoredFile = (): string => join(app.getPath('userData'), 'ignored.json')

function loadIgnoredSignatures(): string[] | null {
  try {
    const file = ignoredFile()
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8').trim()
    if (!text) return null
    const parsed = JSON.parse(text) as { signatures?: unknown }
    if (!Array.isArray(parsed.signatures)) return null
    return parsed.signatures.filter((s): s is string => typeof s === 'string' && s.length > 0)
  } catch (err) {
    console.error('[Suggestion] ignored.json load failed:', err)
    return null
  }
}

function saveIgnoredSignatures(signatures: string[]): void {
  try {
    writeFileSync(ignoredFile(), JSON.stringify({ version: 1, signatures }, null, 2), 'utf8')
  } catch (err) {
    console.error('[Suggestion] ignored.json save failed:', err)
  }
}

function handleSystemSleep(): void {
  watcher.setPaused(true)
}

function handleSystemWake(): void {
  watcher.resyncSignature()
  watcher.setPaused(true)

  if (wakeTimer !== null) clearTimeout(wakeTimer)
  wakeTimer = setTimeout(() => {
    wakeTimer = null
    watcher.resyncSignature()
    watcher.setPaused(loadSettings().incognito)
  }, 1500)
}

/** Initialize persistence + start the clipboard watcher. */
export function initState(): void {
  store.load()
  // Task sessions persist in the SQLite canonical store (task_sessions,
  // t37). Open the handle after app ready and attach before taskStore.load()
  // so startup hydration sees every previously recorded session. A corrupt
  // or ABI-mismatched database degrades to in-memory sessions only — the
  // app must still start, the TaskStore just loses cross-restart history.
  try {
    traceDb = openDatabase(PATHS.dbFile())
    taskStore.attachSessionStore(createSqliteSessionStore(traceDb))
  } catch (err) {
    traceDb = null
    console.error('[Sessions] trace.db open failed; sessions will not persist:', err)
  }
  taskStore.load()
  taskStore.setPauseThreshold(loadSettings().taskPauseThresholdMinutes)
  const settings = loadSettings()
  getMemoryStore().load()
  getMemoryStore().setDecay({
    lambda: settings.memoryLambda,
    staleDays: settings.memoryStaleDays,
    cleanupScore: settings.memoryCleanupScore
  })
  const swept = taskStore.sweep() // stale RUNNING tasks from a previous session must not masquerade as live
  console.log(`[Task] store ready: ${taskStore.list().length} tasks${swept > 0 ? `, ${swept} idle-rested` : ''}`)
  if (loadSettings().clearUnpinnedOnRestart) {
    store.clearUnpinned()
  }
  store.pruneExpired(loadSettings().autoDeleteHours)

  for (const item of store.toDto()) {
    if (item.data.kind === 'files' && item.data.paths) {
      prefetchFileIcons(item.data.paths)
    }
  }
  watcher.start((data, png) => {
    if (loadSettings().incognito) return
    store.pruneExpired(loadSettings().autoDeleteHours)
    if (data.kind === 'image' && png && data.imageId) {
      store.stageImageBytes(data.imageId, png)
    }
    if (data.kind === 'files' && data.paths) {
      prefetchFileIcons(data.paths)
    }
    // One foreground read per capture, shared by the item's sourceApp
    // (ADR-0001) and the t14 attribution event — same source, same gate.
    const settings = loadSettings()
    const foreground =
      settings.taskCaptureEnabled && settings.l0CaptureEnabled ? queryForegroundSnapshot() : null
    store.add(
      data,
      settings.historyLimit,
      foreground ? { name: foreground.appName, exePath: foreground.exePath } : undefined
    )
    pushState.items()
    logClipboardCapture(store.list()[0], foreground)
  })
  watcher.setPaused(loadSettings().incognito)

  powerMonitor.removeAllListeners('suspend')
  powerMonitor.removeAllListeners('lock-screen')
  powerMonitor.removeAllListeners('resume')
  powerMonitor.removeAllListeners('unlock-screen')

  powerMonitor.on('suspend', handleSystemSleep)
  powerMonitor.on('lock-screen', handleSystemSleep)
  powerMonitor.on('resume', handleSystemWake)
  powerMonitor.on('unlock-screen', handleSystemWake)

  // After a restart-clear, the watcher.start() seeds lastSig from the live
  // clipboard (correct). But if clearUnpinnedOnRestart removed items that are
  // still on the clipboard, the user can re-copy them immediately — this works
  // because start() always re-seeds lastSig fresh from the current clipboard.
  // No extra invalidate() is needed here.

  if (pruneTimer !== null) clearInterval(pruneTimer)
  pruneTimer = setInterval(() => {
    if (runtime.quitting) return
    if (store.pruneExpired(loadSettings().autoDeleteHours)) {
      // Pruned items should be re-capturable if still on the clipboard.
      watcher.resyncSignature()
      pushState.items()
    }
  }, 60_000)

  if (taskSweepTimer !== null) clearInterval(taskSweepTimer)
  taskSweepTimer = setInterval(() => {
    if (runtime.quitting) return
    taskStore.setPauseThreshold(loadSettings().taskPauseThresholdMinutes)
    if (taskStore.sweep() > 0) pushState.tasks()
  }, 60_000)

  if (suggestionTimer !== null) clearInterval(suggestionTimer)
  suggestionTimer = setInterval(() => {
    if (runtime.quitting) return
    getSuggestionEngine().tick()
  }, TICK_INTERVAL_MS)
  getSuggestionEngine().start()
}

/**
 * Log a clipboard capture onto the event bus (suggestion engine input).
 *
 * The source app is the foreground at capture time, read through t12's
 * collector query (the ForegroundWatcher instance is owned by main/index.ts,
 * so this module reads the OS directly — same Win32 call, nothing added to
 * the clipboard poll loop). Task resources are NOT auto-linked here: a
 * task's clipboard content is fixed at creation time and only changes when
 * the user explicitly links/unlinks (drop-to-bind, task:link-item). The
 * item and the event share one foreground read: the caller only reads a
 * snapshot when task capture and L0 capture are both on, so with the gate
 * off nothing is recorded (incognito is already gated at the watcher
 * before this runs).
 */
function logClipboardCapture(item: ClipboardItem | undefined, foreground: ForegroundSnapshot | null): void {
  if (!item || !foreground) return

  const event = buildClipboardEvent(foreground, item.capturedAt, item.id)
  emit(event)
}

export function stopStateTimers(): void {
  if (pruneTimer !== null) {
    clearInterval(pruneTimer)
    pruneTimer = null
  }
  if (taskSweepTimer !== null) {
    clearInterval(taskSweepTimer)
    taskSweepTimer = null
  }
  if (suggestionTimer !== null) {
    clearInterval(suggestionTimer)
    suggestionTimer = null
  }
  suggestionEngine?.stop()
  if (traceDb !== null) {
    closeDatabase(traceDb)
    traceDb = null
  }
}

export function getStore(): ItemStore {
  return store
}

export function getWatcher(): ClipboardWatcher {
  return watcher
}

export function getTaskStore(): TaskStore {
  return taskStore
}

/**
 * Memory store singleton (t20). Lazily constructed so the IPC layer and the
 * suggestion engine can reach it without ordering constraints. Loaded once in
 * initState(); decay parameters track Settings at runtime (settings:update).
 */
export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore({
      load: () => loadMemoriesFile(),
      save: (index) => saveMemoriesFile(index),
      // Every memory write lands in ai-log.jsonl (suggest/confirm/ban/…).
      log: (entry) => logAi(entry)
    })
  }
  return memoryStore
}

/**
 * Suggestion engine singleton (t19). Lazily constructed so the IPC layer can
 * reach it without ordering constraints; the provider chain is wired in
 * index.ts via setSuggestionChat once both sides exist.
 */
export function getSuggestionEngine(): SuggestionEngine {
  if (!suggestionEngine) {
    suggestionEngine = createSuggestionEngine({
      now: () => Date.now(),
      readEvents: () => recentEvents(),
      store: taskStore,
      getSettings: () => loadSettings(),
      ignored: createIgnoredTable({ load: loadIgnoredSignatures, save: saveIgnoredSignatures }),
      onSuggestions: (suggestions) => pushState.suggestions(suggestions),
      // Context-prior: only live project/workflow memories reach the engine.
      readMemories: () => getMemoryStore().list(),
      // Clipboard items copied during a segment ride along on the suggestion.
      readItem: (itemId) => store.get(itemId),
      // Observability: the pipeline's algorithm outputs land in ai-log.jsonl.
      log: (entry) => logAi(entry),
      // Feedback distillation: accepted suggestions become suggested candidates.
      onMemorySuggestion: (candidate) => {
        getMemoryStore().suggestMemory({ ...candidate, source: 'task-feedback' })
      }
    })
  }
  return suggestionEngine
}

/** Wire the provider chain into the engine (index.ts, after registerIpc). */
export function setSuggestionChat(chat: ChatFn): void {
  getSuggestionEngine().setChat(chat)
}

/** Wire the OCR capture into the engine (index.ts, after registerIpc). */
export function setSuggestionOcr(ocrFn: OcrFn): void {
  getSuggestionEngine().setOcr(ocrFn)
}

/** Push updates to all open windows (main window, onboarding window, etc.). */
function send(channel: string, ...args: unknown[]): void {
  if (runtime.quitting) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

export const pushState = {
  items(): void {
    const dto: ClipboardItemDto[] = store.toDto()
    send('state:items', dto)
  },
  async tasks(): Promise<void> {
    const dto: TaskDto[] = await attachAppIcons(taskStore.toDto())
    send('state:tasks', dto)
  },
  async suggestions(suggestions: TaskProposal[]): Promise<void> {
    const dto: TaskProposal[] = await attachSuggestionIcons(suggestions)
    send('state:suggestions', dto)
  },
  settings(next: Settings): void {
    send('state:settings', next)
  },
  togglePanel(open?: boolean): void {
    console.log(`[Main] Sending window:toggle event to renderer with open=${open}`)
    send('window:toggle', open)
  },
  openSettings(): void {
    console.log('[Main] Sending window:open-settings event to renderer')
    send('window:open-settings')
  },
  updateAvailable(info: { version: string }): void {
    console.log('[Main] Sending app:update-available event to renderer:', info)
    send('app:update-available', info)
  },
  updateDownloaded(info: { version: string }): void {
    console.log('[Main] Sending app:update-downloaded event to renderer:', info)
    send('app:update-downloaded', info)
  }
}

/** Re-export for handlers that mutate settings then need to broadcast. */
export { loadSettings, saveSettings }

/**
 * Result of importing dropped files: how many stacks were created and whether
 * any overflow was chunked, so the IPC layer can show an informative toast.
 */
export interface AddFilesResult {
  /** Total number of separate items/stacks created (1 means a single bundle). */
  stacksCreated: number
}

/**
 * Import dropped file paths.
 *
 * Drops are partitioned into images vs. other files (so a mixed drop of e.g.
 * 2 images + 3 docs becomes an image-collection *and* a files bundle instead of
 * collapsing everything into a generic bundle that loses image previews). Each
 * partition is then chunked into stacks of at most MAX_STACK items.
 */
export function addFiles(paths: string[]): AddFilesResult {
  // Prevent duplicating items when a user accidentally drops our own staged temp
  // files back into the app. Real files are deduplicated automatically by path,
  // but images are staged to temp-drag and would otherwise get new IDs.
  const clean = paths.filter((p) => !p.startsWith(PATHS.tempDir()))
  if (clean.length === 0) return { stacksCreated: 0 }

  const imageExts = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|jfif|pjpeg|pjp)$/i
  const imagePaths: string[] = []
  const otherPaths: string[] = []
  for (const p of clean) (imageExts.test(p) ? imagePaths : otherPaths).push(p)

  if (otherPaths.length > 0) {
    prefetchFileIcons(otherPaths)
  }

  const limit = loadSettings().historyLimit
  let stacksCreated = 0

  // --- images -> image collections (chunked to MAX_STACK) ---
  if (imagePaths.length > 0) {
    const images = []
    for (const p of imagePaths) {
      try {
        const rawBytes = readFileSync(p)
        let img = nativeImage.createFromBuffer(rawBytes)
        if (img.isEmpty()) {
          const ext = p.split('.').pop()?.toLowerCase() ?? 'png'
          const mime = ext === 'svg' ? 'image/svg+xml'
            : ext === 'gif' ? 'image/gif'
            : ext === 'webp' ? 'image/webp'
            : ext === 'bmp' ? 'image/bmp'
            : ext === 'avif' ? 'image/avif'
            : ext === 'ico' ? 'image/x-icon'
            : ext === 'jpg' || ext === 'jpeg' || ext === 'jfif' || ext === 'pjpeg' || ext === 'pjp' ? 'image/jpeg'
            : ext === 'tif' || ext === 'tiff' ? 'image/tiff'
            : 'image/png'
          const dataUrl = `data:${mime};base64,${rawBytes.toString('base64')}`
          img = nativeImage.createFromDataURL(dataUrl)
        }

        const ext = p.split('.').pop()?.toLowerCase() || 'png'
        let width = 300
        let height = 300
        if (!img.isEmpty()) {
          const size = img.getSize()
          if (size.width > 0 && size.height > 0) {
            width = size.width
            height = size.height
          }
        }

        const imageId = createId()
        store.stageImageBytes(imageId, rawBytes, ext)
        images.push({ imageId, width, height, bytes: rawBytes.length, ext })
      } catch {
        otherPaths.push(p) // unreadable -> treat as plain file
      }
    }

    for (let i = 0; i < images.length; i += MAX_STACK) {
      const chunk = images.slice(i, i + MAX_STACK)
      if (chunk.length === 1) {
        store.add({ kind: 'image', ...chunk[0] }, limit)
      } else {
        store.add({ kind: 'image-collection', images: chunk }, limit)
      }
      stacksCreated++
    }
  }

  // --- other files -> files bundles (chunked to MAX_STACK) ---
  for (let i = 0; i < otherPaths.length; i += MAX_STACK) {
    const chunk = otherPaths.slice(i, i + MAX_STACK)
    store.add({ kind: 'files', paths: chunk }, limit)
    stacksCreated++
  }

  if (stacksCreated > 0) pushState.items()
  return { stacksCreated }
}
