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

/**
 * The foreground app at capture time (ADR-0001). Same source and privacy gate
 * as the clipboard event; absent when the gate was off or the foreground
 * could not be read. `exePath` is what AppRef.id normalizes.
 */
export interface SourceApp {
  name: string
  exePath?: string
}

/**
 * Second-level filter inside the clipboard view (ADR-0004).
 * 'all' never includes file entries — files live in the files view.
 */
export type ClipboardFilter = 'all' | 'text' | 'links' | 'images'

/**
 * Second-level filter inside the files view (ADR-0004): the dynamic
 * extension tabs ('.pdf', …) are added by the renderer; 'other' holds
 * extension-less members. The value is the raw `path.extname` result.
 */
export type FilesFilter = 'all' | 'other' | (string & {})

/** Second-level filter inside the tasks view (ADR-0004). */
export type TasksFilter = 'existing' | 'candidates'

/** Top-level panel views (ADR-0004). */
export type View = 'clipboard' | 'files' | 'tasks'

/** Restore-time preset: how long the panel keeps its last page after closing. */
export type RestoreTime = 'instant' | 'relaxed' | 'delayed' | 'forever'

/**
 * Accent theme id (values in shared/themes.ts). Color names are not
 * translated; localized labels live in i18n under `appearance.theme*`.
 */
export type ThemeColor = 'graphite' | 'cobalt' | 'verdigris' | 'amber' | 'violet'

/**
 * Landing page applied on first launch and after the restore time expires
 * (ADR-0004). The files view has no second level — it always lands on 'all'
 * because dynamic extension tabs may not exist.
 */
export type LandingPage =
  | { view: 'clipboard'; filter: ClipboardFilter }
  | { view: 'files' }
  | { view: 'tasks'; filter: TasksFilter }

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
  /** App in the foreground when this content was captured (ADR-0001); absent for legacy/unattributed items. */
  sourceApp?: SourceApp
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

/**
 * Lifecycle of a task (five-state machine, spec 实现决策 4). RUNNING is the
 * single current task (domain invariant: runningTaskCount <= 1); WAITING is
 * the system-inferred rest state (auto-resumable); PAUSED is a user-manual
 * state that is immune to auto-resume; COMPLETED / ARCHIVED are terminal
 * user actions — the system never revives them.
 */
export type TaskStatus = 'running' | 'waiting' | 'paused' | 'completed' | 'archived'

/** Who drove the last status transition: the user or the system. */
export type StatusSource = 'user' | 'system'

/**
 * Why a task entered its current status (written on every transition;
 * absent only for legacy data that predates status annotation).
 */
export type StatusReason =
  /** system: RUNNING -> WAITING via the idle timeout */
  | 'activity_lost'
  /** user: RUNNING -> PAUSED */
  | 'user_paused'
  /** user: PAUSED/WAITING -> RUNNING */
  | 'user_resumed'
  /** system: task switch — displaced old RUNNING task or a WAITING task taking RUNNING (attribution/new task) */
  | 'auto_switch'
  /** user: -> COMPLETED */
  | 'user_completed'
  /** user: -> ARCHIVED (also COMPLETED -> ARCHIVED) */
  | 'user_archived'
  /** user: COMPLETED/ARCHIVED -> RUNNING */
  | 'user_restored'
  /** system: legacy data migration (old 'active' -> RUNNING/WAITING) */
  | 'migration'

/**
 * An application a task is associated with.
 * `id` is the identity key: lowercase-normalized exePath, or the process name
 * when no exePath is known. `lastContext` is the latest L0 capture landing spot.
 */
export interface AppRef {
  id: string
  name: string
  exePath?: string
  /** Windows app icon as a dataURL; filled by main at push time (t26), absent when extraction failed. */
  iconUrl?: string
  lastContext?: {
    windowTitle?: string
    url?: string
    workspace?: string
    cwd?: string
  }
  /**
   * Foreground-window snapshot recorded when the app first joined a task
   * (ADR-0005): the detail view's "open app" button switches to this window.
   * Unlike `lastContext` it is never refreshed after being set.
   */
  linkedWindow?: { pid: number; title: string; ts: number }
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
  /** Who drove the last status transition — lets the UI tell "you paused it" apart from "the system judged it waiting". */
  statusSource: StatusSource
  /** Why the task entered its current status (set on every transition). */
  statusReason?: StatusReason
  note?: string
  apps: AppRef[]
  resources: ResourceRef[]
  /** Recent window titles captured at creation (t27); empty for tasks built outside the suggestion flow. */
  windowTitles: string[]
  /** 0-1 acceptance confidence at creation (t27); absent for manually created tasks. */
  confidence?: number
  /** Human-readable creation reason — LLM rationale or algorithm evidence summary, never raw OCR (t27). */
  reason?: string
  createdAt: number
  updatedAt: number
  lastActiveAt: number
  /**
   * Cumulative time the task has spent in RUNNING (ms, ADR-0006). Settled
   * whenever the task leaves RUNNING (pause/complete/archive + idle timeout
   * + auto-switch displacement); never reset on resume. Displayed as
   * "Running {duration}".
   */
  activeMs: number
}

/**
 * Editable surface exposed to the renderer (title/note edits + manual status
 * transitions + guided-form selections, ADR-0002).
 * `apps` replaces the whole app list. `clipboardItemIds` is the full desired
 * set of linked clipboard items — main snapshots each id and replaces the
 * task's clipboard resources (files resources are untouched); absent = no
 * change, `[]` = clear them.
 */
export type TaskPatch = Partial<Pick<Task, 'title' | 'note' | 'status' | 'windowTitles' | 'confidence' | 'reason' | 'apps'>> & {
  clipboardItemIds?: string[]
}

/** Locator for a resource to unlink: clipboard refs by itemId, files refs by exact path list. */
export type UnlinkTarget =
  | { kind: 'clipboard'; itemId: string }
  | { kind: 'files'; paths: string[] }

/** Task as pushed to the renderer: resources carry a liveness flag computed against ItemStore. */
export interface TaskDto extends Task {
  resources: (ResourceRef & { alive: boolean })[]
  /** Session history for this task, newest first (the open run on top). */
  sessions: TaskSession[]
}

/**
 * One continuous run of a task (spec 实现决策 4). Opens when a task enters
 * RUNNING, settles when it leaves RUNNING. A task has many sessions; at most
 * one session is open globally (the RUNNING task's). Sessions are the
 * container for the activities observed during the run (1:N — an activity
 * never maps 1:1 to a session) and provide instance-level history on top of
 * the aggregate `activeMs` (ADR-0006), whose semantics are unchanged.
 */
export interface TaskSession {
  id: string // 's_' prefix
  taskId: string // references tasks.json entries — TaskStore stays JSON-backed
  startedAt: number // epoch ms
  endedAt?: number // epoch ms; absent while the run is open
  /** 0-1 confidence of the run — the task's confidence at settle time. */
  confidence: number
  /**
   * Why the run ended: auto_switch / activity_lost / user_paused /
   * user_completed / user_archived / user_merged / user_deleted. Empty
   * string while the session is open.
   */
  transitionReason: string
  /** The task that was RUNNING before this session's task took over; absent on the first run. */
  previousTaskId?: string
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

/**
 * Clipboard copy event attributed to the foreground app (t14 emits).
 * `itemId` links the event to the captured item so a suggestion can carry
 * the material copied during its segment.
 */
export interface ClipboardEvent {
  type: 'clipboard'
  appName: string
  exePath: string
  pid: number
  ts: number
  itemId?: string
}

export type UsageEvent = AppSwitchEvent | ClipboardEvent

/** An AI endpoint in the provider chain (t15 implements the calls). */
export interface ProviderConfig {
  id: string
  baseUrl: string
  apiKey?: string
  model: string
  /** Structured (json_schema) output support; defaults to true, DeepSeek-style endpoints set false. */
  supportsSchemaOutput?: boolean
}

/** A task proposal card (t16 produces, t19/20 refine). */
export interface TaskProposal {
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
  /** exePaths parallel to appNames; filled by the suggestion engine so main can fetch icons (t26). */
  appExePaths?: string[]
  /** Resolved app icons, one entry per app with an extractable exePath; filled by main at push time (t26). */
  appIcons?: { name: string; iconUrl: string }[]
  /**
   * Clipboard material copied during the segment's window (same shape as a
   * task's resources). Proposal cards and the convert panel show these;
   * accepting binds them to the created task. Absent on older payloads.
   */
  clipboardRefs?: ResourceRef[]
}

export type MemoryType = 'identity' | 'tool' | 'project' | 'workflow'
export type MemoryUserState = 'confirmed' | 'suggested' | 'ignored' | 'banned'

/** A user decision on one memory, mirroring MemoryStore method names (memory:act). */
export type MemoryAction = 'confirm' | 'ignore' | 'ban' | 'unban' | 'delete'

/** Memory panel buckets, refreshed after every decision so the UI never recomputes decay. */
export interface MemoryListPayload {
  /** Pending user decisions (suggested). */
  candidates: Memory[]
  /** Live memories (confirmed). */
  confirmed: Memory[]
  /** Pattern vetoes (banned), viewable and un-bannable. */
  banned: Memory[]
  /** Stale + low-score memories awaiting user-confirmed deletion. */
  cleanup: Memory[]
}

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
  /**
   * Accent theme for the panel UI, drag ghosts, and the copy indicator
   * (ADR-0007/Ticket 3). The five color values live in shared/themes.ts.
   */
  themeColor: ThemeColor
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
  /** Evidence timeline retention in days (spec decision 2; 1-365, default 30). */
  evidenceRetentionDays: number
  /** Minutes without an attribution event before an Active task auto-pauses (1-120). */
  taskPauseThresholdMinutes: number
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
  /** Days unadopted AI-trace rows are kept before cleanup (spec 决策 8; default 30). */
  traceRetentionDays: number
  /** Provider chain in priority order (first = primary, auto-failover within the list). */
  aiProviders: ProviderConfig[]
  /**
   * Landing page applied on first launch and after the restore time expires
   * (ADR-0004). The files view has no second level.
   */
  landing: LandingPage
  /**
   * How long the panel keeps its last page after closing before restoring
   * the landing page (ADR-0004). 'forever' disables restoring entirely.
   */
  restoreTime: RestoreTime
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
  themeColor: 'graphite',
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
  evidenceRetentionDays: 30,
  taskPauseThresholdMinutes: 15,
  suggestionMinEvents: 5,
  suggestionSilenceSeconds: 60,
  confidenceHigh: 0.7,
  confidenceLow: 0.45,
  memoryLambda: 0.25,
  memoryStaleDays: 60,
  memoryCleanupScore: 0.1,
  traceRetentionDays: 30,
  aiProviders: [],
  landing: { view: 'tasks', filter: 'existing' },
  restoreTime: 'relaxed'
}


