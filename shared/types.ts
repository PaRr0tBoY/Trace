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
  | { kind: 'text'; text: string; html?: string; isUrl: boolean; isColor?: boolean; hasFullPayload?: boolean; previewText?: string }
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
 * extension-less members; 'clipboard' narrows the station to clipboard-
 * captured entries (T6 route filter, merged into this single dimension so
 * the row has exactly one active chip). The value is the raw
 * `path.extname` result.
 */
export type FilesFilter = 'all' | 'clipboard' | 'other' | (string & {})

/** Second-level filter inside the tasks view (ADR-0004). */
export type TasksFilter = 'existing' | 'candidates'

/** Top-level panel views (ADR-0004). */
export type View = 'clipboard' | 'files' | 'tasks'

/** Restore-time preset: how long the panel keeps its last page after closing. */
export type RestoreTime = 'instant' | 'relaxed' | 'delayed' | 'forever'

/** Animation richness levels — see Settings.motionLevel. */
export type MotionLevel = 'standard' | 'extended'

/**
 * Accent theme id (values in shared/themes.ts). Color names are not
 * translated; localized labels live in i18n under `appearance.theme*`.
 */
export type ThemeColor = 'graphite' | 'cobalt' | 'verdigris' | 'amber' | 'violet'

/**
 * Drag-out semantics (ADR-0007): 'copy' drags the original paths and leaves
 * entry and source untouched; 'move' stages the originals into the station
 * staging area at drag start (接管式移动) and completes on a successful drop.
 */
export type MoveMode = 'copy' | 'move'

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
  | { kind: 'text'; text: string; html?: string; isUrl: boolean; isColor?: boolean; hasFullPayload?: boolean; previewText?: string }
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
}

/* ------------------------------------------------------------------ */
/* Alt+Tab switcher (ADR-0005)                                          */
/* ------------------------------------------------------------------ */

/** One entry in the switcher list, as sent to the renderer. */
export interface SwitcherEntryDto {
  title: string
  exePath: string
  isCurrent: boolean
  /** Original position in the ungrouped z-order list — hover/click report this to main. */
  index: number
  /** Set when the same app's windows are grouped: window count for the badge. */
  groupCount?: number
  /** The grouped windows (z-order), present only on a group row — drives the drill-in view. */
  windows?: SwitcherEntryDto[]
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
  /**
   * AI-rationale decision-chain id (t42): the trace recorder groups this
   * proposal's observed → … → result rows under it. Absent on older
   * payloads — the UI falls back to the proposal's own id.
   */
  decisionId?: string
  /** exePaths parallel to appNames; filled by the suggestion engine so main can fetch icons (t26). */
  appExePaths?: string[]
  /**
   * 来源活动段起始时间戳（t57 决策路径提案）：推荐指纹 / 冷却键的时段输入
   * （activityLedger.recommendationFingerprint 的小时桶）。引擎 Path A 卡片
   * 经 meta 携带等价信息，不设此字段。
   */
  segmentStartTs?: number
  /** 展示分级 L1/L2/L3（t47 评级产出，runAnalysis 时随卡片写入；UI 与 accept/ignore 记录消费）。 */
  level?: RecommendationLevel
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

/* ------------------------------------------------------------------ */
/* 记忆图面板（t51 记忆可审查）：facts / 冲突对 / 来源链 DTO             */
/* ------------------------------------------------------------------ */

/** 来源链摘要：事实起源 episode 的时段与整理摘要（面板展示用）。 */
export interface MemoryEpisodeRefDto {
  id: string
  startedAt: number
  endedAt: number | null
  summary: string | null
}

/** 记忆图单条事实 DTO（t51）：时间有效性 + 来源链 + 用户状态。 */
export interface MemoryFactDto {
  id: string
  type: string
  content: string
  source: 'ai-suggest' | 'task-feedback' | 'user' | 'inferred'
  userState: MemoryUserState
  intent: string
  weight: number
  validAt: number | null
  invalidAt: number | null
  expiredAt: number | null
  createdAt: number
  updatedAt: number
  hitCount: number
  episodeId: string | null
  /** 来源链摘要（null = 无起源 episode）。 */
  episode: MemoryEpisodeRefDto | null
}

/** 冲突对（t51，spec 决策 10）：同 (type, 主语键) 的有效方 + 被自动失效方，并排展示。 */
export interface MemoryFactConflictDto {
  active: MemoryFactDto
  invalidated: MemoryFactDto
}

/** 冲突裁决三选（spec 决策 10：不自动覆盖，用户显式决定）。 */
export type MemoryConflictResolution = 'keep-active' | 'keep-invalidated' | 'keep-none'

/**
 * 记忆图面板载荷：未失效 facts（全 userState，UI 按 type 过滤分组）+
 * 待裁决冲突对（含被失效方，各自内联来源链）。每次操作后整体刷新返回。
 */
export interface MemoryFactPanelPayload {
  facts: MemoryFactDto[]
  conflicts: MemoryFactConflictDto[]
  /** 主进程 memory graph 不可用（DB 故障）时为 true，面板显示降级文案而非空库文案。 */
  degraded: boolean
}

/* ------------------------------------------------------------------ */
/* AI rationale trace (t42) — renderer view of traceStore rows          */
/* ------------------------------------------------------------------ */

/** Kind of one AI-rationale row (mirrors traceStore TRACE_KINDS, t41). */
export type TraceKind = 'observed' | 'recall' | 'decision' | 'result' | 'privacy'

/**
 * One AI-rationale row as pushed to the renderer (t42). Same shape as the
 * traceStore record: payload is the kind-specific JSON body (already parsed),
 * versions are per-row (spec 决策 8). Read-only for the renderer — writes go
 * through the future trace recorder in main.
 */
export interface TraceRecordDto {
  id: string
  /** Decision-chain group id: one observed → … → result chain shares it. */
  decisionId: string
  kind: TraceKind
  payload: Record<string, unknown>
  /** Adopted proposal's task: non-empty = lives with the task (retention skips it). */
  taskId?: string
  agentVersion?: string
  policyVersion?: string
  classifierVersion?: string
  promptVersion?: string
  /** Unix epoch ms (store-assigned clock). */
  createdAt: number
}

/** 隐私：可进入 AI 的内容类型（与 privacyGate.ContentType 同构，spec 决策 7）。 */
export type ContentType = 'text' | 'image' | 'files'

/* ------------------------------------------------------------------ */
/* Recommendation history (t46, spec 决策 9)                            */
/* ------------------------------------------------------------------ */

/** 展示分级：L1 主动建议 / L2 候选区 / L3 不展示（t47 评级产出，46 只持久化）。 */
export type RecommendationLevel = 1 | 2 | 3

/** 用户对一条推荐的动作结果。 */
export type RecommendationOutcome = 'accepted' | 'ignored' | 'dismissed' | 'noop'

/**
 * 动作原因（spec 决策 9 基线五值；t46 扩展 user_edited_title 承载"用户编辑
 * 标题"这一最强信号，映射意图档 user-edit）。
 */
export type RecommendationActionReason =
  | 'user_confirmed'
  | 'user_manually_dismissed'
  | 'wrong_task'
  | 'already_exists'
  | 'not_now'
  | 'user_edited_title'

/** 忽略原因（t46）：不感兴趣 / 重复 / 错任务 / 暂不想处理。 */
export const IGNORE_REASONS = ['not_interested', 'duplicate', 'wrong_task', 'not_now'] as const
export type IgnoreReason = (typeof IGNORE_REASONS)[number]

/**
 * 一条推荐历史记录（spec 决策 9 契约 + 主键 id）。指纹 = 语义簇 + 关键实体 +
 * 时段（v1 以活动签名为基础，见 activityLedger.recommendationFingerprint）。
 */
export interface RecommendationRecord {
  id: string
  fingerprint: string
  /** 跨小时桶的"同类"模式键（t47）：级别/拒绝历史按它累积；旧行/外部写入可为空。 */
  patternKey?: string
  level: RecommendationLevel
  /** Unix epoch ms：展示时刻（store 以注入时钟落）。 */
  shownAt: number
  outcome?: RecommendationOutcome
  actionReason?: RecommendationActionReason
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
  /**
   * Animation richness, the single source of truth for all motion in the
   * app (CSS transitions + Framer Motion + GSAP):
   * - 'standard' — crisp functional motion: blade reveal, card enter/exit,
   *                flyouts, toasts, hover feedback. No overshoot bounces.
   * - 'extended' — standard plus delight: blade open bounce, tab-capsule
   *                spring, new-item highlight, empty-state entrance, badge
   *                pops, press feedback, copy ripple.
   * Deliberately NOT tied to the OS prefers-reduced-motion flag (see
   * useOpenBounce): the OS "Show animations" setting silently killed every
   * animation on the author's machine; the in-app setting is authoritative.
   */
  motionLevel: MotionLevel
  /** When true, automatically clears unpinned items on device/app restart. */
  /** When true, automatically clears unpinned items on device/app restart. */
  clearUnpinnedOnRestart: boolean
  /**
   * Drag-out semantics (ADR-0007): 'copy' = destination gets a copy, entry
   * and source untouched; 'move' (default) = staged takeover move, the
   * original is taken into the station at drag start.
   */
  moveMode: MoveMode
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
  /**
   * Current-task switch hysteresis (t55, spec 决策 5): a candidate must persist
   * this long (seconds, 30-60) before a switch to it may execute — short
   * detours never flip the running task.
   */
  switchDwellSeconds: number
  /**
   * Current-task switch hysteresis (t55, spec 决策 5): the score difference a
   * candidate must hold over the current task (0-1) for a switch — with the
   * threshold and dwell it gates every switch execution.
   */
  switchMargin: number
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
  // Privacy domain (spec 决策 7/12; consumed by privacyGate in main). Defaults
  // mirror DEFAULT_POLICY — 全开显式可见。
  /** AI 总开关（决策预填 + 全部工具 + OCR 都过它）。 */
  aiEnabled: boolean
  /** 拒绝应用清单，exePath 归一化键（小写 + 正斜杠；与 privacyGate.normalizeExePath 同规则）。 */
  deniedApps: string[]
  /** 允许进 AI 的内容类型（剪贴板条目 / 关联材料）。 */
  allowedContentTypes: ContentType[]
  /** 每日 AI 可用截止小时（00:00 起算，0–24）；undefined = 全天不限。 */
  aiTimeRangeHours?: number
  /** search_clipboard 总开关（剪贴板预览访问）。 */
  clipboardAccess: boolean
  /** search_memories / 预填记忆 总开关。 */
  memoryAccess: boolean
  /** 记忆写入主开关（时段整理落库）。 */
  memoryEnabled: boolean
  /**
   * 本地模型增强开关（t54, spec 决策 11）：默认关 — 可选增强，关闭时其余
   * 功能完全等价（不变量 H）。开启后候选后处理走本地模型过滤/标题/排序。
   */
  localModelEnabled: boolean
  /** 本地模型来源（'auto' = 自动下载，'manual' = 用户手选 .gguf）。默认 auto。 */
  localModelSource: LocalModelSource
  /** 手动 .gguf 路径（source='manual' 时生效）；由 manager 做存在性校验。 */
  localModelManualPath?: string
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
  /**
   * Alt+Tab switcher: group multiple windows of the same app into one row
   * (drill-in on click). Default off — native behavior.
   */
  switcherGroupWindows: boolean
  /**
   * Automatic updates via GitHub releases (electron-updater). When true the
   * app checks at startup and downloads in the background; when false it
   * stays network-silent and only manual checks run. Default: true.
   */
  autoUpdates?: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  hotZoneHeight: 0.25,
  hotZoneWidth: 3,
  historyLimit: 250,
  panelHeight: 0.5,
  incognito: false,
  launchAtLogin: true,
  motionLevel: 'standard',
  clearUnpinnedOnRestart: false,
  moveMode: 'move',
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
  showEdgeLocationHint: false,
  soundEffects: true,
  lastSeenChangelogVersion: undefined,
  hoverActivation: true,
  fontSizeScale: 1.0,
  language: 'system',
  taskCaptureEnabled: true,
  l0CaptureEnabled: true,
  evidenceRetentionDays: 30,
  taskPauseThresholdMinutes: 15,
  switchDwellSeconds: 45,
  switchMargin: 0.1,
  suggestionMinEvents: 5,
  suggestionSilenceSeconds: 60,
  confidenceHigh: 0.7,
  confidenceLow: 0.45,
  memoryLambda: 0.25,
  memoryStaleDays: 60,
  memoryCleanupScore: 0.1,
  traceRetentionDays: 30,
  aiProviders: [],
  aiEnabled: true,
  deniedApps: [],
  allowedContentTypes: ['text', 'image', 'files'],
  clipboardAccess: true,
  memoryAccess: true,
  memoryEnabled: true,
  localModelEnabled: false,
  localModelSource: 'auto',
  localModelManualPath: undefined,
  landing: { view: 'tasks', filter: 'existing' },
  restoreTime: 'relaxed',
  switcherGroupWindows: false,
  autoUpdates: true
}

/* ------------------------------------------------------------------ */
/* Local model (t53/54)                                                */
/* ------------------------------------------------------------------ */

/** How the local model file is provided: auto-downloaded or a user-picked .gguf. */
export type LocalModelSource = 'auto' | 'manual'

/**
 * Lifecycle state of the local model manager (t53). 'ready' means the model
 * file is present; integrity is enforced by the checksum gate (verify / load
 * refuses mismatching files).
 */
export type LocalModelState = 'none' | 'downloading' | 'ready' | 'error'

/** Download progress for the auto model file. */
export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
  /** 0..1 fraction of the file received (1 = fully received, checksum still pending). */
  percent: number
}

/**
 * Snapshot of the local model manager — the DTO the settings UI (t54) polls
 * over IPC. `modelFilePath` is the loadable model file (verified auto download
 * or the user-picked manual path).
 */
export interface LocalModelStatus {
  state: LocalModelState
  source: LocalModelSource | null
  progress: DownloadProgress | null
  /** Last failure message when state is 'error'. */
  error: string | null
  modelFilePath: string | null
}

/* ------------------------------------------------------------------ */
/* CandidateActivity (t54, spec 实现决策 6/11)                          */
/* ------------------------------------------------------------------ */

/**
 * 本地模型中间结构（决策者的公共输入，spec 决策 6）：聚类产出候选后、决策前，
 * 候选被统一成 CandidateActivity 交给本地模型做过滤（≤3）/ 标题草稿 / 排序
 * （spec 决策 11 接入点）。关闭或失败 → 算法候选原样传递（不变量 H：功能等价，
 * 绝不污染决策数据）。
 *
 * - `activityId` 对应 activityLedger Activity.id，是候选与活动之间的稳定键。
 * - `candidateTaskId` 为归属的候选任务（merge 目标）；缺失 = new 候选。
 * - `semanticLabel` 为本地模型产出的标题草稿；缺失 = 沿用算法 / LLM 标题。
 * - `score` 为算法置信度（0-1），排序基准；本地模型的 rerank 只改变候选
 *   顺序与数量，不改动归因数据。
 * - `evidenceRefs` 为证据引用（v1：窗口标题 + 应用组合串），供本地模型上下文。
 */
export interface CandidateActivity {
  activityId: string
  candidateTaskId?: string
  semanticLabel?: string
  score: number
  evidenceRefs: string[]
}
