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
import type { SuggestTitleContext, SuggestionAcceptOptions, DropResource } from '../../shared/ipc'
import type { ClipboardItemDto, Settings, DragRequest, TaskDto, TaskPatch, TaskProposal, MemoryAction, MemoryListPayload, MemoryConflictResolution, MemoryFactPanelPayload, MemoryUserState, AppRef, ClipboardFilter, FilesFilter, TasksFilter, View, TraceRecordDto, IgnoreReason } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'
import type { StationEntryDto } from '../../shared/station'

let flareTimer: ReturnType<typeof setTimeout> | null = null

/** A transient user-facing notice shown as a toast. */
export interface ToastMsg {
  id: string
  message: string
  tone: 'info' | 'error'
}

/** Settings sheet tabs. Lifted into the store so restore can remember/reset them (ADR-0004). */
export type SettingsTab = 'behaviour' | 'position' | 'appearance' | 'tasks' | 'privacy'

interface AppState {
  items: ClipboardItemDto[]
  /** Transfer station entries (ADR-0006): files domain, separate from the stack. */
  station: StationEntryDto[]
  tasks: TaskDto[]
  setStation: (entries: StationEntryDto[]) => void
  /* station mutations (delegate to main; authoritative list comes back) */
  stationEnter: (paths: string[]) => Promise<void>
  stationPin: (id: string, pinned: boolean) => Promise<void>
  stationDelete: (id: string) => Promise<void>
  stationCopyMember: (req: DragRequest) => Promise<void>
  stationPasteMember: (req: DragRequest) => Promise<void>
  /** Delete every stale entry (T6 cleanup banner). */
  stationClearStale: () => Promise<void>
  suggestions: TaskProposal[]
  settings: Settings
  /** True until the first `state:load` resolves. */
  hydrated: boolean
  /** Free-text search filter (UI-only state). */
  query: string
  /** Clipboard view second level (ADR-0004). */
  clipboardFilter: ClipboardFilter
  setClipboardFilter: (filter: ClipboardFilter) => void
  /** Files view second level: 'all' | 'clipboard' | 'other' | a live extension tab (ADR-0004). */
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
  /** Task id awaiting hard-delete confirmation. */
  confirmDeleteTaskId: string | null
  setConfirmDeleteTaskId: (id: string | null) => void
  /** Task whose content picker (add content) is open. */
  pickerTaskId: string | null
  setPickerTaskId: (id: string | null) => void
  /** True while an OS file drag is hovering the panel (prevents premature close). */
  dragActive: boolean
  /** Drag indicator visibility (T4b feedback): a file drag waits for the detection zone. */
  dragIndicator: boolean
  setDragIndicator: (show: boolean) => void
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
  setSuggestions: (suggestions: TaskProposal[]) => void
  setSettings: (next: Settings) => void

  /* UI */
  setQuery: (q: string) => void
  setOpen: (open: boolean) => void
  /** Alt+Tab switcher session (ADR-0005): page-swap state. */
  switcherActive: boolean
  switcherEntries: import('../../shared/types').SwitcherEntryDto[]
  switcherSelected: number
  /** Search mode (Enter while armed, TabTab pattern): panel stays up on Alt-up. */
  switcherPinned: boolean
  /** First character that started search mode by typing (type-to-search), consumed by SwitcherView. */
  switcherSeedQuery: string
  /** Latest hook-delivered control key (panel often isn't the OS foreground); consumed by SwitcherView. */
  switcherControlKey: 'enter' | 'up' | 'down' | 'left' | 'right' | null
  /** Panel open state before the switcher took over — restored on hide. */
  switcherPrevOpen: boolean
  showSwitcher: (data: { entries: import('../../shared/types').SwitcherEntryDto[]; selectedIndex: number }) => void
  setSwitcherSelected: (index: number) => void
  setSwitcherPinned: (pinned: boolean, seedQuery?: string) => void
  setSwitcherControlKey: (key: 'enter' | 'up' | 'down' | 'left' | 'right' | null) => void
  hideSwitcher: () => void
  setSettingsOpen: (open: boolean) => void
  setDragActive: (active: boolean) => void
  setInternalDragReq: (req: import('../../shared/types').DragRequest | null) => void
  setPreviewItemId: (id: string | null, rect?: { y: number; height: number }) => void
  styleFlyoutOpen: boolean
  setStyleFlyoutOpen: (open: boolean) => void
  previewFlyoutRect: { top: number; bottom: number } | null
  setPreviewFlyoutRect: (rect: { top: number; bottom: number } | null) => void
  isInternalCopying: boolean
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
  createTask: (
    title: string,
    opts?: { note?: string; apps?: AppRef[]; clipboardItemIds?: string[] }
  ) => Promise<void>
  updateTask: (id: string, patch: TaskPatch) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  linkItemToTask: (taskId: string, itemId: string) => Promise<void>
  linkFilesToTask: (taskId: string, paths: string[]) => Promise<void>
  /** Apps selectable in the task editor (L0-tracked ∪ clipboard sourceApps). */
  getTaskAppOptions: () => Promise<AppRef[]>
  /** Resolve exePaths to icon dataURLs (cache-first; null = extraction failed). */
  getAppIcons: (exePaths: string[]) => Promise<Record<string, string | null>>

  /* suggestion actions (delegate to main; pending list comes back via event) */
  acceptSuggestion: (id: string, opts?: SuggestionAcceptOptions) => Promise<void>
  /** Accept a suggestion and attach the dragged resource to the resulting task (t25). */
  acceptSuggestionWithResource: (id: string, titleOverride: string | undefined, resource: DropResource) => Promise<void>
  ignoreSuggestion: (id: string, reason?: IgnoreReason) => Promise<void>
  /** Ask the provider chain for 1-3 title candidates for a task draft (null = no AI/failure). */
  suggestTaskTitle: (ctx: SuggestTitleContext) => Promise<string[] | null>

  /* memory panel (delegate to main; the refreshed buckets come back) */
  memories: MemoryListPayload | null
  loadMemories: () => Promise<void>
  actMemory: (id: string, action: MemoryAction) => Promise<void>

  /* memory graph panel (t51; facts over the memory graph, refreshed after each decision) */
  memoryFacts: MemoryFactPanelPayload | null
  loadMemoryFacts: () => Promise<void>
  setMemoryFactState: (id: string, userState: MemoryUserState) => Promise<void>
  adjudicateMemoryConflict: (activeId: string, invalidatedId: string, resolution: MemoryConflictResolution) => Promise<void>

  /* ai rationale (trace, t42; read-only views over traceStore) */
  getTraceByDecision: (decisionId: string) => Promise<TraceRecordDto[]>
  getTraceByTask: (taskId: string) => Promise<TraceRecordDto[]>
  getTraceById: (id: string) => Promise<TraceRecordDto | null>
  clearTrace: () => Promise<number>
  exportTraceReport: (records: TraceRecordDto[]) => Promise<string | null>
}

export const useStore = create<AppState>((set, get) => ({
  items: [],
  station: [],
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
  switcherActive: false,
  switcherEntries: [],
  switcherSelected: 0,
  switcherPinned: false,
  switcherSeedQuery: '',
  switcherControlKey: null,
  switcherPrevOpen: false,
  showSwitcher: ({ entries, selectedIndex }) => {
    set({ switcherActive: true, switcherEntries: entries, switcherSelected: selectedIndex, switcherPinned: false, switcherSeedQuery: '', switcherControlKey: null, switcherPrevOpen: get().open, open: true })
  },
  setSwitcherSelected: (index) => set({ switcherSelected: index }),
  setSwitcherPinned: (pinned, seedQuery) => set({ switcherPinned: pinned, switcherSeedQuery: seedQuery ?? '' }),
  setSwitcherControlKey: (switcherControlKey) => set({ switcherControlKey }),
  hideSwitcher: () => {
    const prevOpen = get().switcherPrevOpen
    const finish = () => set({ switcherActive: false, switcherEntries: [], switcherPinned: false, switcherSeedQuery: '', switcherControlKey: null })
    if (prevOpen) {
      // Panel was already open before the session: no collapse animation,
      // switch straight back to the previous page.
      finish()
      return
    }
    // Panel was collapsed: start the collapse animation first and keep the
    // SwitcherView on screen for its duration — cutting to the clipboard page
    // mid-retract would flash the clipboard UI on the way out.
    get().setOpen(false)
    setTimeout(finish, 150)
  },
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
  confirmDeleteTaskId: null,
  setConfirmDeleteTaskId: (confirmDeleteTaskId) => set({ confirmDeleteTaskId }),
  pickerTaskId: null,
  setPickerTaskId: (pickerTaskId) => set({ pickerTaskId }),
  dragActive: false,
  dragIndicator: false,
  setDragIndicator: (dragIndicator) => set({ dragIndicator }),
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
  isInternalCopying: false,
  copyFlareActive: false,
  flareKey: 0,

  async hydrate() {
    const { items, station, settings, version, tasks } = await edge.loadState()
    set({ 
      items, 
      station, 
      settings, 
      currentVersion: version,
      tasks,
      hydrated: true
    })
    edge.onCopyFlare(() => {
      if (!get().isInternalCopying) {
        console.log('[appStore] OS copy event detected! Triggering copy flare indicator')
        get().triggerCopyFlare()
      }
    })
  },
  setStation: (station) => set({ station }),

  async stationEnter(paths) {
    set({ station: await edge.stationEnter(paths) })
  },
  async stationPin(id, pinned) {
    set({ station: await edge.stationPin(id, pinned) })
  },
  async stationDelete(id) {
    set({ station: await edge.stationDelete(id) })
  },
  async stationCopyMember(req) {
    await edge.stationCopyMember(req)
  },
  async stationPasteMember(req) {
    await edge.stationPasteMember(req)
  },
  /** Delete every stale entry (T6 cleanup banner); in-transit entries are never stale by construction. */
  async stationClearStale() {
    const staleIds = get().station.filter((e) => e.stale).map((e) => e.id)
    for (const id of staleIds) {
      await get().stationDelete(id)
    }
  },

  setItems: (items) => {
    const prevItems = get().items
    const prevTop = prevItems.length > 0 ? prevItems[0] : null
    const newTop = items.length > 0 ? items[0] : null

    if (get().hydrated && newTop) {
      const isDifferentId = !prevTop || newTop.id !== prevTop.id
      const isNewCapturedAt = prevTop && newTop.capturedAt !== prevTop.capturedAt
      if ((isDifferentId || isNewCapturedAt) && !get().isInternalCopying) {
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
    // A drag expand always lands on the transfer station view (the drop
    // surface); the restore anchor must never leak another view into a
    // drag session (user feedback 2026-08-14).
    if (s.dragActive) {
      patch.view = 'files'
      patch.filesFilter = 'all'
      patch.settingsOpen = false
      patch.settingsSubView = 'main'
      patch.query = ''
      patch.selectedTaskId = null
      patch.editingTask = null
      patch.confirmDeleteTaskId = null
      patch.pickerTaskId = null
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
      // An in-panel drag counts as an active drag: the panel must stay up
      // and the drag view locked while the item is dragged out across the
      // edge (user feedback 2026-08-14).
      set({ internalDragReq, dragActive: true })
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
    if (!get().open) {
      edge.setPreviewMode(true)
    }
    flareTimer = setTimeout(() => {
      set({ copyFlareActive: false })
      if (!get().open && !get().previewItemId && !get().styleFlyoutOpen) {
        edge.setPreviewMode(false)
      }
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
    const current = get().items
    if (items.length !== current.length || items.some((it, i) => it.id !== current[i]?.id || it.pinned !== current[i]?.pinned)) {
      set({ items })
    }
  },

  async remove(id) {
    const previousItems = get().items
    set({ items: previousItems.filter((it) => it.id !== id) })
    try {
      const items = await edge.deleteItem(id)
      set({ items })
    } catch {
      // Do not leave the UI claiming an item was deleted when the main-process
      // persistence request failed (for example during a renderer reload).
      set({ items: previousItems })
      get().pushToast({ id: `delete-${Date.now()}`, message: 'Could not delete this item. Please try again.', tone: 'error' })
    }
  },

  async clear(ids?: string[]) {
    if (!ids || ids.length === 0) {
      const previousItems = get().items
      set({ items: previousItems.filter((it) => it.pinned) })
      try {
        const items = await edge.clearItems()
        set({ items })
      } catch {
        set({ items: previousItems })
        get().pushToast({ id: `clear-${Date.now()}`, message: 'Could not clear history. Please try again.', tone: 'error' })
      }
    } else {
      const previousItems = get().items
      const idSet = new Set(ids)
      set({ items: previousItems.filter((it) => !idSet.has(it.id)) })
      try {
        const items = await edge.deleteBatchItems(ids)
        set({ items })
      } catch {
        set({ items: previousItems })
        get().pushToast({ id: `clear-${Date.now()}`, message: 'Could not clear history. Please try again.', tone: 'error' })
      }
    }
  },

  async copy(id) {
    set({ isInternalCopying: true })
    await edge.copyItem(id)
    setTimeout(() => set({ isInternalCopying: false }), 400)
  },

  async paste(id) {
    set({ isInternalCopying: true })
    await edge.pasteItem(id)
    setTimeout(() => set({ isInternalCopying: false }), 600)
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
  },

  async createTask(title, opts) {
    set({ tasks: await edge.createTask(title, opts) })
  },

  async updateTask(id, patch) {
    set({ tasks: await edge.updateTask(id, patch) })
  },

  async getTaskAppOptions() {
    return edge.getTaskAppOptions()
  },

  async getAppIcons(exePaths) {
    return edge.getAppIcons(exePaths)
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

  async acceptSuggestion(id, opts) {
    set({ tasks: await edge.acceptSuggestion(id, opts) })
  },

  async acceptSuggestionWithResource(id, titleOverride, resource) {
    set({ tasks: await edge.acceptSuggestionWithResource(id, titleOverride, resource) })
  },

  async ignoreSuggestion(id, reason) {
    await edge.ignoreSuggestion(id, reason)
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
  },

  /* memory graph panel (t51) — 每次操作主进程返回整体刷新载荷 */
  memoryFacts: null,
  async loadMemoryFacts() {
    set({ memoryFacts: await edge.loadMemoryFacts() })
  },
  async setMemoryFactState(id, userState) {
    // 非法转换主进程返回 null：不刷新载荷（行保持原状，UI 竞态时如实呈现）
    const payload = await edge.setMemoryFactState(id, userState)
    if (payload !== null) set({ memoryFacts: payload })
  },
  async adjudicateMemoryConflict(activeId, invalidatedId, resolution) {
    set({ memoryFacts: await edge.adjudicateMemoryConflict(activeId, invalidatedId, resolution) })
  },

  /* ai rationale (trace, t42) — thin views; the panel holds the loaded rows */
  async getTraceByDecision(decisionId) {
    return edge.getTraceByDecision(decisionId)
  },
  async getTraceByTask(taskId) {
    return edge.getTraceByTask(taskId)
  },
  async getTraceById(id) {
    return edge.getTraceById(id)
  },
  async clearTrace() {
    return edge.clearTrace()
  },
  async exportTraceReport(records) {
    return edge.exportTraceReport(records)
  }
}))
