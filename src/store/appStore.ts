/**
 * Renderer state store (Zustand).
 *
 * Holds the item list + settings and exposes thin actions that call the bridge
 * and update local state optimistically where it's safe. The main process is
 * always the source of truth; it pushes a fresh DTO list after every mutation,
 * so we mostly just *apply* what it sends us.
 */
import { create } from 'zustand'
import { edge } from '../lib/edge'
import { shouldRestoreToLanding } from '../lib/restore'
import type { SuggestTitleContext, DropResource } from '../../shared/ipc'
import type { ClipboardItemDto, Settings, DragRequest, TaskDto, TaskPatch, Suggestion, MemoryAction, MemoryListPayload, ClipboardFilter, FilesFilter, TasksFilter, View } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

let flareTimer: ReturnType<typeof setTimeout> | null = null

/** A transient user-facing notice shown as a toast. */
export interface ToastMsg {
  id: string
  message: string
  tone: 'info' | 'error'
}

/** Settings sheet tabs. Lifted into the store so restore can remember/reset them (ADR-0004). */
export type SettingsTab = 'behaviour' | 'position' | 'appearance' | 'tasks'

interface AppState {
  items: ClipboardItemDto[]
  tasks: TaskDto[]
  suggestions: Suggestion[]
  settings: Settings
  /** True until the first `state:load` resolves. */
  hydrated: boolean
  /** Free-text search filter (UI-only state). */
  query: string
  /** Clipboard view second level (ADR-0004). */
  clipboardFilter: ClipboardFilter
  setClipboardFilter: (filter: ClipboardFilter) => void
  /** Files view second level: 'all' | 'other' | a live extension tab (ADR-0004). */
  filesFilter: FilesFilter
  setFilesFilter: (filter: FilesFilter) => void
  /** Tasks view second level (ADR-0004). */
  tasksFilter: TasksFilter
  setTasksFilter: (filter: TasksFilter) => void
  /** Whether the panel blade is expanded. */
  open: boolean
  /** Dev/debug: keep the panel open against hover auto-close (CDP-driven UI work). */
  debugHoldOpen: boolean
  setDebugHoldOpen: (hold: boolean) => void
  /** Settings sheet visibility. */
  settingsOpen: boolean
  /** Active panel layer (ADR-0004). */
  view: View
  setView: (view: View) => void
  /** Active settings sheet tab (lifted from Settings.tsx so restore can remember it). */
  settingsTab: SettingsTab
  setSettingsTab: (tab: SettingsTab) => void
  /** Active view mode within settings ('main' | 'changelog'). */
  settingsSubView: 'main' | 'changelog'
  setSettingsSubView: (subView: 'main' | 'changelog') => void
  /**
   * Timestamp of the last panel close (ADR-0004 restore anchor); 0 until the
   * panel has ever been closed.
   */
  lastClosedAt: number
  /**
   * Bumped every time the restore mechanism applies the landing page;
   * components may react to it for defensive resets.
   */
  restoreEpoch: number
  /** Task detail open in the task layer (null = list). Store-visible so restore can reset it. */
  selectedTaskId: string | null
  setSelectedTaskId: (id: string | null) => void
  /** 'new' = create form; a task id = edit form; null = no form (ADR-0004 edit protection). */
  editingTask: string | 'new' | null
  setEditingTask: (editing: string | 'new' | null) => void
  /** Suggestion id whose inline title editor is active (ADR-0004 edit protection). */
  editingSuggestionId: string | null
  setEditingSuggestionId: (id: string | null) => void
  /** Task id awaiting hard-delete confirmation. */
  confirmDeleteTaskId: string | null
  setConfirmDeleteTaskId: (id: string | null) => void
  /** Task whose content picker (add content) is open. */
  pickerTaskId: string | null
  setPickerTaskId: (id: string | null) => void
  /** True while an OS file drag is hovering the panel (prevents premature close). */
  dragActive: boolean
  /** True if the active drag originated from within the app itself. Stores the drag request (which item/sub-item). */
  internalDragReq: import('../../shared/types').DragRequest | null
  /** Active toasts (auto-dismissed after a short delay). */
  toasts: ToastMsg[]
  tutorialStep: number
  currentVersion: string
  /** Item ID currently being previewed in the flyout. */
  previewItemId: string | null
  previewItemRect: { y: number; height: number } | null

  sliderActive: boolean
  sliderReleasedTime: number
  setSliderActive: (active: boolean) => void
  notifyPositionChanged: () => void
  resetPositionChangedTime: () => void
  edgeHintActive: boolean
  setEdgeHintActive: (active: boolean) => void

  /* hydration + sync */
  hydrate: () => Promise<void>
  setItems: (items: ClipboardItemDto[]) => void
  setTasks: (tasks: TaskDto[]) => void
  setSuggestions: (suggestions: Suggestion[]) => void
  setSettings: (next: Settings) => void

  /* UI */
  setQuery: (q: string) => void
  setOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setDragActive: (active: boolean) => void
  setInternalDragReq: (req: import('../../shared/types').DragRequest | null) => void
  setPreviewItemId: (id: string | null, rect?: { y: number; height: number }) => void
  styleFlyoutOpen: boolean
  setStyleFlyoutOpen: (open: boolean) => void
  previewFlyoutRect: { top: number; bottom: number } | null
  setPreviewFlyoutRect: (rect: { top: number; bottom: number } | null) => void
  copyFlareActive: boolean
  flareKey: number
  triggerCopyFlare: () => void

  /* toasts */
  pushToast: (toast: ToastMsg) => void
  dismissToast: (id: string) => void

  /* mutations (delegate to main) */
  togglePin: (id: string, pinned: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  clear: (ids?: string[]) => Promise<void>
  copy: (id: string) => Promise<void>
  paste: (id: string) => Promise<void>
  pasteSubitem: (req: DragRequest) => Promise<void>
  patchSettings: (patch: Partial<Settings>) => Promise<void>
  setTutorialStep: (step: number) => void

  /* task mutations (delegate to main; authoritative list comes back) */
  createTask: (title: string, note?: string) => Promise<void>
  updateTask: (id: string, patch: TaskPatch) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  linkItemToTask: (taskId: string, itemId: string) => Promise<void>
  linkFilesToTask: (taskId: string, paths: string[]) => Promise<void>

  /* suggestion actions (delegate to main; pending list comes back via event) */
  acceptSuggestion: (id: string, titleOverride?: string) => Promise<void>
  /** Accept a suggestion and attach the dragged resource to the resulting task (t25). */
  acceptSuggestionWithResource: (id: string, titleOverride: string | undefined, resource: DropResource) => Promise<void>
  ignoreSuggestion: (id: string) => Promise<void>
  /** Ask the provider chain for 1-3 title candidates for a task draft (null = no AI/failure). */
  suggestTaskTitle: (ctx: SuggestTitleContext) => Promise<string[] | null>

  /* memory panel (delegate to main; the refreshed buckets come back) */
  memories: MemoryListPayload | null
  loadMemories: () => Promise<void>
  actMemory: (id: string, action: MemoryAction) => Promise<void>
}

export const useStore = create<AppState>((set, get) => ({
  items: [],
  tasks: [],
  suggestions: [],
  settings: { ...DEFAULT_SETTINGS },
  hydrated: false,
  query: '',
  clipboardFilter: 'all',
  setClipboardFilter: (clipboardFilter) => set({ clipboardFilter }),
  filesFilter: 'all',
  setFilesFilter: (filesFilter) => set({ filesFilter }),
  tasksFilter: 'existing',
  setTasksFilter: (tasksFilter) => set({ tasksFilter }),
  open: false,
  debugHoldOpen: false,
  setDebugHoldOpen: (debugHoldOpen) => set({ debugHoldOpen }),
  settingsOpen: false,
  view: 'clipboard',
  setView: (view) => set({ view }),
  settingsTab: 'behaviour',
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  settingsSubView: 'main',
  setSettingsSubView: (subView) => set({ settingsSubView: subView }),
  lastClosedAt: 0,
  restoreEpoch: 0,
  selectedTaskId: null,
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
  editingTask: null,
  setEditingTask: (editingTask) => set({ editingTask }),
  editingSuggestionId: null,
  setEditingSuggestionId: (editingSuggestionId) => set({ editingSuggestionId }),
  confirmDeleteTaskId: null,
  setConfirmDeleteTaskId: (confirmDeleteTaskId) => set({ confirmDeleteTaskId }),
  pickerTaskId: null,
  setPickerTaskId: (pickerTaskId) => set({ pickerTaskId }),
  dragActive: false,
  internalDragReq: null,
  toasts: [],
  tutorialStep: 0,
  currentVersion: '',
  previewItemId: null,
  previewItemRect: null,
  sliderActive: false,
  sliderReleasedTime: 0,
  setSliderActive: (active) => set({
    sliderActive: active,
    sliderReleasedTime: active ? 0 : Date.now()
  }),
  notifyPositionChanged: () => set({ sliderReleasedTime: Date.now() }),
  resetPositionChangedTime: () => set({ sliderReleasedTime: 0 }),
  edgeHintActive: false,
  setEdgeHintActive: (active) => set({ edgeHintActive: active }),
  styleFlyoutOpen: false,
  setStyleFlyoutOpen: (open) => {
    set({ styleFlyoutOpen: open, ...(open ? {} : { previewFlyoutRect: null }) })
    if (open) {
      edge.setPreviewMode(true)
    }
    // NOTE: Do NOT call edge.setPreviewMode(false) here when closing.
    // If we do, Electron immediately shrinks the window, cutting the flyout exit
    // spring in half (the 25%/75% split the user sees). Instead, IndicatorStyleFlyout's
    // AnimatePresence.onExitComplete callback is the one that calls setPreviewMode(false)
    // after the exit animation has fully settled.
  },
  copyFlareActive: false,
  flareKey: 0,

  async hydrate() {
    const { items, settings, version, tasks } = await edge.loadState()
    set({ 
      items, 
      settings, 
      currentVersion: version,
      tasks,
      hydrated: true
    })
  },

  setItems: (items) => {
    const prevItems = get().items
    const prevTop = prevItems.length > 0 ? prevItems[0] : null
    const newTop = items.length > 0 ? items[0] : null

    if (get().hydrated && prevTop && newTop) {
      if (
        newTop.id !== prevTop.id ||
        newTop.capturedAt !== prevTop.capturedAt ||
        newTop.hitCount !== prevTop.hitCount
      ) {
        console.log('[appStore] Top item copied or re-copied! Triggering sine-curve copy flare for:', newTop.id)
        get().triggerCopyFlare()
      }
    }
    set({ items })
  },
  setTasks: (tasks) => set({ tasks }),
  setSuggestions: (suggestions) => set({ suggestions }),
  setSettings: (next) => set({ settings: next }),

  setQuery: (query) => set({ query }),
  setOpen: (open) => {
    const s = get()
    if (!open) {
      // Restore anchor (ADR-0004): the moment the panel collapses.
      set({ open, lastClosedAt: Date.now(), previewItemId: null, previewItemRect: null })
      edge.setPreviewMode(false)
      return
    }
    const patch: Partial<AppState> = { open: true }
    // Already open (e.g. tray "Open Settings"): this is not a close→open
    // transition, so the restore anchor semantics (ADR-0004) don't apply.
    if (s.open) {
      set(patch)
      return
    }
    if (shouldRestoreToLanding(s)) {
      const landing = s.settings.landing ?? DEFAULT_SETTINGS.landing
      patch.view = landing.view
      if (landing.view === 'clipboard') patch.clipboardFilter = landing.filter
      if (landing.view === 'tasks') patch.tasksFilter = landing.filter
      patch.filesFilter = 'all'
      patch.settingsOpen = false
      patch.settingsSubView = 'main'
      patch.query = ''
      patch.selectedTaskId = null
      patch.editingTask = null
      patch.confirmDeleteTaskId = null
      patch.pickerTaskId = null
      patch.restoreEpoch = s.restoreEpoch + 1
    }
    set(patch)
  },
  setSettingsOpen: (settingsOpen) => {
    set({
      settingsOpen,
      ...(settingsOpen
        ? {
            // Opening always starts at the main settings page; closing keeps
            // the sub view so the restore mechanism can remember it (ADR-0004).
            settingsSubView: 'main',
            previewItemId: null,
            previewItemRect: null,
            previewFlyoutRect: null,
            styleFlyoutOpen: false
          }
        : {})
    })
  },
  setDragActive: (dragActive) => set({ dragActive }),
  setInternalDragReq: (internalDragReq) => {
    if (internalDragReq === null) {
      set({ internalDragReq: null, dragActive: false })
    } else {
      set({ internalDragReq })
    }
    edge.setInternalDrag(!!internalDragReq)
  },
  previewFlyoutRect: null,
  setPreviewFlyoutRect: (rect) => set({ previewFlyoutRect: rect }),
  setPreviewItemId: (id, rect) => {
    set({ previewItemId: id, previewItemRect: rect || null, ...(id ? {} : { previewFlyoutRect: null }) })
    if (id) {
      edge.setPreviewMode(true)
    }
  },
  triggerCopyFlare: () => {
    if (get().settings.showCopyIndicator === false) return
    if (flareTimer) clearTimeout(flareTimer)
    set({ copyFlareActive: true, flareKey: Date.now() })
    flareTimer = setTimeout(() => {
      set({ copyFlareActive: false })
      flareTimer = null
    }, 1400)
  },

  pushToast: (toast) => {
    set({ toasts: [...get().toasts, toast] })
    // Auto-dismiss after 2.6s. Errors linger slightly longer for readability.
    const ttl = toast.tone === 'error' ? 3400 : 2600
    setTimeout(() => get().dismissToast(toast.id), ttl)
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },

  async togglePin(id, pinned) {
    // Optimistic: flip locally, then let the pushed list confirm.
    set({
      items: get().items.map((it) => (it.id === id ? { ...it, pinned } : it))
    })
    const items = await edge.setPinned(id, pinned)
    set({ items })
  },

  async remove(id) {
    set({ items: get().items.filter((it) => it.id !== id) })
    const items = await edge.deleteItem(id)
    set({ items })
  },

  async clear(ids?: string[]) {
    if (!ids || ids.length === 0) {
      const items = await edge.clearItems()
      set({ items })
    } else {
      const idSet = new Set(ids)
      set({ items: get().items.filter((it) => !idSet.has(it.id)) })
      let items = get().items
      for (const id of ids) {
        items = await edge.deleteItem(id)
      }
      set({ items })
    }
  },

  async copy(id) {
    await edge.copyItem(id)
  },

  async paste(id) {
    await edge.pasteItem(id)
  },

  async pasteSubitem(req) {
    await edge.pasteSubitem(req)
  },

  async patchSettings(patch) {
    const next = await edge.updateSettings(patch)
    set({ settings: next })
  },

  setTutorialStep: (step) => {
    set({
      tutorialStep: step,
      // ADR-0004: the files card lives in the files view — step 4 of the
      // onboarding tutorial points at it, so flip the view when it starts.
      ...(step === 4 ? { view: 'files' } : {})
    })
    edge.broadcastTutorialStep(step)
  },

  async createTask(title, note) {
    set({ tasks: await edge.createTask(title, note) })
  },

  async updateTask(id, patch) {
    set({ tasks: await edge.updateTask(id, patch) })
  },

  async deleteTask(id) {
    set({ tasks: await edge.deleteTask(id) })
  },

  async linkItemToTask(taskId, itemId) {
    set({ tasks: await edge.linkItemToTask(taskId, itemId) })
  },

  async linkFilesToTask(taskId, paths) {
    set({ tasks: await edge.linkFilesToTask(taskId, paths) })
  },

  async acceptSuggestion(id, titleOverride) {
    set({ tasks: await edge.acceptSuggestion(id, titleOverride) })
  },

  async acceptSuggestionWithResource(id, titleOverride, resource) {
    set({ tasks: await edge.acceptSuggestionWithResource(id, titleOverride, resource) })
  },

  async ignoreSuggestion(id) {
    await edge.ignoreSuggestion(id)
  },

  async suggestTaskTitle(ctx) {
    return edge.suggestTaskTitle(ctx)
  },

  memories: null,
  async loadMemories() {
    set({ memories: await edge.loadMemories() })
  },
  async actMemory(id, action) {
    set({ memories: await edge.actMemory(id, action) })
  }
}))
