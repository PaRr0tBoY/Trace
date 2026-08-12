/**
 * Type definition for the preload bridge API surface.
 *
 * Both the preload (implements) and renderer (consumes) import this so the
 * contract lives in one place. The actual implementation lives in the preload;
 * the renderer only ever sees `window.edge` typed as this interface.
 */
import type { Settings, TaskProposal, TaskDto, TaskPatch, UnlinkTarget } from './types'
import type { DragRequest, ProviderConfig } from './types'
import type { ProviderTestResult, SuggestTitleContext, SuggestionAcceptOptions, DropResource } from './ipc'

export interface EdgeApi {
  /* Renderer -> Main */
  loadState: () => Promise<{ items: import('./types').ClipboardItemDto[]; settings: Settings; version: string; tasks: TaskDto[] }>
  setPinned: (id: string, pinned: boolean) => Promise<import('./types').ClipboardItemDto[]>
  deleteItem: (id: string) => Promise<import('./types').ClipboardItemDto[]>
  clearItems: () => Promise<import('./types').ClipboardItemDto[]>
  removeSubitem: (req: DragRequest) => Promise<boolean>
  copyItem: (id: string) => Promise<boolean>
  copySubitem: (req: DragRequest) => Promise<boolean>
  pasteItem: (id: string) => Promise<boolean>
  pasteSubitem: (req: DragRequest) => Promise<boolean>
  quitApp: () => Promise<void>
  /**
   * Begin a native OS drag-out. Fire-and-forget: must be called synchronously
   * from the DOM `dragstart` event, and main calls `event.sender.startDrag`.
   */
  startDrag: (req: DragRequest) => void
  addFiles: (paths: string[]) => Promise<import('./types').ClipboardItemDto[]>
  mergeItems: (sourceId: string, targetId: string) => Promise<import('./types').MergeResult>
  splitItem: (req: import('./types').DragRequest) => Promise<boolean>
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>
  setInteractive: (value: boolean) => Promise<void>
  setPreviewMode: (active: boolean) => Promise<void>
  revealFile: (path: string) => Promise<boolean>
  /** Switch to the app's linked window (ADR-0005); degrades to the app's current window, then launching the exe. */
  openLinkedWindow: (app: import('./types').AppRef) => Promise<{ ok: boolean; method: 'window' | 'launch' }>
  minimizeWindow: () => Promise<void>
  getDisplays: () => Promise<import('./types').DisplayInfo[]>
  getReleases: () => Promise<Array<{
    version: string
    date: string
    isLatest: boolean
    summary: string
    highlights: Array<{ title: string; description: string }>
  }>>
  setInternalDrag: (active: boolean) => void
  broadcastTutorialStep: (step: number) => void
  /** Activate the panel window for keyboard input (only called while an input is focused). */
  requestInputFocus: () => void
  /** Restore the panel to non-activatable after the input lost focus. */
  requestInputBlur: () => void
  /** Expand the panel deterministically (no mouse edge needed). */
  expandPanel: () => void

  /* Task domain */
  loadTasks: () => Promise<TaskDto[]>
  createTask: (
    title: string,
    opts?: { note?: string; apps?: import('./types').AppRef[]; clipboardItemIds?: string[] }
  ) => Promise<TaskDto[]>
  updateTask: (id: string, patch: TaskPatch) => Promise<TaskDto[]>
  deleteTask: (id: string) => Promise<TaskDto[]>
  mergeTasks: (targetId: string, sourceId: string) => Promise<TaskDto[]>
  linkItemToTask: (taskId: string, itemId: string) => Promise<TaskDto[]>
  linkFilesToTask: (taskId: string, paths: string[]) => Promise<TaskDto[]>
  unlinkItemFromTask: (taskId: string, target: UnlinkTarget) => Promise<TaskDto[]>
  suggestTaskTitle: (ctx: SuggestTitleContext) => Promise<string[] | null>
  /** Apps selectable in the task editor (L0-tracked ∪ clipboard sourceApps). */
  getTaskAppOptions: () => Promise<import('./types').AppRef[]>
  /** Resolve exePaths to icon dataURLs (cache-first; null = extraction failed). */
  getAppIcons: (exePaths: string[]) => Promise<Record<string, string | null>>

  /* AI provider */
  testProvider: (config: ProviderConfig) => Promise<ProviderTestResult>

  /* Suggestions */
  /** Accept a suggestion, optionally with the convert panel's edits (title/note/apps/items). */
  acceptSuggestion: (id: string, opts?: SuggestionAcceptOptions) => Promise<TaskDto[]>
  /** Accept a suggestion and attach the dragged resource (t25 drop-to-bind). */
  acceptSuggestionWithResource: (id: string, titleOverride: string | undefined, resource: DropResource) => Promise<TaskDto[]>
  ignoreSuggestion: (id: string) => Promise<void>

  /* Memory */
  loadMemories: () => Promise<import('./types').MemoryListPayload>
  actMemory: (id: string, action: import('./types').MemoryAction) => Promise<import('./types').MemoryListPayload>

  /* AI rationale (trace, t42) */
  /** One decision chain (proposal "AI 依据"): observed → … → result rows, ascending. */
  getTraceByDecision: (decisionId: string) => Promise<import('./types').TraceRecordDto[]>
  /** An adopted task's trace rows (these live with the task). */
  getTraceByTask: (taskId: string) => Promise<import('./types').TraceRecordDto[]>
  /** One trace row by id. */
  getTraceById: (id: string) => Promise<import('./types').TraceRecordDto | null>
  /** Delete unadopted AI-rationale data only; adopted trace stays with its task. Returns deleted count. */
  clearTrace: () => Promise<number>
  /** Export the given chain as an HTML report via the native save dialog; null when canceled. */
  exportTraceReport: (records: import('./types').TraceRecordDto[]) => Promise<string | null>

  /* Main -> Renderer */
  onItems: (cb: (items: import('./types').ClipboardItemDto[]) => void) => () => void
  onTasks: (cb: (tasks: TaskDto[]) => void) => () => void
  onSettings: (cb: (settings: Settings) => void) => () => void
  onSuggestions: (cb: (suggestions: TaskProposal[]) => void) => () => void
  onToggle: (cb: (open?: boolean) => void) => () => void
  onOpenSettings: (cb: () => void) => () => void
  onDragEnd: (cb: () => void) => () => void
  onInternalDrop: (cb: (pos: { x: number; y: number }) => void) => () => void
  onCursorEdge: (cb: (data: {
    x: number
    y: number
    inEdge: boolean
    inZone: boolean
    stickPosition: import('./types').StickPosition
    displayWidth: number
    displayHeight: number
  }) => void) => () => void
  onToast: (cb: (toast: { id: string; message: string; tone: 'info' | 'error' }) => void) => () => void
  onTutorialStep: (cb: (step: number) => void) => () => void
}
