/**
 * Preload bridge: the only surface the renderer has onto Electron.
 *
 * Everything is built from the typed contracts in `shared/ipc.ts`, so the
 * renderer gets a fully typed `window.edge` API and never touches a raw channel
 * name. contextIsolation keeps this isolated from page globals; nodeIntegration
 * stays off, so the renderer has no Node access at all.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  EventChannel,
  EventArgs,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  SendArgs,
  SendChannel,
  SuggestTitleContext
} from '../../shared/ipc'
import type { EdgeApi } from '../../shared/bridge'
import type { DragRequest } from '../../shared/types'
import type { StationContentInput } from '../../shared/station'

/** Typed invoke wrapper derived from the shared contracts. */
function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResult<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<InvokeResult<C>>
}

/**
 * Typed fire-and-forget send. Used for gestures that the renderer must not
 * await — notably native drag-out, where main needs `event.sender.startDrag`
 * called synchronously relative to the DOM dragstart.
 */
function send<C extends SendChannel>(channel: C, ...args: SendArgs<C>): void {
  ipcRenderer.send(channel, ...args)
}

/** Typed event subscriber. Returns an unsubscribe function. */
function on<C extends EventChannel>(
  channel: C,
  listener: (...args: EventArgs<C>) => void
): () => void {
  const wrapped = (_e: IpcRendererEvent, ...args: EventArgs<C>) => listener(...args)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.off(channel, wrapped)
}

/**
 * Intercept drag-and-drop globally in the preload script.
 * By running in the capturing phase, we intercept the drop before React.
 * This is required because passing DragEvent or File objects across the
 * contextBridge strips their internal C++ backing, causing webUtils.getPathForFile
 * to fail. Handling it here natively bypasses the bridge entirely.
 */
let internalDrag = false

const win: any = (globalThis as any).window || globalThis

win.addEventListener('dragover', (e: any) => {
  e.preventDefault()
}, false)

/**
 * OS file drops: resolve paths here (File objects die at the bridge), then
 * hand them to the renderer as a `trace-os-drop` event so Panel can pick the
 * drop target (save zone / task row / suggestion card) and act accordingly.
 * The renderer never sees the File objects, so target resolution must happen
 * against the coordinates captured at drop time.
 */
win.addEventListener('drop', (e: any) => {
  if (internalDrag) {
    e.preventDefault()
    return
  }

  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    const paths: string[] = []
    for (let i = 0; i < files.length; i++) {
      try {
        const p = webUtils.getPathForFile(files[i])
        if (p) paths.push(p)
      } catch {
        /* ignore unreadable entries */
      }
    }

    if (paths.length > 0) {
      e.preventDefault()
      // Renderer's Panel claims the drop synchronously (shared-DOM attribute,
      // visible across worlds) by resolving the target from these coordinates.
      // Windows without a Panel listener (e.g. onboarding) must not swallow
      // the drop: fall back to the plain save-to-shelf path.
      const docEl = win.document?.documentElement
      if (docEl) docEl.removeAttribute('data-trace-drop-claimed')
      win.dispatchEvent(new CustomEvent('trace-os-drop', {
        detail: { paths, x: e.clientX, y: e.clientY }
      }))
      if (docEl && !docEl.hasAttribute('data-trace-drop-claimed')) {
        invoke('station:enter', paths).catch(console.error)
      }
      return
    }
  }

  // Non-file content drops (T7): image data (a File without a disk path, e.g.
  // an image dragged out of a web page) and plain text (selected text). These
  // are staged as real files in main and enter the station like any other
  // path. The drop must be claimed either way, or the browser would navigate
  // to text/uri-list content on an unclaimed drop.
  void handleContentDrop(e)
}, true)

/**
 * Read non-file drag content (image items + plain text + dragged links) and
 * hand it to main as `station:enter-content`. When the drop carries File
 * objects at all, only image items are considered — text/plain of a virtual
 * file is not reliable content, and the window must never navigate on a drop
 * it did not claim.
 */
async function handleContentDrop(e: any): Promise<void> {
  const dt = e.dataTransfer
  if (!dt) return
  // Any drop that reaches this point must be claimed: an unclaimed drop with
  // text/uri-list content (e.g. a dragged link) navigates the window away.
  e.preventDefault()

  let text = ''
  let imageUrl = ''
  try {
    // A drop that carries File objects at all is treated as files-only:
    // text/plain of a virtual file is not reliable content.
    const hasFiles = dt.files && dt.files.length > 0
    if (!hasFiles) {
      text = dt.getData('text/plain')
      // Some apps publish a dragged link only as text/uri-list (no
      // text/plain). Image URLs are downloaded by main; everything else
      // enters the station as text so the link never vanishes.
      const uriList = dt.getData('text/uri-list') || dt.getData('URL')
      if (!text && uriList) {
        const firstUrl = uriList
          .split(/\r?\n/)
          .map((u: string) => u.trim())
          .find((u: string) => u && !u.startsWith('#'))
        if (firstUrl) {
          if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?.*)?$/i.test(firstUrl) || /^data:image\//i.test(firstUrl)) {
            imageUrl = firstUrl
          } else {
            text = firstUrl
          }
        }
      }
    }
  } catch {
    /* dataTransfer access can throw for cross-app drags */
  }

  const imageItems: File[] = []
  for (let i = 0; i < (dt.items?.length ?? 0); i++) {
    const item = dt.items[i]
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) imageItems.push(f)
    }
  }

  if (!text && imageItems.length === 0 && !imageUrl) return

  const input: StationContentInput = {}
  if (text) input.text = text
  if (imageUrl) input.imageUrl = imageUrl
  for (const f of imageItems) {
    try {
      const buf = await f.arrayBuffer()
      input.images = input.images ?? []
      input.images.push({ data: new Uint8Array(buf), mime: f.type || 'application/octet-stream' })
    } catch {
      /* unreadable content item — skip */
    }
  }
  if (!input.text && !input.images && !input.imageUrl) return
  invoke('station:enter-content', input).catch((err) => console.error('[Preload] station:enter-content failed', err))
}

const api = {
  /* Renderer -> Main */
  loadState: () => invoke('state:load'),
  setPinned: (id: string, pinned: boolean) => invoke('item:set-pinned', id, pinned),
  deleteItem: (id: string) => invoke('item:delete', id),
  deleteBatchItems: (ids: string[]) => invoke('item:delete-batch', ids),
  clearItems: () => invoke('item:clear'),
  getFullText: (id: string) => invoke('item:get-full-text', id),
  copyItem: (id: string) => invoke('item:copy', id),
  copySubitem: (req: import('../../shared/types').DragRequest) => invoke('item:copy-subitem', req),
  pasteItem: (id: string) => invoke('item:paste', id),
  pasteSubitem: (req: import('../../shared/types').DragRequest) => invoke('item:paste-subitem', req),
  quitApp: () => invoke('app:quit'),
  /* Auto-update (GitHub releases) */
  checkForUpdatesManual: () => invoke('updater:check-manual'),
  startUpdateDownload: () => invoke('updater:start-download'),
  installUpdate: () => invoke('app:install-update'),
  startDrag: (req: DragRequest) => send('item:start-drag', req),

  removeSubitem: (req: import('../../shared/types').DragRequest) => invoke('item:remove-subitem', req),

  /* Transfer station (ADR-0006) */
  stationList: () => invoke('station:list'),
  stationEnter: (paths: string[]) => invoke('station:enter', paths),
  stationEnterContent: (input: StationContentInput) => invoke('station:enter-content', input),
  stationPin: (id: string, pinned: boolean) => invoke('station:pin', id, pinned),
  stationDelete: (id: string) => invoke('station:delete', id),
  stationCopyMember: (req: import('../../shared/types').DragRequest) => invoke('station:copy-member', req),
  stationPasteMember: (req: import('../../shared/types').DragRequest) => invoke('station:paste-member', req),
  getDisplays: () => invoke('displays:list'),
  getReleases: () => invoke('app:get-releases'),
  updateSettings: (patch: Partial<InvokeResult<'settings:update'>>) =>
    invoke('settings:update', patch),
  setInteractive: (value: boolean) => invoke('window:set-interactive', value),
  setPreviewMode: (active: boolean) => invoke('window:set-preview-mode', active),
  revealFile: (path: string) => invoke('file:reveal', path),
  openLinkedWindow: (app: import('../../shared/types').AppRef) => invoke('app:open-linked-window', app),
  minimizeWindow: () => invoke('window:minimize'),
  setInternalDrag: (active: boolean) => { internalDrag = active },
  requestInputFocus: () => send('ui:input-focus'),
  requestInputBlur: () => send('ui:input-blur'),
  expandPanel: () => send('panel:expand'),
  switcherHover: (index: number) => send('switcher:hover', index),
  switcherClick: (index: number) => send('switcher:click', index),
  switcherCancel: () => send('switcher:cancel'),

  /* Task domain */
  loadTasks: () => invoke('task:load'),
  createTask: (title: string, opts?: { note?: string; apps?: import('../../shared/types').AppRef[]; clipboardItemIds?: string[] }) =>
    invoke('task:create', title, opts),
  updateTask: (id: string, patch: import('../../shared/types').TaskPatch) => invoke('task:update', id, patch),
  deleteTask: (id: string) => invoke('task:delete', id),
  mergeTasks: (targetId: string, sourceId: string) => invoke('task:merge', targetId, sourceId),
  linkItemToTask: (taskId: string, itemId: string) => invoke('task:link-item', taskId, itemId),
  linkFilesToTask: (taskId: string, paths: string[]) => invoke('task:link-files', taskId, paths),
  unlinkItemFromTask: (taskId: string, target: import('../../shared/types').UnlinkTarget) => invoke('task:unlink-item', taskId, target),
  suggestTaskTitle: (ctx: SuggestTitleContext) => invoke('task:suggest-title', ctx),
  getTaskAppOptions: () => invoke('task:app-options'),
  getAppIcons: (exePaths: string[]) => invoke('app:icons', exePaths),

  /* Notes domain */
  loadNotes: () => invoke('note:load'),
  createNote: (content?: string) => invoke('note:create', content),
  updateNote: (id: string, patch: import('../../shared/types').NotePatch) => invoke('note:update', id, patch),
  deleteNote: (id: string) => invoke('note:delete', id),
  clearAllNotes: () => invoke('note:clearAll'),

  /* AI provider */
  testProvider: (config: import('../../shared/types').ProviderConfig) => invoke('ai:test-provider', config),

  /* Local model (t54) */
  getLocalModelStatus: () => invoke('local-model:status'),
  startLocalModelDownload: () => invoke('local-model:start-download'),
  removeLocalModel: () => invoke('local-model:remove'),
  setLocalModelSource: (source: import('../../shared/types').LocalModelSource) => invoke('local-model:set-source', source),
  setLocalModelPath: (path: string | null) => invoke('local-model:set-path', path),
  pickLocalModelPath: () => invoke('local-model:pick-path'),

  /* Suggestions */
  acceptSuggestion: (id: string, opts?: import('../../shared/ipc').SuggestionAcceptOptions) => invoke('suggestion:accept', id, opts),
  acceptSuggestionWithResource: (id: string, titleOverride: string | undefined, resource: import('../../shared/ipc').DropResource) =>
    invoke('suggestion:accept-with-resource', id, titleOverride, resource),
  ignoreSuggestion: (id: string, reason?: import('../../shared/types').IgnoreReason) => invoke('suggestion:ignore', id, reason),

  /* Memory */
  loadMemories: () => invoke('memory:list'),
  actMemory: (id: string, action: import('../../shared/types').MemoryAction) => invoke('memory:act', id, action),

  /* Memory graph panel (t51) */
  loadMemoryFacts: () => invoke('memory-graph:list'),
  setMemoryFactState: (id: string, userState: import('../../shared/types').MemoryUserState) => invoke('memory-graph:set-state', id, userState),
  adjudicateMemoryConflict: (activeId: string, invalidatedId: string, resolution: import('../../shared/types').MemoryConflictResolution) =>
    invoke('memory-graph:adjudicate', activeId, invalidatedId, resolution),

  /* AI rationale (trace, t42) */
  getTraceByDecision: (decisionId: string) => invoke('trace:list-by-decision', decisionId),
  getTraceByTask: (taskId: string) => invoke('trace:list-by-task', taskId),
  getTraceById: (id: string) => invoke('trace:get-by-id', id),
  clearTrace: () => invoke('trace:clear'),
  exportTraceReport: (records: import('../../shared/types').TraceRecordDto[]) => invoke('trace:export-report', records),

  /* Main -> Renderer */
  onItems: (cb: (items: EventArgs<'state:items'>[0]) => void) => on('state:items', cb),
  onStation: (cb: (entries: EventArgs<'state:station'>[0]) => void) => on('state:station', cb),
  onTasks: (cb: (tasks: EventArgs<'state:tasks'>[0]) => void) => on('state:tasks', cb),
  onNotes: (cb: (notes: EventArgs<'state:notes'>[0]) => void) => on('state:notes', cb),
  onSuggestions: (cb: (suggestions: EventArgs<'state:suggestions'>[0]) => void) => on('state:suggestions', cb),
  onSettings: (cb: (settings: EventArgs<'state:settings'>[0]) => void) => on('state:settings', cb),
  onLocalModelStatus: (cb: (status: EventArgs<'local-model:status'>[0]) => void) => on('local-model:status', cb),
  onToggle: (cb: (open?: boolean) => void) => on('window:toggle', cb),
  onDragActive: (cb: (active: boolean) => void) => on('drag:active', cb),
  onDragIndicator: (cb: (show: boolean) => void) => on('drag:indicator', cb),
  onOpenSettings: (cb: () => void) => on('window:open-settings', cb),
  onDragEnd: (cb: () => void) => on('item:drag-end', cb),
  onInternalDrop: (cb: (pos: { x: number; y: number }) => void) => on('item:internal-drop', cb),
  onCursorEdge: (cb: (data: EventArgs<'window:cursor-edge'>[0]) => void) => on('window:cursor-edge', cb),
  onToast: (cb: (toast: { id: string; message: string; tone: 'info' | 'error' }) => void) => on('ui:toast', cb),
  onCopyFlare: (cb: () => void) => on('ui:copy-flare', cb),
  onSmartExternalActivity: (cb: (kind: EventArgs<'smart:external-activity'>[0]) => void) => on('smart:external-activity', cb),
  onUpdateAvailable: (cb: (info: { version: string }) => void) => on('app:update-available', cb),
  onUpdateDownloaded: (cb: (info: { version: string }) => void) => on('app:update-downloaded', cb),
  onSwitcherShow: (cb: (data: EventArgs<'switcher:show'>[0]) => void) => on('switcher:show', cb),
  onSwitcherSelect: (cb: (index: number) => void) => on('switcher:select', cb),
  onSwitcherPin: (cb: (initialQuery?: string) => void) => on('switcher:pin', cb),
  onSwitcherControlKey: (cb: (key: 'enter' | 'up' | 'down' | 'left' | 'right') => void) => on('switcher:control-key', cb),
  onSwitcherHide: (cb: () => void) => on('switcher:hide', cb),

  /* Drag helpers */
  // (Handled natively by capturing drop event above)
}

// Validate that our implementation matches the shared contract.
const _bridge: EdgeApi = api
void _bridge

contextBridge.exposeInMainWorld('edge', api)
