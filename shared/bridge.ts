/**
 * Type definition for the preload bridge API surface.
 *
 * Both the preload (implements) and renderer (consumes) import this so the
 * contract lives in one place. The actual implementation lives in the preload;
 * the renderer only ever sees `window.edge` typed as this interface.
 */
import type { Settings, Suggestion, TaskDto, TaskPatch, UnlinkTarget } from './types'
import type { DragRequest, ProviderConfig } from './types'
import type { OllamaDetectionResult, ProviderTestResult, SuggestTitleContext } from './ipc'

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
  /** Give the panel window keyboard focus (only called when an input is focused). */
  requestInputFocus: () => void

  /* Task domain */
  loadTasks: () => Promise<TaskDto[]>
  createTask: (title: string, note?: string) => Promise<TaskDto[]>
  updateTask: (id: string, patch: TaskPatch) => Promise<TaskDto[]>
  deleteTask: (id: string) => Promise<TaskDto[]>
  mergeTasks: (targetId: string, sourceId: string) => Promise<TaskDto[]>
  linkItemToTask: (taskId: string, itemId: string) => Promise<TaskDto[]>
  unlinkItemFromTask: (taskId: string, target: UnlinkTarget) => Promise<TaskDto[]>
  suggestTaskTitle: (ctx: SuggestTitleContext) => Promise<string[] | null>

  /* AI provider */
  testProvider: (config: ProviderConfig) => Promise<ProviderTestResult>
  detectOllama: (baseUrl?: string) => Promise<OllamaDetectionResult>

  /* Suggestions */
  acceptSuggestion: (id: string, titleOverride?: string) => Promise<TaskDto[]>
  ignoreSuggestion: (id: string) => Promise<void>

  /* Memory */
  loadMemories: () => Promise<import('./types').MemoryListPayload>
  actMemory: (id: string, action: import('./types').MemoryAction) => Promise<import('./types').MemoryListPayload>

  /* Main -> Renderer */
  onItems: (cb: (items: import('./types').ClipboardItemDto[]) => void) => () => void
  onTasks: (cb: (tasks: TaskDto[]) => void) => () => void
  onSettings: (cb: (settings: Settings) => void) => () => void
  onSuggestions: (cb: (suggestions: Suggestion[]) => void) => () => void
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
