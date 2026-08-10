/**
 * Shared domain types used by both the Electron main process and the renderer.
 *
 * Items are serialized in two places:
 *   - the on-disk index (JSON in userData)
 *   - the IPC payloads sent to the renderer
 * Images are stored as separate PNG files referenced by `imageId`, while the
 * renderer receives the bytes inline as a data URL so the UI never blocks on disk I/O.
 */

/** Maximum number of sub-items that may live in a single stack/bundle. */
export const MAX_STACK = 10

/** Discriminated union describing the payload of a clipboard item. */
export type ItemData =
  | { kind: 'text'; text: string; html?: string; isUrl: boolean; isColor?: boolean }
  | { kind: 'image'; imageId: string; width: number; height: number; bytes: number; ext?: string }
  | { kind: 'image-collection'; images: { imageId: string; width: number; height: number; bytes: number; ext?: string }[] }
  | { kind: 'files'; paths: string[] }

export type ItemKind = ItemData['kind']

export type TypeFilter = 'all' | 'text' | 'links' | 'images' | 'files'

/**
 * A single clipboard entry. `id` is stable across the lifetime of the entry;
 * it is used as the React key and the storage key for pinned/persisted items.
 */
export interface ClipboardItem {
  id: string
  data: ItemData
  /** Unix epoch ms of the moment the item was captured. */
  capturedAt: number
  /** Number of times this exact content has been captured. */
  hitCount: number
  /** Pinned items never scroll off and survive app restarts. */
  pinned: boolean
}

/**
 * Display metadata for a single file inside a `files` bundle.
 * Computed by main from the path/extension + a stat() call; the internal
 * `ItemData.files` model stays a plain path list so drag/merge/split logic
 * is untouched, while the renderer gets what it needs to render richly.
 */
export interface FileEntry {
  name: string
  ext: string
  size: number
  isImage: boolean
  preview?: string
}

/** Payload sent over IPC: same as ClipboardItem but with inline image previews. */
export interface ClipboardItemDto extends Omit<ClipboardItem, 'data'> {
  data:
  | { kind: 'text'; text: string; html?: string; isUrl: boolean; isColor?: boolean }
  | { kind: 'image'; imageId: string; width: number; height: number; bytes: number; preview: string; ext?: string }
  | { kind: 'image-collection'; images: { imageId: string; width: number; height: number; bytes: number; preview: string; ext?: string }[] }
  | { kind: 'files'; paths: string[]; previews?: string[]; entries?: FileEntry[] }
}

/** Section the renderer groups items into. */
export type ItemSection = 'pinned' | 'shelf'

export type StickPosition = 'left' | 'right'

export interface DisplayInfo {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  isPrimary: boolean
  isCurrent?: boolean
  label: string
  name: string
  resolution: string
}

/**
 * Request to begin a native OS drag-out of one item.
 *
 * `id` always identifies the source item. `paths` is an optional override that
 * narrows a `files` bundle to a single path (used when dragging one file out of
 * an expanded bundle). When omitted, main uses all of the item's content.
 */
export interface DragRequest {
  id: string
  paths?: string[]
  imageId?: string
  splitPlacement?: 'before' | 'after'
}

/**
 * Outcome of a merge attempt. `reason` tells the renderer *why* it failed so it
 * can show a precise message (e.g. "collection full" vs "can't mix types").
 */
export interface MergeResult {
  ok: boolean
  reason?: 'full' | 'incompatible' | 'notfound'
  message?: string
}

/* ------------------------------------------------------------------ */
/* Task domain (t11)                                                    */
/* ------------------------------------------------------------------ */

/** Lifecycle of a task. Only 'active' ↔ 'paused' is rule-driven; the rest is manual. */
export type TaskStatus = 'active' | 'paused' | 'waiting' | 'completed'

/**
 * An application a task is associated with.
 * `id` is the identity key: lowercase-normalized exePath, or the process name
 * when no exePath is known. `lastContext` is the latest L0 capture landing spot.
 */
export interface AppRef {
  id: string
  name: string
  exePath?: string
  lastContext?: {
    windowTitle?: string
    url?: string
    workspace?: string
    cwd?: string
  }
}

/**
 * Snapshot of a linked clipboard item, taken once at link time.
 * Text keeps a 200-char preview (never the full body); images keep their
 * identity + dimensions + byte count so a detail view survives item eviction.
 */
export type ResourceSnapshot =
  | { type: 'text'; preview: string; capturedAt: number }
  | { type: 'image'; imageId: string; width: number; height: number; bytes: number; preview: string; capturedAt: number }
  | { type: 'image-collection'; imageId: string; width: number; height: number; bytes: number; preview: string; capturedAt: number }
  | { type: 'files'; preview: string; capturedAt: number }

/** A piece of material attached to a task (clipboard entry or file list). */
export type ResourceRef =
  | { kind: 'clipboard'; itemId: string; snapshot: ResourceSnapshot }
  | { kind: 'files'; paths: string[] }

/** A unit of focused work. `lastActiveAt` is the state machine's time base. */
export interface Task {
  id: string // 't_' prefix
  title: string
  status: TaskStatus
  note?: string
  apps: AppRef[]
  resources: ResourceRef[]
  createdAt: number
  updatedAt: number
  lastActiveAt: number
}

/** Editable surface exposed to the renderer (title/note edits + manual status transitions). */
export type TaskPatch = Partial<Pick<Task, 'title' | 'note' | 'status'>>

/** Locator for a resource to unlink: clipboard refs by itemId, files refs by exact path list. */
export type UnlinkTarget =
  | { kind: 'clipboard'; itemId: string }
  | { kind: 'files'; paths: string[] }

/** Task as pushed to the renderer: resources carry a liveness flag computed against ItemStore. */
export interface TaskDto extends Task {
  resources: (ResourceRef & { alive: boolean })[]
}

/** L0 foreground/window switch event (t12 collector emits, t16 clustering consumes). */
export interface AppSwitchEvent {
  type: 'app-switch'
  appName: string
  exePath: string
  pid: number
  windowTitle: string
  ts: number
}

/** Clipboard copy event attributed to the foreground app (t14 emits). */
export interface ClipboardEvent {
  type: 'clipboard'
  appName: string
  exePath: string
  pid: number
  ts: number
}

export type UsageEvent = AppSwitchEvent | ClipboardEvent

/** An AI endpoint in the provider chain (t15 implements the calls). */
export interface ProviderConfig {
  id: string
  baseUrl: string
  apiKey?: string
  model: string
  kind: 'local' | 'cloud'
  /** Structured (json_schema) output support; defaults to true, DeepSeek-style endpoints set false. */
  supportsSchemaOutput?: boolean
}

/** A task suggestion card (t16 produces, t19/20 refine). */
export interface Suggestion {
  id: string
  title: string
  appNames: string[]
  /** 0-1 confidence from the clustering margin rule. */
  confidence: number
  /** θ_low ≤ conf < θ_high: flagged for explicit user confirmation. */
  lowConfidence: boolean
  /** One-sentence algorithmic evidence. */
  algorithmReason: string
  evidence: {
    appCombination: string
    durationMs: number
    overlappingTasks: string[]
  }
  /** Human-readable LLM rationale; may be absent when the provider chain failed. */
  reason?: string
  /** Candidate task id for merges; absent = new-candidate suggestion (t19). */
  taskId?: string
}

export type MemoryType = 'identity' | 'tool' | 'project' | 'workflow'
export type MemoryUserState = 'confirmed' | 'suggested' | 'ignored' | 'banned'

/** Long-term memory entry (t19/20 persist + decay; never written without user confirmation). */
export interface Memory {
  id: string
  type: MemoryType
  content: string
  confidence: number
  hitCount: number
  lastSeenAt: number
  createdAt: number
  source: 'ai-suggest' | 'task-feedback' | 'user'
  userState: MemoryUserState
}

export interface Settings {
  /** Fraction of the screen height the hot zone occupies (0.2 - 0.6). */
  hotZoneHeight: number
  /** Physical thickness (in pixels) of the screen edge hover trigger. */
  hotZoneWidth: number
  /** Maximum number of unpinned history items kept. */
  historyLimit: number
  /** Fraction of the screen height the panel occupies (0.4 - 1.0). */
  panelHeight: number
  /** When true, newly captured items are not recorded. */
  incognito: boolean
  /** Start minimized when the OS logs in. */
  launchAtLogin: boolean
  /** Reduce motion for the panel animations. */
  reduceMotion: boolean
  /** When true, automatically clears unpinned items on device/app restart. */
  /** When true, automatically clears unpinned items on device/app restart. */
  clearUnpinnedOnRestart: boolean
  /** Hours after which unpinned items are automatically purged (0 = Never). */
  autoDeleteHours: number
  /** UI visual style density ('modern' | 'compact'). */
  uiStyle: 'modern' | 'compact'
  /** Flag to track if the onboarding tutorial is completed. */
  tutorialCompleted: boolean
  stickPosition: StickPosition
  stickDisplayId?: number
  /**
   * Persisted workArea geometry of the display chosen by the user.
   * Used as a cross-reboot fuzzy-match fingerprint when the OS re-assigns
   * numeric display IDs after a restart (Windows behaviour).
   */
  stickDisplayWorkArea?: { x: number; y: number; width: number; height: number }
  /**
   * DPI scale factor of the chosen display — used as a secondary discriminator
   * when two displays share identical workArea geometry (e.g. dual same-res).
   */
  stickDisplayScaleFactor?: number
  /**
   * When true, restores the bouncy overshoot panel-open animation.
   * Off by default because it requires extra GPU compositing work.
   */
  bounceAnimation: boolean
  /**
   * When true, automatically suppresses edge hover when a fullscreen game or app is active.
   * On by default to prevent accidental opening during PC gameplay.
   */
  suppressInFullscreen: boolean
  /** When true, shows the visual edge morph indicator on copy actions. Default: true. */
  showCopyIndicator: boolean
  /** Style variant of the copy indicator icon ('logo' | 'check' | 'copy' | 'sparkle'). Default: 'logo'. */
  copyIndicatorStyle: 'logo' | 'check' | 'copy' | 'sparkle'
  /** Vertical offset fraction along screen edge (0 = top, 0.5 = center, 1 = bottom). Default: 0.5. */
  verticalOffset: number
  /** Vertical alignment of the hover trigger strip relative to shelf ('top' | 'center' | 'bottom'). Default: 'center'. */
  triggerAlignment?: 'top' | 'center' | 'bottom'
  /** When true, subtly illuminates a beacon hint on the screen edge when touching the edge at a different position. Default: true. */
  showEdgeLocationHint?: boolean
  /** When true, plays tactile audio sound effects for sliders, buttons, and switches. Default: true. */
  soundEffects?: boolean
  /** Last version for which the user opened/viewed the What's New changelog panel. */
  lastSeenChangelogVersion?: string
  /** When true, hovering cursor near edge activates the panel. When false, panel opens exclusively via Alt + C. Default: true. */
  hoverActivation?: boolean
  /** Font size scale multiplier (0.85 = Small, 1.00 = Normal, 1.15 = Large). Default: 1.0. */
  fontSizeScale?: number
  /** Active UI language code ('system' | 'en' | 'es' | 'fr' | 'de' | ...). Default: 'system'. */
  language?: string
  /** Master switch for the whole task system (capture + state machine + suggestions). */
  taskCaptureEnabled: boolean
  /** L0 foreground/window event capture. Off = nothing leaves the machine. */
  l0CaptureEnabled: boolean
  /** Minutes without an attribution event before an Active task auto-pauses (1-120). */
  taskPauseThresholdMinutes: number
  /** Auto-attach clipboard copies to tasks by source process. */
  autoAttributionEnabled: boolean
  /** Minimum new events before a suggestion pass triggers (1-50). */
  suggestionMinEvents: number
  /** Silence duration before a suggestion pass triggers (30-300s). */
  suggestionSilenceSeconds: number
  /** θ_high: confidence at/above which a segment merges into a task unconditionally (0-1, > θ_low). */
  confidenceHigh: number
  /** θ_low: below this a segment starts a new candidate (0-1). */
  confidenceLow: number
  /** Memory decay λ (per week, 0.01-1). */
  memoryLambda: number
  /** Days without a hit after which a memory is down-weighted (7-365). */
  memoryStaleDays: number
  /** Score floor below which a memory becomes a cleanup candidate (0-1). */
  memoryCleanupScore: number
  /** Provider chain in priority order (first = primary, auto-failover within the list). */
  aiProviders: ProviderConfig[]
}

export const DEFAULT_SETTINGS: Settings = {
  hotZoneHeight: 0.25,
  hotZoneWidth: 3,
  historyLimit: 500,
  panelHeight: 0.5,
  incognito: false,
  launchAtLogin: true,
  reduceMotion: false,
  clearUnpinnedOnRestart: false,
  autoDeleteHours: 0,
  uiStyle: 'modern',
  tutorialCompleted: false,
  stickPosition: 'left',
  stickDisplayId: undefined,
  stickDisplayWorkArea: undefined,
  stickDisplayScaleFactor: undefined,
  bounceAnimation: false,
  suppressInFullscreen: true,
  showCopyIndicator: true,
  copyIndicatorStyle: 'logo',
  verticalOffset: 0.5,
  triggerAlignment: 'center',
  showEdgeLocationHint: true,
  soundEffects: true,
  lastSeenChangelogVersion: undefined,
  hoverActivation: true,
  fontSizeScale: 1.0,
  language: 'system',
  taskCaptureEnabled: true,
  l0CaptureEnabled: true,
  taskPauseThresholdMinutes: 15,
  autoAttributionEnabled: true,
  suggestionMinEvents: 5,
  suggestionSilenceSeconds: 60,
  confidenceHigh: 0.7,
  confidenceLow: 0.45,
  memoryLambda: 0.25,
  memoryStaleDays: 60,
  memoryCleanupScore: 0.1,
  aiProviders: []
}


