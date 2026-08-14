/**
 * Single source of truth for IPC channel names and their payload contracts.
 *
 * The preload bridge is generated from these contracts so the renderer never
 * touches a raw string channel name and the main handler signatures stay in
 * sync with the renderer calls.
 *
 * Convention:
 *   - `Renderer -> Main` calls (invoke/handle) are listed in `InvokeMap`.
 *   - `Main -> Renderer` events (send/on) are listed in `EventMap`.
 */
import type { AppRef, ClipboardItemDto, DragRequest, IgnoreReason, LocalModelSource, LocalModelStatus, MemoryConflictResolution, MemoryFactPanelPayload, MemoryUserState, MergeResult, ProviderConfig, Settings, TaskProposal, TaskDto, TaskPatch, UnlinkTarget } from './types'

/** Result of a connection test against one provider (ai:test-provider). */
export interface ProviderTestResult {
  ok: boolean
  latencyMs?: number
  status?: number
  error?: string
  /** The model that was probed. */
  model?: string
  /** The probe saw reasoning_content: a thinking model. Short structured
   *  tasks auto-disable its reasoning (provider chain adapts). */
  thinkingModel?: boolean
}

/**
 * Resource attached to a task created by dropping onto a suggestion card
 * (t25): a clipboard item (linked by id, snapshotted main-side) or raw
 * file paths (deduped against the task's existing file refs).
 */
export type DropResource =
  | { kind: 'clipboard'; itemId: string }
  | { kind: 'files'; paths: string[] }

/**
 * Context for one AI title suggestion (task:suggest-title): whatever the
 * renderer knows about the task being created/edited. All fields optional;
 * main decides how much it can use.
 */
export interface SuggestTitleContext {
  title?: string
  note?: string
  appNames: string[]
  /** Short previews of linked resources (text head / file names / image summary). */
  resourcePreviews: string[]
}

/**
 * User-edited accept payload from the suggestion convert panel
 * (suggestion:accept). Omitted fields fall back to what the suggestion
 * itself carries; clipboardItemIds are snapshotted main-side.
 */
export interface SuggestionAcceptOptions {
  title?: string
  note?: string
  apps?: AppRef[]
  clipboardItemIds?: string[]
}

/* ------------------------------------------------------------------ */
/* Renderer -> Main  (ipcMain.handle / ipcRenderer.invoke)            */
/* ------------------------------------------------------------------ */

export interface InvokeMap {
  /** Returns the full current item list + settings + tasks on startup. */
  'state:load': { args: []; result: { items: ClipboardItemDto[]; settings: Settings; version: string; tasks: TaskDto[] } }

  /** Set an item's pinned state. */
  'item:set-pinned': { args: [id: string, pinned: boolean]; result: ClipboardItemDto[] }

  /** Delete a single item (and its image file if present). */
  'item:delete': { args: [id: string]; result: ClipboardItemDto[] }

  /** Delete every unpinned item. */
  'item:clear': { args: []; result: ClipboardItemDto[] }

  /** Remove a specific sub-item from a bundle. */
  'item:remove-subitem': { args: [req: DragRequest]; result: boolean }

  /** Copy an item back onto the system clipboard. */
  'item:copy': { args: [id: string]; result: boolean }

  /** Copy a single sub-item (one file of a bundle, or one image of a
   *  collection) onto the system clipboard. */
  'item:copy-subitem': { args: [req: DragRequest]; result: boolean }

  /** Copy an item and paste it directly into the active application. */
  'item:paste': { args: [id: string]; result: boolean }

  /** Copy a sub-item and paste it directly into the active application. */
  'item:paste-subitem': { args: [req: DragRequest]; result: boolean }

  /** Add local file paths dragged into the shelf. */
  'item:add-files': { args: [paths: string[]]; result: ClipboardItemDto[] }

  /** Merge an item into another. Returns why it failed (full / incompatible). */
  'item:merge': { args: [sourceId: string, targetId: string]; result: MergeResult }

  /** Split a sub-item out of a bundle into a new standalone item. */
  'item:split': { args: [req: DragRequest]; result: boolean }

  /** Update a persisted setting. */
  'settings:update': { args: [patch: Partial<Settings>]; result: Settings }

  /** Toggle whether the window is interactive (mouse-ignore). */
  'window:set-interactive': { args: [interactive: boolean]; result: void }

  /** Toggle whether the flyout preview is active (widens the window). */
  'window:set-preview-mode': { args: [active: boolean]; result: void }

  /** Minimize the window (used by Onboarding). */
  'window:minimize': { args: []; result: void }

  /** Quit the application process. */
  'app:quit': { args: []; result: void }

  /** Reveal a file in native File Explorer / Finder. */
  'file:reveal': { args: [path: string]; result: boolean }

  /** Get full release notes history from GitHub API (or cached/static fallback). */
  'app:get-releases': {
    args: []
    result: Array<{
      version: string
      date: string
      isLatest: boolean
      summary: string
      highlights: Array<{ title: string; description: string }>
    }>
  }

  /** Get the list of connected displays. */
  'displays:list': { args: []; result: import('./types').DisplayInfo[] }

  /* --------------------------- task domain --------------------------- */

  /** Load the full task list (also included in state:load). */
  'task:load': { args: []; result: TaskDto[] }

  /** Create a task (title required and non-empty). Returns the full task list. */
  'task:create': {
    args: [
      title: string,
      opts?: {
        note?: string
        /** Selected apps (AppRef identity: id/name/exePath). Deduped main-side. */
        apps?: import('./types').AppRef[]
        /** Selected clipboard items; snapshots are built main-side. */
        clipboardItemIds?: string[]
      }
    ]
    result: TaskDto[]
  }

  /** Edit title/note or apply a manual status transition. Returns the full task list. */
  'task:update': { args: [id: string, patch: TaskPatch]; result: TaskDto[] }

  /** Hard-delete a task (no recycle bin; confirmation is a UI concern). */
  'task:delete': { args: [id: string]; result: TaskDto[] }

  /** Merge source task into target (apps union + same-kind resource merge); source is deleted. */
  'task:merge': { args: [targetId: string, sourceId: string]; result: TaskDto[] }

  /** Link a clipboard item to a task; main snapshots the item content. */
  'task:link-item': { args: [taskId: string, itemId: string]; result: TaskDto[] }

  /** Link OS file paths dropped onto a task; deduped against existing file refs. */
  'task:link-files': { args: [taskId: string, paths: string[]]; result: TaskDto[] }

  /** Unlink a resource from a task (clipboard by itemId, files by exact path list). */
  'task:unlink-item': { args: [taskId: string, target: UnlinkTarget]; result: TaskDto[] }

  /**
   * Ask the provider chain for 1-3 title candidates for a task being created
   * or edited. Returns null when no provider is configured or the chain fails.
   */
  'task:suggest-title': { args: [ctx: SuggestTitleContext]; result: string[] | null }

  /**
   * Apps the task editor can select from (ADR-0002): the union of apps seen
   * by L0 window tracking (event bus) and apps that produced clipboard items
   * (sourceApp). AppRef.id follows the standard identity rule.
   */
  'task:app-options': { args: []; result: import('./types').AppRef[] }

  /**
   * Resolve Windows app icons to dataURLs, cache-first (appIconService 128
   * entry cache). Each input exePath is a key in the result; null means the
   * icon could not be extracted. On-demand only — never attached at push time.
   */
  'app:icons': { args: [exePaths: string[]]; result: Record<string, string | null> }

  /** Switch to the app's linked window (ADR-0005): pid hit → activate; app alive → its newest window; else launch exe. */
  'app:open-linked-window': { args: [app: import('./types').AppRef]; result: { ok: boolean; method: 'window' | 'launch' } }

  /* --------------------------- ai provider --------------------------- */

  /** Test a provider connection (one 1-token chat completion). */
  'ai:test-provider': { args: [config: ProviderConfig]; result: ProviderTestResult }

  /* --------------------------- local model (t54) --------------------------- */

  /** Snapshot of the local model manager (state / download progress / error / path). */
  'local-model:status': { args: []; result: LocalModelStatus }

  /**
   * Download (or resume) the auto model file. Idempotent; progress is pushed
   * on the 'local-model:status' event. Resolves when the download settles.
   */
  'local-model:start-download': { args: []; result: void }

  /** Delete the auto-downloaded model (manual paths untouched); runtime memory is released. */
  'local-model:remove': { args: []; result: LocalModelStatus }

  /** Switch the model source ('auto' | 'manual'); persisted. */
  'local-model:set-source': { args: [source: LocalModelSource]; result: LocalModelStatus }

  /** Record the user-picked .gguf path (null clears it); persisted. */
  'local-model:set-path': { args: [path: string | null]; result: LocalModelStatus }

  /** Native file dialog for a .gguf file; null when canceled. */
  'local-model:pick-path': { args: []; result: string | null }

  /* --------------------------- suggestions --------------------------- */

  /**
   * Accept a suggestion: merge into its candidate task or create a new one.
   * `opts` carries the convert panel's edits (title/note/apps/items).
   * Returns the full task list.
   */
  'suggestion:accept': { args: [id: string, opts?: SuggestionAcceptOptions]; result: TaskDto[] }

  /**
   * Accept a suggestion AND attach the dropped resource to the resulting
   * task in one main-side step. Returns the full task list.
   */
  'suggestion:accept-with-resource': { args: [id: string, titleOverride: string | undefined, resource: DropResource]; result: TaskDto[] }

  /**
   * Dismiss a suggestion; its signature suppresses the same kind later
   * (existing LRU), and the outcome + reason land in the recommendation
   * history (t46). `reason` is optional — absent = 不感兴趣.
   */
  'suggestion:ignore': { args: [id: string, reason?: IgnoreReason]; result: void }

  /* --------------------------- memory --------------------------- */

  /** List the memory panel buckets (candidates / confirmed / banned / cleanup). */
  'memory:list': { args: []; result: import('./types').MemoryListPayload }

  /**
   * One user decision on a memory (confirm/ignore/ban/unban/delete).
   * Returns the refreshed buckets so the panel stays in sync in one round-trip.
   */
  'memory:act': { args: [id: string, action: import('./types').MemoryAction]; result: import('./types').MemoryListPayload }

  /* --------------------------- memory graph panel (t51) --------------------------- */

  /** 记忆图面板全量：未失效 facts（UI 按 type 过滤分组）+ 待裁决冲突对（含内联来源链）。 */
  'memory-graph:list': { args: []; result: MemoryFactPanelPayload }

  /** 单条事实用户状态（confirm/ignore/ban，转换规则与 MemoryStore 一致）。非法转换返回 null（不刷新载荷）。 */
  'memory-graph:set-state': { args: [id: string, userState: MemoryUserState]; result: MemoryFactPanelPayload | null }

  /**
   * 冲突裁决（spec 决策 10，不自动覆盖）：保留 active / 复活 invalidated /
   * 都不保留；裁决双方落 resolved_at，待审冲突退出面板。返回刷新载荷。
   */
  'memory-graph:adjudicate': {
    args: [activeId: string, invalidatedId: string, resolution: MemoryConflictResolution]
    result: MemoryFactPanelPayload
  }

  /* --------------------------- ai rationale (trace, t42) --------------------------- */

  /** One decision chain's full trace (by decisionId), (createdAt, id) ascending. */
  'trace:list-by-decision': { args: [decisionId: string]; result: import('./types').TraceRecordDto[] }

  /** All trace rows of an adopted task (by taskId) — these live with the task. */
  'trace:list-by-task': { args: [taskId: string]; result: import('./types').TraceRecordDto[] }

  /** One trace row by id (drill-down). */
  'trace:get-by-id': { args: [id: string]; result: import('./types').TraceRecordDto | null }

  /**
   * Clear AI-rationale data: unadopted rows only (taskId IS NULL), same
   * boundary semantics as traceStore.cleanupBefore. Adopted trace lives with
   * its task and is untouched. Returns the number of deleted rows.
   */
  'trace:clear': { args: []; result: number }

  /**
   * Export the given trace chain as a standalone HTML report (spec 决策 8,
   * developer view: full chain + versions + retrieval hit paths). Shows a
   * native save dialog; returns the saved path, or null when canceled/failed.
   */
  'trace:export-report': { args: [records: import('./types').TraceRecordDto[]]; result: string | null }
}

/* ------------------------------------------------------------------ */
/* Main -> Renderer  (webContents.send / ipcRenderer.on)              */
/* ------------------------------------------------------------------ */

export interface EventMap {
  /** Full new item list whenever the history changes. */
  'state:items': [items: ClipboardItemDto[]]
  /** Full task list whenever the task domain changes. */
  'state:tasks': [tasks: TaskDto[]]
  /** Pending suggestion cards (transient, replaced on each analysis). */
  'state:suggestions': [suggestions: TaskProposal[]]
  /** Settings changed (e.g. from the tray menu). */
  'state:settings': [settings: Settings]
  /** Local model manager status changed (state / download progress / error). */
  'local-model:status': [status: LocalModelStatus]
  /** Toggle the panel open/closed from the main process (e.g. tray). */
  'window:toggle': [open?: boolean]
  /** Open the panel directly to settings from the main process (e.g. tray). */
  'window:open-settings': []
  /** Fired when an OS drag initiated by the app has completed. */
  'item:drag-end': []
  /** Internal drop triggered by the main process when startDrag ends inside the window */
  'item:internal-drop': [pos: { x: number; y: number }]
  /**
   * Transient user-facing notice (e.g. "Stack is full (10 max)"). The renderer
   * shows it as a toast; `id` lets it dedupe/dismiss.
   */
  'ui:toast': [toast: { id: string; message: string; tone: 'info' | 'error' }]
  /**
   * Main-process cursor poll signals: fired when the cursor enters/leaves
   * the screen-edge hot zone. The renderer uses this to open/close the panel
   * instead of relying on `forward:true` pointermove (which is unreliable on
   * Windows transparent windows).
   * payload: { x, y, inEdge, inZone }
   */
  'window:cursor-edge': [data: {
    x: number
    y: number
    inEdge: boolean
    inZone: boolean
    stickPosition: import('./types').StickPosition
    displayWidth: number
    displayHeight: number
  }]
  /** Alt+Tab switcher appeared (ADR-0005): renderer swaps the whole page. */
  'switcher:show': [data: { entries: import('./types').SwitcherEntryDto[]; selectedIndex: number }]
  /** Switcher highlight moved (Tab/Shift+Tab). */
  'switcher:select': [selectedIndex: number]
  /** Enter was pressed while armed (TabTab pattern): pinned open, search mode. Carries the first typed character when search was started by typing (undefined for Enter). */
  'switcher:pin': [initialQuery?: string]
  /** Control key swallowed by the hook while pinned (panel often not the OS foreground): renderer resolves drill vs execute. */
  'switcher:control-key': [key: 'enter' | 'up' | 'down']
  /** Switcher is closing (Alt released or item clicked) — restore previous state. */
  'switcher:hide': []
}

/* ------------------------------------------------------------------ */
/* Renderer -> Main  (ipcMain.on / ipcRenderer.send) — fire & forget  */
/* ------------------------------------------------------------------ */
//
// Used for time-critical, one-way gestures where the renderer must not block
// on a round-trip. The canonical example is native drag-out: Electron's
// `startDrag` only works when called synchronously from the `dragstart` event,
// so the renderer `send`s the request and main calls `event.sender.startDrag`.
export interface SendMap {
  /** Begin a native OS drag of an item (or one file of a bundle) out of the app. */
  'item:start-drag': { args: [req: DragRequest] }
  /**
   * A panel input just gained focus; main activates the panel window so
   * Chromium forwards keyboard input (window is focusable:false, so it never
   * activates on its own; only explicit input clicks steal the keyboard).
   */
  'ui:input-focus': { args: [] }
  /**
   * A panel input just lost focus; main restores WS_EX_NOACTIVATE so plain
   * clicks (cards, buttons, tabs) never activate the panel again.
   */
  'ui:input-blur': { args: [] }
  /**
   * Deterministically expand the panel without any mouse involvement
   * (testing/tray/keyboard path). Main shows the window, makes it
   * interactive, and forces the renderer open.
   */
  'panel:expand': { args: [] }
  /** Switcher mouse hover moved the highlight (ADR-0005): sync main's selection. */
  'switcher:hover': { args: [index: number] }
  /** Switcher item clicked: execute the switch immediately (ADR-0005). */
  'switcher:click': { args: [index: number] }
  /** Esc in search mode: drop the switcher session without switching. */
  'switcher:cancel': { args: [] }
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/** Typed keyof helpers so channel names can never drift. */
export const INVOKE_CHANNELS = Object.keys({} as InvokeMap) as (keyof InvokeMap)[]
export const EVENT_CHANNELS = Object.keys({} as EventMap) as (keyof EventMap)[]
export const SEND_CHANNELS = Object.keys({} as SendMap) as (keyof SendMap)[]

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap
export type SendChannel = keyof SendMap

/** Argument tuple for an invoke channel. */
export type InvokeArgs<C extends InvokeChannel> = InvokeMap[C]['args']
/** Return type for an invoke channel. */
export type InvokeResult<C extends InvokeChannel> = InvokeMap[C]['result']
/** Argument tuple for an event channel. */
export type EventArgs<C extends EventChannel> = EventMap[C]
/** Argument tuple for a fire-and-forget send channel. */
export type SendArgs<C extends SendChannel> = SendMap[C]['args']
