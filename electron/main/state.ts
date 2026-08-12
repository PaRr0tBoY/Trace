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
import {
  buildClipboardPreview,
  createMemoryEvidenceStore,
  createSqliteEvidenceStore,
  evidenceFromUsageEvent,
  MAX_EVIDENCE_QUERY_LIMIT,
  type EvidenceStore
} from '../store/evidenceStore'
import { createSqliteTraceStore, type TraceStore } from '../store/traceStore'
import {
  createMemoryRecommendationHistory,
  createSqliteRecommendationHistory,
  type RecommendationHistory
} from '../store/recommendationHistory'
import {
  createMemoryIndexAdapter,
  createSqliteMemoryGraph,
  LEGACY_MEMORY_TYPES,
  type MemoryGraphStore,
  type MemoryIndexAdapter
} from '../store/memoryGraph'
import { MemoryStore, type MemoryIndex } from '../store/MemoryStore'
import type { ClipboardItem, ClipboardItemDto, Settings, TaskProposal, TaskDto, UsageEvent } from '../../shared/types'
import { MAX_STACK } from '../../shared/types'
import { createId } from '../store/ids'
import { nativeImage, BrowserWindow, powerMonitor, safeStorage, app } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../store/paths'
import { prefetchFileIcons } from './drag'
import { attachAppIcons, attachSuggestionIcons } from './appIcons'
import { runtime } from './config'
import { queryForegroundSnapshot, type ForegroundSnapshot } from './foreground'
import { emit, recentEvents, subscribe as subscribeEvents } from './eventBus'
import { buildClipboardEvent } from './attributor'
import { createSuggestionEngine, TICK_INTERVAL_MS, type ChatFn, type OcrFn, type SuggestionEngine } from './suggestionEngine'
import { createIgnoredTable } from './ignored'
import { createActivityLedger, DEFAULT_SEGMENT_PARAMS, type ActivityLedger } from '../store/activityLedger'
import { createChatEpisodeExtractor, createEpisodeConsolidator, type EpisodeConsolidator } from '../store/episodeConsolidator'
import { aiAllowed, memoryAllowed, policyFromSettings } from '../store/privacyGate'
import { logAi } from './aiLog'
import { LocalModelManager, shouldLoadLocalModel } from '../store/localModelManager'
import { LocalModelRuntime } from '../store/localModelRuntime'
import { createWorkerModelEngine } from '../store/localModelWorkerEngine'
import { createCandidateOptimizer, type CandidateOptimizer } from '../store/localModelOptimizer'
import { gradeProposal } from '../store/proposalGrading'

const store = new ItemStore()
const watcher = new ClipboardWatcher(600)
let pruneTimer: ReturnType<typeof setInterval> | null = null
let wakeTimer: ReturnType<typeof setTimeout> | null = null
let taskSweepTimer: ReturnType<typeof setInterval> | null = null
let suggestionTimer: ReturnType<typeof setInterval> | null = null
let suggestionEngine: SuggestionEngine | null = null
let activityLedger: ActivityLedger | null = null
let memoryStore: MemoryStore | null = null
/** Memory graph (t48): 三表事实图 over trace.db；null = DB 故障降级。 */
let memoryGraph: MemoryGraphStore | null = null
/** 记忆面板的 SQLite 适配器（MemoryIndex ↔ facts 行）；随图创建。 */
let memoryIndexAdapter: MemoryIndexAdapter | null = null
/** SQLite canonical store handle (opened after app ready; closed on quit). */
let traceDb: TraceDatabase | null = null
/** Evidence timeline store over traceDb (t39); null when the DB failed to open. */
let evidenceStore: EvidenceStore | null = null
/** AI-rationale store over the same traceDb (t42); null when the DB failed to open. */
let traceStore: TraceStore | null = null
/** Recommendation history + cooldown (t46) over the same traceDb; memory fallback on DB failure. */
let recommendationHistory: RecommendationHistory | null = null
/** Local model manager (t54): registry / download / checksum / source / lifecycle. */
let localModelManager: LocalModelManager | null = null
/** Local model runtime (t53/54): load / infer / queue over the worker-thread engine. */
let localModelRuntime: LocalModelRuntime | null = null
let evidenceUnsubscribe: (() => void) | null = null
let evidencePurgeTimer: ReturnType<typeof setInterval> | null = null
let recommendationPurgeTimer: ReturnType<typeof setInterval> | null = null
/** Episode consolidator (t49): 时段整理器；null = DB 故障降级。 */
let episodeConsolidator: EpisodeConsolidator | null = null
let consolidationTimer: ReturnType<typeof setInterval> | null = null
/** Provider 链聊天入口（setSuggestionChat 注入；null = AI 未接线）。 */
let suggestionChat: ChatFn | null = null
/** 时段整理检查节流（t49）：5 分钟粒度，会话结束/时段边界/6h 兜底都经它。 */
const CONSOLIDATION_CHECK_MS = 5 * 60_000
/** Retention sweep cadence (t39): hourly, single indexed DELETE — never blocks capture. */
const EVIDENCE_RETENTION_CHECK_MS = 3_600_000

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
 * memories.json → facts 一次性迁移（t48）：数据不丢、source/userState 不变。
 * 先确认写入成功（条数对账）再删旧文件；ingest 整体单事务，故崩溃续跑时
 * facts 已有 legacy 事实 ⇔ 迁移完整 → 只删文件不重复迁；DB 或文件异常 →
 * 保留文件（面板降级 JSON 路径）。
 */
function migrateMemoriesToGraph(graph: MemoryGraphStore): void {
  const file = PATHS.memoriesFile()
  if (!existsSync(file)) return
  const index = loadMemoriesFile()
  if (!index || !Array.isArray(index.memories)) {
    console.error('[Memory] migration skipped: memories.json unreadable, file kept')
    return
  }
  if (graph.countFacts({ types: LEGACY_MEMORY_TYPES }) > 0) {
    rmSync(file, { force: true })
    console.info('[Memory] migration resumed: facts already present, memories.json removed')
    return
  }
  try {
    const inserted = graph.ingestLegacyMemories(index.memories)
    if (inserted === index.memories.length) {
      rmSync(file, { force: true })
      console.info(`[Memory] migration complete: ${inserted} memories → facts; memories.json removed`)
    } else {
      console.error(`[Memory] migration incomplete (${inserted}/${index.memories.length}); memories.json kept`)
    }
  } catch (err) {
    console.error('[Memory] migration failed; memories.json kept:', err)
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
    evidenceStore = createSqliteEvidenceStore(traceDb)
    traceStore = createSqliteTraceStore(traceDb)
    recommendationHistory = createSqliteRecommendationHistory(traceDb)
  } catch (err) {
    traceDb = null
    // In-memory timeline fallback (t40): capture keeps flowing and the
    // suggestion pipeline stays fully functional; only persistence is lost.
    evidenceStore = createMemoryEvidenceStore()
    traceStore = null
    // In-memory recommendation history (t46): cooldown/pattern learning stay
    // live for the session even when the DB failed; nothing survives restart.
    recommendationHistory = createMemoryRecommendationHistory()
    console.error('[Store] trace.db open failed; sessions/evidence/trace will not persist:', err)
  }
  // Subscribed regardless of the store backend so a degraded DB never breaks
  // the suggestion pipeline (the ActivityLedger reads this timeline).
  evidenceUnsubscribe = subscribeEvents(handleEvidenceEvent)
  // Memory graph (t48): three-table fact store over trace.db. When the DB is
  // healthy, the memory panel's MemoryStore persists through the graph adapter
  // and memories.json is migrated once (verify-then-delete, see
  // migrateMemoriesToGraph). On DB failure the panel degrades to the old JSON
  // file — the migration never ran, so nothing is lost.
  if (traceDb) {
    const graphSettings = loadSettings()
    memoryGraph = createSqliteMemoryGraph(traceDb, { lambda: graphSettings.memoryLambda })
    memoryIndexAdapter = createMemoryIndexAdapter(memoryGraph)
    migrateMemoriesToGraph(memoryGraph)
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

  // Evidence retention (t39, spec decision 2): purge events older than the
  // setting once at startup and hourly. One indexed DELETE on capturedAt —
  // cheap enough to never block capture (WAL isolates the writer anyway).
  const runEvidencePurge = (): void => {
    if (runtime.quitting || evidenceStore === null) return
    const settings = loadSettings()
    const cutoff = Date.now() - settings.evidenceRetentionDays * 86_400_000
    const removed = evidenceStore.purgeBefore(cutoff)
    if (removed > 0) console.log(`[Evidence] purged ${removed} events (retention ${settings.evidenceRetentionDays}d)`)
  }
  runEvidencePurge()
  if (evidencePurgeTimer !== null) clearInterval(evidencePurgeTimer)
  evidencePurgeTimer = setInterval(runEvidencePurge, EVIDENCE_RETENTION_CHECK_MS)

  // Recommendation retention (t46, spec 决策 8/9): 未采纳推荐记录与其 trace
  // 随推荐历史 30 天清（Settings.traceRetentionDays 可调）。同一个 hourly 扫
  // 描：两处 cleanupBefore 用同一 cutoff，未采纳 trace 才能与推荐记录同步消失。
  const runRecommendationPurge = (): void => {
    if (runtime.quitting) return
    const settings = loadSettings()
    const cutoff = Date.now() - settings.traceRetentionDays * 86_400_000
    const records = getRecommendationHistory()
    const recRemoved = records ? records.cleanupBefore(cutoff) : 0
    const traceRemoved = traceStore !== null ? traceStore.cleanupBefore(cutoff) : 0
    if (recRemoved > 0 || traceRemoved > 0) {
      console.log(
        `[Recommendation] purged ${recRemoved} records, ${traceRemoved} unadopted trace rows (retention ${settings.traceRetentionDays}d)`
      )
    }
  }
  runRecommendationPurge()
  if (recommendationPurgeTimer !== null) clearInterval(recommendationPurgeTimer)
  recommendationPurgeTimer = setInterval(runRecommendationPurge, EVIDENCE_RETENTION_CHECK_MS)

  if (suggestionTimer !== null) clearInterval(suggestionTimer)
  suggestionTimer = setInterval(() => {
    if (runtime.quitting) return
    getSuggestionEngine().tick()
  }, TICK_INTERVAL_MS)
  getSuggestionEngine().start()

  // 时段整理（t49, spec 决策 10）：周期检查 → 会话结束/时段边界/6h 兜底触发
  // → 整批 combined extraction（≤2 次 LLM 调用）→ 去重/矛盾消解入库。门：
  // memoryAllowed（记忆写入主开关）+ aiAllowed（AI 总开关）——任一关则整轮
  // 跳过（不花 LLM、不写事实），episode 保持 pending（免费），重开后自动补。
  if (consolidationTimer !== null) clearInterval(consolidationTimer)
  consolidationTimer = setInterval(() => {
    runConsolidation()
  }, CONSOLIDATION_CHECK_MS)

  // Local model (t54): hydrate the manager from persisted source/path and
  // preload the model when enabled + ready, so the first optimization pass
  // never stalls on a lazy load. Download/remove flow through IPC.
  getLocalModelManager()
  ensureLocalModelLoaded()
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

/**
 * Evidence timeline (t39): persist every gated usage event into the events
 * table. Collectors already enforce the capture gates (incognito / task-capture
 * / L0), so anything that reaches the bus is recordable. Clipboard events carry
 * a bounded material preview (text ≤200 chars, image dims+bytes, file paths —
 * spec story 35) so the by-id detail answers "what was copied".
 */
function handleEvidenceEvent(event: UsageEvent): void {
  if (evidenceStore === null) return
  if (event.type === 'clipboard' && event.itemId) {
    const item = getStore().get(event.itemId)
    evidenceStore.record(
      evidenceFromUsageEvent(event, { preview: item ? buildClipboardPreview(item) : undefined })
    )
  } else {
    evidenceStore.record(evidenceFromUsageEvent(event))
  }
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
  if (evidencePurgeTimer !== null) {
    clearInterval(evidencePurgeTimer)
    evidencePurgeTimer = null
  }
  if (recommendationPurgeTimer !== null) {
    clearInterval(recommendationPurgeTimer)
    recommendationPurgeTimer = null
  }
  if (consolidationTimer !== null) {
    clearInterval(consolidationTimer)
    consolidationTimer = null
  }
  // Local model (t54): release the worker + model memory on quit. Best-effort
  // (a disposed runtime is recreated on the next getLocalModelRuntime()).
  if (localModelRuntime !== null) {
    localModelRuntime.dispose().catch(() => {})
    localModelRuntime = null
  }
  evidenceUnsubscribe?.()
  evidenceUnsubscribe = null
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
 * AI-rationale trace store (t42) over the same SQLite handle as evidence
 * (trace table, spec 决策 8). Null when the DB failed to open — the trace UI
 * then degrades to the empty state. Reads are cheap; writes go through the
 * future trace recorder.
 */
export function getTraceStore(): TraceStore | null {
  return traceStore
}

/**
 * Recommendation history + cooldown (t46) over the same SQLite handle
 * (recommendation_history table, spec 决策 9); memory fallback when the DB
 * failed to open. initState() always assigns one of the two before the
 * suggestion timer starts, so engine/ledger callers never see null there.
 */
export function getRecommendationHistory(): RecommendationHistory | null {
  return recommendationHistory
}

/**
 * Memory graph handle (t48): null when trace.db failed to open (degrade path).
 * Exposed so settings:update can sync memoryLambda into the graph at runtime.
 */
export function getMemoryGraph(): MemoryGraphStore | null {
  return memoryGraph
}

/**
 * Episode consolidator（t49）单例：memoryGraph 可用（DB 健康）时惰性构建；
 * DB 故障 → null，不落库不整理，其余功能照常。
 */
export function getEpisodeConsolidator(): EpisodeConsolidator | null {
  if (episodeConsolidator === null && memoryGraph !== null) {
    episodeConsolidator = createEpisodeConsolidator({
      now: () => Date.now(),
      graph: memoryGraph,
      // 会话来源：TaskStore 内存会话（sqlite 落库经 attachSessionStore 同步），
      // 重启后经 load() 水合，两端覆盖。
      readSessions: () => taskStore.toDto().flatMap((t) => t.sessions ?? []),
      taskTitle: (taskId) => taskStore.get(taskId)?.title ?? '',
      // L0 证据材料（应用/窗口，无剪贴板正文）：episode 原始材料的一部分。
      readEvidence: (from, to) =>
        (evidenceStore?.query({ from, to, limit: MAX_EVIDENCE_QUERY_LIMIT }).map((e) => ({
          source: e.source,
          windowTitle: e.windowTitle
        })) ?? []),
      // AI 未接线（provider 未配置/未注入）→ 提取跳过；episode 落库照常（免费）。
      getExtractor: () => (suggestionChat ? createChatEpisodeExtractor(suggestionChat) : null),
      log: (entry) => logAi(entry)
    })
  }
  return episodeConsolidator
}

/**
 * 时段整理周期入口（t49）。隐私门：记忆写入主开关关（memoryEnabled）或 AI
 * 总开关关（aiEnabled）→ 整轮跳过——不花 LLM、不写事实；episode 保持
 * pending，门重开后下一触发自动补整理。失败静默（run 内部捕获，不抛）。
 */
function runConsolidation(): void {
  if (runtime.quitting) return
  const consolidator = getEpisodeConsolidator()
  if (consolidator === null) return
  const policy = policyFromSettings(loadSettings())
  if (!memoryAllowed(policy, {}).allowed || !aiAllowed(policy, {}).allowed) return
  void consolidator.run()
}

/**
 * Memory store singleton (t20). Lazily constructed so the IPC layer and the
 * suggestion engine can reach it without ordering constraints. Loaded once in
 * initState(); decay parameters track Settings at runtime (settings:update).
 */
export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore({
      // SQLite 图（t48）可用时经适配器落 facts 表；DB 故障降级回 memories.json
      // （迁移只在 DB 健康时发生，此时文件仍在）。
      load: () => (memoryGraph ? memoryIndexAdapter!.load() : loadMemoriesFile()),
      save: (index) => (memoryGraph ? memoryIndexAdapter!.save(index) : saveMemoriesFile(index)),
      // Every memory write lands in ai-log.jsonl (suggest/confirm/ban/…).
      log: (entry) => logAi(entry)
    })
  }
  return memoryStore
}

/**
 * ActivityLedger singleton (t40). Lazily constructed so the IPC layer can
 * reach it without ordering constraints; reads the evidence timeline (SQLite
 * in prod, in-memory fallback when the DB failed to open), the live task
 * list, the clustering settings and the ignored-signature table.
 */
export function getActivityLedger(): ActivityLedger {
  if (!activityLedger) {
    activityLedger = createActivityLedger({
      // initState() always assigns evidenceStore (SQLite or the in-memory
      // fallback) before the suggestion timer starts, so the ledger never
      // sees null here.
      evidence: evidenceStore!,
      getTasks: () => taskStore.list(),
      getParams: () => {
        const s = loadSettings()
        return {
          ...DEFAULT_SEGMENT_PARAMS,
          confidenceHigh: s.confidenceHigh,
          confidenceLow: s.confidenceLow
        }
      },
      ignored: createIgnoredTable({ load: loadIgnoredSignatures, save: saveIgnoredSignatures }),
      // t46 cooldown gate: 指纹在冷却期内（含已采纳的永久抑制）的活动本趟
      // 跳过。忽略 LRU 优先于冷却检查（ledger analyze 顺序），行为不回归。
      cooling: (fingerprint) => {
        const h = getRecommendationHistory()
        return h !== null && h.cooldownMs(fingerprint) > 0
      }
    })
  }
  return activityLedger
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
      ledger: getActivityLedger(),
      onSuggestions: (suggestions) => pushState.suggestions(suggestions),
      // Context-prior: only live project/workflow memories reach the engine.
      readMemories: () => getMemoryStore().list(),
      // Clipboard items copied during a segment ride along on the suggestion.
      readItem: (itemId) => store.get(itemId),
      // Observability: the pipeline's algorithm outputs land in ai-log.jsonl.
      log: (entry) => logAi(entry),
      // Privacy (t44): live policy for the denied-app candidacy filter.
      getPolicy: () => policyFromSettings(loadSettings()),
      // Privacy (t44): denied-app interceptions land in the trace store
      // (kind 'privacy') for the AI-rationale UI ("已被隐私政策过滤");
      // each record is its own decision chain. DB-degraded → dropped.
      recordPrivacy: (input) => {
        const trace = getTraceStore()
        if (!trace) return
        trace.append({
          decisionId: `privacy_${createId()}`,
          kind: 'privacy',
          payload: {
            reason: input.reason,
            access: input.access,
            appExePath: input.appExePath,
            contentType: input.contentType
          }
        })
      },
      // Feedback distillation: accepted suggestions become suggested
      // candidates. Privacy (t44): memoryEnabled=false blocks the automatic
      // write here at the caller — the pure store/graph never sees it.
      onMemorySuggestion: (candidate) => {
        if (!memoryAllowed(policyFromSettings(loadSettings()), {}).allowed) return
        getMemoryStore().suggestMemory({ ...candidate, source: 'task-feedback' })
      },
      // Recommendation history (t46): accept/ignore 记录与回填；DB 故障时用
      // 内存实现，冷却/模式学习本会话内仍生效。
      history: getRecommendationHistory() ?? undefined,
      // t47 评级接入（46 预留位注入）：真实分级 = proposalGrading 纯模块的
      // gradeProposal。引擎已把聚类证据、任务比对、模式学习得分与最近记录
      // （recommendationPatternKey 跨小时桶同类累积）组装进 LevelInput，
      // 此处即决策函数直通。缺省 L1 的旧行为只在不注入时存在（prod 始终注入）。
      getLevel: (input) => gradeProposal(input),
      // t47 匹配信号沉淀（spec 决策 9）：任务比对命中 → 既有 memoryGraph
      // addFact(type='pattern')，不碰 t50 的检索区。记忆主开关关 → 不写
      // （与 onMemorySuggestion 同门）；DB 故障降级（null）→ 丢弃。
      onPatternMatch: (match) => {
        if (!memoryAllowed(policyFromSettings(loadSettings()), {}).allowed) return
        const graph = getMemoryGraph()
        if (!graph) return
        graph.addFact({
          type: 'pattern',
          content: `${match.appCombination} → ${match.taskTitle}`,
          source: 'inferred',
          userState: 'suggested',
          intent: 'system-infer',
          entities: match.appNames.map((name) => ({ name, type: 'app' })),
          validAt: match.now,
          lastSeenAt: match.now
        })
      },
      // Local model candidate optimizer (t54, spec 决策 6/11): 候选后处理
      // 过滤 ≤3 / 标题草稿 / 排序。内部按设置与模型可用性逐次判定 — 关闭 /
      // 未就绪 / 失败一律返回 null，算法候选原样传递（不变量 H）。
      localModel: createLazyLocalModelOptimizer()
    })
  }
  return suggestionEngine
}

/** Wire the provider chain into the engine (index.ts, after registerIpc). */
export function setSuggestionChat(chat: ChatFn): void {
  suggestionChat = chat
  getSuggestionEngine().setChat(chat)
}

/** Wire the OCR capture into the engine (index.ts, after registerIpc). */
export function setSuggestionOcr(ocrFn: OcrFn): void {
  getSuggestionEngine().setOcr(ocrFn)
}

/* --------------------------- local model (t54) --------------------------- */

/** Local model manager singleton (t54); hydrated from persisted settings. */
export function getLocalModelManager(): LocalModelManager {
  if (!localModelManager) {
    localModelManager = new LocalModelManager({ baseDir: PATHS.modelsDir() })
    const s = loadSettings()
    if (s.localModelSource) localModelManager.selectSource(s.localModelSource)
    if (s.localModelManualPath) localModelManager.setManualPath(s.localModelManualPath)
  }
  return localModelManager
}

/** Local model runtime singleton (t53/54) over the worker-thread engine. */
export function getLocalModelRuntime(): LocalModelRuntime {
  if (!localModelRuntime) {
    localModelRuntime = new LocalModelRuntime({ engine: createWorkerModelEngine() })
  }
  return localModelRuntime
}

/** Drop the runtime singleton (removal / teardown): releases the model memory. */
export function resetLocalModelRuntime(): void {
  localModelRuntime = null
}

/**
 * Load the model into the runtime when it is enabled and the file is ready.
 * Idempotent (the runtime no-ops on the same target). Called at startup and
 * after any IPC transition that lands the manager in 'ready', so the first
 * optimization pass never stalls on a lazy load.
 */
export function ensureLocalModelLoaded(): void {
  const manager = getLocalModelManager()
  const { modelFilePath } = manager.status()
  if (!shouldLoadLocalModel(loadSettings().localModelEnabled === true, manager.status()) || modelFilePath === null) return
  getLocalModelRuntime()
    .load({ modelPath: modelFilePath, spec: manager.specOf() })
    .catch((err: unknown) => console.error(`[LocalModel] load failed: ${err instanceof Error ? err.message : String(err)}`))
}

/**
 * Candidate optimizer seam (t54, spec 决策 6/11): the production wrapper checks
 * the enable switch + manager readiness on every call, so a runtime settings
 * change (toggle / remove / manual path) takes effect without a restart. Any
 * failure degrades to `null` — the engine then passes the algorithm
 * candidates through unchanged (不变量 H: 功能等价, 绝不污染决策数据).
 */
export function createLazyLocalModelOptimizer(): CandidateOptimizer {
  return {
    async optimize(candidates) {
      const settings = loadSettings()
      if (!settings.localModelEnabled) return null
      const manager = getLocalModelManager()
      const status = manager.status()
      if (status.state !== 'ready' || !status.modelFilePath) return null
      const optimizer = createCandidateOptimizer({
        inferJson: (req) => getLocalModelRuntime().inferJson(req)
      })
      return optimizer.optimize(candidates)
    }
  }
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
