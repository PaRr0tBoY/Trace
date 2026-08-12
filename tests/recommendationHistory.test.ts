/**
 * t46 — 推荐历史模块 (spec 实现决策 9).
 *
 * Covers: 指纹稳定性（同活动重复生成同指纹）、分级冷却边界（L1 24h / L2 48h
 * / L3 7d + accepted 永久抑制）、record 回填语义（noop 行更新保留 shownAt）、
 * 忽略原因映射、pattern 学习权重（采纳增强 / 编辑最强 / 忽略按原因衰减 / 权重
 * 下限）、30 天清理联动（未采纳删除、已采纳保留）、SQLite 实现同语义（native
 * Binding ABI 缝）、以及 suggestionEngine accept/ignore 记录点 + ledger 冷却门
 * 的端到端行为。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACTION_REASON_DECAY,
  COOLDOWN_LEVEL_MS,
  cooldownRemainingMs,
  createMemoryRecommendationHistory,
  createSqliteRecommendationHistory,
  derivePatternScore,
  ignoreReasonToActionReason,
  PATTERN_WEIGHT_FLOOR,
  recommendationFingerprint,
  type PatternScore,
  type RecommendationHistory
} from '../electron/store/recommendationHistory'
import { createActivityLedger, DEFAULT_SEGMENT_PARAMS, suggestionSignature } from '../electron/store/activityLedger'
import { createIgnoredTable } from '../electron/main/ignored'
import { createMemoryEvidenceStore, evidenceFromUsageEvent, type EvidenceStore } from '../electron/store/evidenceStore'
import { createSuggestionEngine, type SuggestionEngine } from '../electron/main/suggestionEngine'
import { TaskStore } from '../electron/store/TaskStore'
import { openDatabase, closeDatabase, type TraceDatabase } from '../electron/store/db'
import type { AppSwitchEvent, RecommendationActionReason, RecommendationLevel, RecommendationRecord, TaskProposal, UsageEvent } from '../shared/types'

/** 固定基准时刻：2026-01-01 12:00 local。 */
const T0 = new Date(2026, 0, 1, 12, 0, 0, 0).getTime()
const MS_HOUR = 3_600_000
const MS_DAY = 86_400_000

/** 递增 id 生成器：断言顺序确定。 */
function counterId(): () => string {
  let n = 0
  return () => `rec-${n++}`
}

/* ------------------------------------------------------------------ */
/* 指纹稳定性                                                          */
/* ------------------------------------------------------------------ */

describe('recommendationFingerprint', () => {
  it('同活动重复生成同指纹（app 顺序无关，确定性）', () => {
    const keys = ['C:\\Apps\\Code.exe', 'c:/apps/chrome.exe']
    const a = recommendationFingerprint(keys, T0)
    const b = recommendationFingerprint(['c:/apps/chrome.exe', 'C:\\Apps\\Code.exe'], T0)
    expect(a).toBe(b)
    expect(a).toBe(recommendationFingerprint(keys, T0))
  })

  it('带 semantic@1 版本前缀，且与活动签名一一对应', () => {
    const keys = ['c:/apps/code.exe', 'c:/apps/chrome.exe']
    const fp = recommendationFingerprint(keys, T0)
    expect(fp).toBe(`semantic@1:${suggestionSignature(keys, T0)}`)
  })

  it('不同小时桶（时段）产生不同指纹', () => {
    const keys = ['c:/apps/code.exe', 'c:/apps/chrome.exe']
    expect(recommendationFingerprint(keys, T0)).not.toBe(recommendationFingerprint(keys, T0 + MS_HOUR))
  })

  it('不同应用集产生不同指纹', () => {
    expect(recommendationFingerprint(['c:/apps/code.exe'], T0)).not.toBe(
      recommendationFingerprint(['c:/apps/code.exe', 'c:/apps/chrome.exe'], T0)
    )
  })
})

/* ------------------------------------------------------------------ */
/* 分级冷却                                                            */
/* ------------------------------------------------------------------ */

describe('cooldown (L1 24h / L2 48h / L3 7d)', () => {
  const FP = 'semantic@1:abc'

  it('等级时长常量符合 spec 决策 9', () => {
    expect(COOLDOWN_LEVEL_MS[1]).toBe(24 * MS_HOUR)
    expect(COOLDOWN_LEVEL_MS[2]).toBe(48 * MS_HOUR)
    expect(COOLDOWN_LEVEL_MS[3]).toBe(7 * MS_DAY)
  })

  it('L1 未采纳冷却 24h，边界处清零', () => {
    let now = T0
    const h = createMemoryRecommendationHistory({ now: () => now, createId: counterId() })
    h.record({ fingerprint: FP, level: 1, outcome: 'noop' })
    expect(h.cooldownMs(FP)).toBe(24 * MS_HOUR)
    // 23h 后仍有 1h 剩余。
    now = T0 + 23 * MS_HOUR
    expect(cooldownRemainingMs(h.list(), now)).toBe(MS_HOUR)
    expect(h.cooldownMs(FP)).toBe(MS_HOUR)
    // 恰好在终点：剩余 0。
    now = T0 + 24 * MS_HOUR
    expect(cooldownRemainingMs(h.list(), now)).toBe(0)
    expect(h.cooldownMs(FP)).toBe(0)
  })

  it('L2 忽略冷却 48h / L3 同类 7 天', () => {
    for (const [level, duration] of [
      [2, 48 * MS_HOUR],
      [3, 7 * MS_DAY]
    ] as const) {
      let now = T0
      const h = createMemoryRecommendationHistory({ now: () => now, createId: counterId() })
      h.record({ fingerprint: FP, level, outcome: 'ignored', actionReason: 'not_now' })
      expect(h.cooldownMs(FP)).toBe(duration)
      now = T0 + duration - 1
      expect(cooldownRemainingMs(h.list(), now)).toBe(1)
      now = T0 + duration
      expect(cooldownRemainingMs(h.list(), now)).toBe(0)
    }
  })

  it('多条记录取最大剩余', () => {
    let now = T0
    const h = createMemoryRecommendationHistory({ now: () => now, createId: counterId() })
    h.record({ fingerprint: FP, level: 1, outcome: 'ignored', actionReason: 'not_now' }) // 终点 T0+24h
    now = T0 + 10 * MS_HOUR
    h.record({ fingerprint: FP, level: 2, outcome: 'ignored', actionReason: 'not_now' }) // 终点 T0+58h
    now = T0 + 20 * MS_HOUR
    expect(h.cooldownMs(FP)).toBe(48 * MS_HOUR - 10 * MS_HOUR) // 38h：较新 L2 主导
  })

  it('accepted 记录永久抑制（Infinity），不受时长限制', () => {
    const h = createMemoryRecommendationHistory({ now: () => T0, createId: counterId() })
    h.record({ fingerprint: FP, level: 1, outcome: 'accepted', actionReason: 'user_confirmed' })
    expect(h.cooldownMs(FP)).toBe(Infinity)
    expect(h.cooldownMs(FP)).toBe(Infinity)
  })

  it('无记录 / 冷却已过 返回 0', () => {
    const h = createMemoryRecommendationHistory({ now: () => T0, createId: counterId() })
    expect(h.cooldownMs(FP)).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* 记录与回填                                                          */
/* ------------------------------------------------------------------ */

describe('record / backfill', () => {
  const FP = 'semantic@1:abc'

  it('先落 noop 行，accept/ignore 回填同一行（保留原 shownAt）', () => {
    let now = T0
    const h = createMemoryRecommendationHistory({ now: () => now, createId: counterId() })
    const open = h.record({ fingerprint: FP, level: 1 })
    expect(open.outcome).toBe('noop')
    expect(open.shownAt).toBe(T0)

    now = T0 + 5 * MS_HOUR
    const resolved = h.record({ fingerprint: FP, level: 1, outcome: 'ignored', actionReason: 'already_exists' })
    expect(resolved.id).toBe(open.id) // 回填同一条
    expect(resolved.shownAt).toBe(T0) // 原展示时刻保留
    expect(resolved.outcome).toBe('ignored')
    expect(resolved.actionReason).toBe('already_exists')
    expect(h.size()).toBe(1)
  })

  it('无未决行时插入新行（v1 引擎直接在 accept/ignore 落终态）', () => {
    const h = createMemoryRecommendationHistory({ now: () => T0, createId: counterId() })
    h.record({ fingerprint: FP, level: 1, outcome: 'ignored', actionReason: 'not_now' })
    const second = h.record({ fingerprint: FP, level: 1, outcome: 'ignored', actionReason: 'wrong_task' })
    expect(second.id).not.toBe('rec-0')
    expect(h.size()).toBe(2)
  })

  it('忽略原因 → spec actionReason 映射', () => {
    expect(ignoreReasonToActionReason('not_interested')).toBe('user_manually_dismissed')
    expect(ignoreReasonToActionReason('duplicate')).toBe('already_exists')
    expect(ignoreReasonToActionReason('wrong_task')).toBe('wrong_task')
    expect(ignoreReasonToActionReason('not_now')).toBe('not_now')
  })

  it('record 无 outcome 时默认 noop', () => {
    const h = createMemoryRecommendationHistory({ now: () => T0, createId: counterId() })
    const r = h.record({ fingerprint: FP, level: 2 })
    expect(r.outcome).toBe('noop')
  })
})

/* ------------------------------------------------------------------ */
/* Pattern 学习（意图五档权重）                                        */
/* ------------------------------------------------------------------ */

describe('pattern learning', () => {
  const FP = 'semantic@1:abc'
  const rec = (
    outcome: 'accepted' | 'ignored' | 'dismissed' | 'noop' | undefined,
    actionReason?: RecommendationActionReason,
    at = T0
  ): RecommendationRecord => ({
    id: `r-${at}`,
    fingerprint: FP,
    level: 1,
    shownAt: at,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(actionReason !== undefined ? { actionReason } : {})
  })

  function score(records: RecommendationRecord[]): PatternScore {
    return derivePatternScore(FP, records)
  }

  it('采纳增强：adopt-suggestion 0.7', () => {
    const s = score([rec('accepted', 'user_confirmed')])
    expect(s.intent).toBe('adopt-suggestion')
    expect(s.weight).toBeCloseTo(0.7)
    expect(s.accepts).toBe(1)
    expect(s.ignores).toBe(0)
  })

  it('用户编辑标题是最强信号：user-edit 1.0，且主导后续忽略', () => {
    const s = score([rec('accepted', 'user_edited_title')])
    expect(s.intent).toBe('user-edit')
    expect(s.weight).toBe(1)
    // 最强信号主导意图；忽略按原因衰减权重但不动意图档。
    const s2 = score([rec('accepted', 'user_edited_title'), rec('ignored', 'not_now', T0 + 1)])
    expect(s2.intent).toBe('user-edit')
    expect(s2.weight).toBeCloseTo(0.8)
  })

  it('先编辑标题后普通采纳：意图保持 user-edit（权重主导，不降档）', () => {
    const s = score([
      rec('accepted', 'user_edited_title', T0),
      rec('accepted', 'user_confirmed', T0 + 1)
    ])
    expect(s.intent).toBe('user-edit')
    expect(s.weight).toBe(1) // max(1.0, 0.7)
    // 反向顺序：普通采纳后编辑 → 升级到 user-edit。
    const s2 = score([
      rec('accepted', 'user_confirmed', T0),
      rec('accepted', 'user_edited_title', T0 + 1)
    ])
    expect(s2.intent).toBe('user-edit')
  })

  it('忽略按 actionReason 衰减：wrong_task < duplicate < 不感兴趣 < not_now', () => {
    const expectedByReason: Array<{ actionReason: RecommendationActionReason; expected: number }> = [
      { actionReason: 'wrong_task', expected: 0.5 * ACTION_REASON_DECAY.wrong_task }, // 0.1
      { actionReason: 'already_exists', expected: 0.5 * ACTION_REASON_DECAY.already_exists }, // 0.2
      { actionReason: 'user_manually_dismissed', expected: 0.5 * ACTION_REASON_DECAY.user_manually_dismissed }, // 0.25
      { actionReason: 'not_now', expected: 0.5 * ACTION_REASON_DECAY.not_now } // 0.4
    ]
    for (const { actionReason, expected } of expectedByReason) {
      const s = score([rec('ignored', actionReason)])
      expect(s.ignores).toBe(1)
      expect(s.weight).toBeCloseTo(expected, 5)
    }
    // 单次忽略彼此可区分（下限不吞掉原因差异）。
    const weights = expectedByReason.map((e) => e.expected)
    expect(new Set(weights).size).toBe(weights.length)
    // 衰减系数按 spec 顺序排列：错任务最狠、暂不想处理最轻。
    expect(ACTION_REASON_DECAY.wrong_task).toBeLessThan(ACTION_REASON_DECAY.already_exists)
    expect(ACTION_REASON_DECAY.already_exists).toBeLessThan(ACTION_REASON_DECAY.user_manually_dismissed)
    expect(ACTION_REASON_DECAY.user_manually_dismissed).toBeLessThan(ACTION_REASON_DECAY.not_now)
  })

  it('无原因忽略按 0.5 衰减；dismissed ×0.6；连续衰减撞下限 0.05', () => {
    expect(score([rec('ignored')]).weight).toBeCloseTo(0.25)
    expect(score([rec('dismissed')]).weight).toBeCloseTo(0.3)
    // 单次 wrong_task：0.5×0.2=0.1，高于下限。
    expect(score([rec('ignored', 'wrong_task')]).weight).toBeCloseTo(0.1)
    // 三次 not_now：0.5×0.8³=0.256；三次 wrong_task：0.004 → 下限 0.05。
    expect(score([rec('ignored', 'not_now', T0), rec('ignored', 'not_now', T0 + 1), rec('ignored', 'not_now', T0 + 2)]).weight).toBeCloseTo(0.256)
    const heavy = score([rec('ignored', 'wrong_task', T0), rec('ignored', 'wrong_task', T0 + 1), rec('ignored', 'wrong_task', T0 + 2)])
    expect(heavy.weight).toBe(PATTERN_WEIGHT_FLOOR)
  })

  it('先忽略后采纳：采纳提升权重并接管意图', () => {
    const s = score([rec('ignored', 'not_now', T0), rec('accepted', 'user_confirmed', T0 + 1)])
    expect(s.intent).toBe('adopt-suggestion')
    expect(s.weight).toBeCloseTo(0.7) // max(0.4, 0.7)
  })

  it('noop 记录不产生信号', () => {
    const s = score([rec('noop'), rec('noop', undefined, T0 + 1)])
    expect(s.intent).toBe('system-infer')
    expect(s.weight).toBeCloseTo(0.5)
    expect(s.accepts).toBe(0)
    expect(s.ignores).toBe(0)
  })

  it('store 的 patternScore 按指纹查询', () => {
    const h = createMemoryRecommendationHistory({ now: () => T0, createId: counterId() })
    h.record({ fingerprint: FP, level: 1, outcome: 'accepted', actionReason: 'user_edited_title' })
    const s = h.patternScore(FP)
    expect(s.intent).toBe('user-edit')
    expect(s.weight).toBe(1)
    expect(h.patternScore('semantic@1:other').weight).toBeCloseTo(0.5)
  })
})

/* ------------------------------------------------------------------ */
/* 清理联动：未采纳 30 天清，已采纳保留                                 */
/* ------------------------------------------------------------------ */

describe('cleanupBefore', () => {
  const FP = 'semantic@1:abc'

  it('删除未采纳（含无 outcome 的 noop 行）且早于 cutoff 的记录，已采纳保留', () => {
    let now = T0
    const h = createMemoryRecommendationHistory({ now: () => now, createId: counterId() })
    h.record({ fingerprint: FP, level: 1, outcome: 'ignored', actionReason: 'not_now' }) // shownAt T0，未采纳
    now = T0 + 1000
    h.record({ fingerprint: FP, level: 1, outcome: 'accepted', actionReason: 'user_confirmed' }) // 已采纳
    now = T0 + 2000
    h.record({ fingerprint: 'semantic@1:other', level: 1 }) // noop，未采纳但新鲜（不同指纹避免回填）

    expect(h.cleanupBefore(T0 + 1500)).toBe(1)
    expect(h.size()).toBe(2) // accepted + 新鲜 noop
    expect(h.list().every((r) => r.outcome === 'accepted' || r.shownAt >= T0 + 1500)).toBe(true)
  })

  it('cutoff 边界：shownAt < ts 严格小于（恰等于不删）', () => {
    const h = createMemoryRecommendationHistory({ now: () => T0, createId: counterId() })
    h.record({ fingerprint: FP, level: 1, outcome: 'ignored', actionReason: 'not_now' }) // shownAt = T0
    expect(h.cleanupBefore(T0)).toBe(0) // 恰等于 cutoff，保留
    expect(h.cleanupBefore(T0 + 1)).toBe(1) // 严格小于 cutoff，删除
    expect(h.size()).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* SQLite 实现（nativeBinding ABI 缝，如 tests/db.test.ts）            */
/* ------------------------------------------------------------------ */

const CACHED_NODE_BINDING = join(process.cwd(), 'node_modules', '.cache', 'better-sqlite3-node', 'better_sqlite3.node')

function isAbiMismatch(e: unknown): e is Error {
  return e instanceof Error && e.message.includes('NODE_MODULE_VERSION')
}

function openTestDb(filePath: string): TraceDatabase {
  try {
    return openDatabase(filePath)
  } catch (e) {
    if (!isAbiMismatch(e)) throw e
    if (!existsSync(CACHED_NODE_BINDING)) {
      throw new Error(`better-sqlite3 ABI mismatch and no cached Node build at ${CACHED_NODE_BINDING}`)
    }
    return openDatabase(filePath, { nativeBinding: CACHED_NODE_BINDING })
  }
}

const openDbs: TraceDatabase[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const db of openDbs) closeDatabase(db)
  openDbs.length = 0
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('createSqliteRecommendationHistory — recommendation_history 表持久化', () => {
  const FP = 'semantic@1:abc'

  it('record / cooldown / pattern / cleanup 与 memory 实现同语义，并跨实例回读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-history-'))
    tempDirs.push(dir)
    const db = openTestDb(join(dir, 'trace.db'))
    openDbs.push(db)

    let now = T0
    const store1 = createSqliteRecommendationHistory(db, { now: () => now, createId: counterId() })
    store1.record({ fingerprint: FP, level: 1, outcome: 'ignored', actionReason: 'wrong_task' })
    now = T0 + MS_HOUR
    store1.record({ fingerprint: FP, level: 2, outcome: 'accepted', actionReason: 'user_edited_title' })

    // 跨实例回读（同一 DB）。
    const store2 = createSqliteRecommendationHistory(db)
    const rows = store2.list()
    expect(rows).toHaveLength(2)
    expect(rows[0].outcome).toBe('accepted')
    expect(rows[0].actionReason).toBe('user_edited_title')
    expect(rows[0].shownAt).toBe(T0 + MS_HOUR)

    // 已采纳 → 永久冷却。
    expect(store2.cooldownMs(FP)).toBe(Infinity)
    const s = store2.patternScore(FP)
    expect(s.intent).toBe('user-edit')
    expect(s.weight).toBe(1)
  })

  it('回填路径：noop 行更新而非插入（SQLite 同语义）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-history-'))
    tempDirs.push(dir)
    const db = openTestDb(join(dir, 'trace.db'))
    openDbs.push(db)

    let now = T0
    const store = createSqliteRecommendationHistory(db, { now: () => now, createId: counterId() })
    const open = store.record({ fingerprint: FP, patternKey: 'semantic@1:pk-a', level: 1 })
    expect(open.outcome).toBe('noop') // 无 outcome 统一落 noop（与 memory 同形状）
    now = T0 + 1000
    const resolved = store.record({ fingerprint: FP, patternKey: 'semantic@1:pk-b', level: 1, outcome: 'ignored', actionReason: 'not_now' })
    expect(resolved.id).toBe(open.id)
    expect(resolved.shownAt).toBe(T0)
    expect(resolved.patternKey).toBe('semantic@1:pk-b') // 回填同步更新 patternKey（与 memory 同形状）
    expect(store.size()).toBe(1)
    // 跨实例回读：回填后的 patternKey 落库可见。
    const rereadResolved = createSqliteRecommendationHistory(db).list().find((r) => r.id === resolved.id)
    expect(rereadResolved?.patternKey).toBe('semantic@1:pk-b')
    // 形状一致：无 outcome 的记录统一落 noop（memory 与 SQLite 同形状），
    // 跨实例 list 回读仍是 noop 而非 undefined。
    const bare = store.record({ fingerprint: 'semantic@1:other-fp', level: 1 })
    expect(bare.outcome).toBe('noop')
    const reread = createSqliteRecommendationHistory(db).list().find((r) => r.id === bare.id)
    expect(reread?.outcome).toBe('noop')
  })

  it('cleanupBefore 物理删除未采纳行，已采纳保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-history-'))
    tempDirs.push(dir)
    const db = openTestDb(join(dir, 'trace.db'))
    openDbs.push(db)

    let now = T0
    const store = createSqliteRecommendationHistory(db, { now: () => now, createId: counterId() })
    store.record({ fingerprint: FP, level: 1, outcome: 'ignored', actionReason: 'not_now' })
    now = T0 + 1000
    store.record({ fingerprint: FP, level: 1, outcome: 'accepted', actionReason: 'user_confirmed' })
    now = T0 + 2000
    store.record({ fingerprint: 'semantic@1:other', level: 1, outcome: 'ignored', actionReason: 'duplicate' })

    expect(store.cleanupBefore(T0 + 1500)).toBe(1)
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM recommendation_history').get() as { n: number }
    expect(remaining.n).toBe(2)
    expect(store.list().map((r) => r.outcome)).toEqual(['ignored', 'accepted']) // newest first
  })
})

/* ------------------------------------------------------------------ */
/* 引擎记录点（accept/ignore） + ledger 冷却门端到端                    */
/* ------------------------------------------------------------------ */

function ev(appName: string, ts: number, title = ''): AppSwitchEvent {
  return {
    type: 'app-switch',
    appName,
    exePath: `C:\\Apps\\${appName.toLowerCase()}.exe`,
    pid: 1,
    windowTitle: title,
    ts
  }
}

/** 5 events, one segment (1s gaps < transientMs 2.5s), spread over 4s. */
function batch(base = 10_000): UsageEvent[] {
  return [
    ev('Code', base),
    ev('Code', base + 1_000, 'report.md — Code'),
    ev('Chrome', base + 2_000, 'docs.example.com'),
    ev('Chrome', base + 3_000),
    ev('Code', base + 4_000)
  ]
}

const SIG = suggestionSignature(['c:/apps/chrome.exe', 'c:/apps/code.exe'], 10_000)
const FP_SIG = recommendationFingerprint(['c:/apps/chrome.exe', 'c:/apps/code.exe'], 10_000)

interface EngineHarness {
  engine: SuggestionEngine
  store: TaskStore
  events: UsageEvent[]
  evidence: EvidenceStore
  now: number
  history: RecommendationHistory
  ignored: ReturnType<typeof createIgnoredTable>
  pushed: TaskProposal[][]
  /** 测试注入的分级，按确定性指纹查（t47 LevelInput）。 */
  levels: Record<string, RecommendationLevel>
}

function makeEngineHarness(): EngineHarness {
  const h: EngineHarness = {
    events: [],
    now: 1_000_000,
    evidence: createMemoryEvidenceStore(),
    history: createMemoryRecommendationHistory({
      now: () => h.now,
      createId: () => `hist-${Math.random().toString(36).slice(2)}`
    }),
    ignored: createIgnoredTable({ load: () => null, save: () => {} }),
    pushed: [],
    levels: {},
    store: new TaskStore({ load: () => null, save: () => {} })
  }
  h.engine = createSuggestionEngine({
    now: () => h.now,
    readEvents: () => h.events,
    store: h.store,
    getSettings: () => ({ suggestionMinEvents: 5, suggestionSilenceSeconds: 60 }),
    ledger: createActivityLedger({
      evidence: h.evidence,
      getTasks: () => h.store.list(),
      getParams: () => ({ ...DEFAULT_SEGMENT_PARAMS, confidenceHigh: 0.7, confidenceLow: 0.45 }),
      ignored: h.ignored,
      cooling: (fingerprint) => h.history.cooldownMs(fingerprint) > 0
    }),
    onSuggestions: (sugs) => h.pushed.push(sugs),
    history: h.history,
    // t47 LevelInput：按确定性指纹查测试注入的分级（展示时经 getLevel 落库）。
    getLevel: (input) => h.levels[input.fingerprint] ?? 1
  })
  return h
}

async function trigger(h: EngineHarness, events: UsageEvent[], silenceMs = 60_000): Promise<void> {
  h.events.push(...events)
  for (const e of events) h.evidence.record(evidenceFromUsageEvent(e))
  h.now = events[events.length - 1].ts + silenceMs
  await h.engine.tick()
}

describe('engine record points (t46)', () => {
  it('accept 记录 accepted + user_confirmed，指纹 = 语义指纹', async () => {
    const h = makeEngineHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id)

    const rows = h.history.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].fingerprint).toBe(FP_SIG)
    expect(rows[0].outcome).toBe('accepted')
    expect(rows[0].actionReason).toBe('user_confirmed')
    expect(rows[0].level).toBe(1)
    expect(h.history.cooldownMs(FP_SIG)).toBe(Infinity)
  })

  it('accept 带用户编辑标题 → user_edited_title（最强信号）', async () => {
    const h = makeEngineHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id, { title: 'My own title' })

    const rows = h.history.list()
    expect(rows[0].actionReason).toBe('user_edited_title')
    expect(h.history.patternScore(FP_SIG).intent).toBe('user-edit')
    expect(h.history.patternScore(FP_SIG).weight).toBe(1)
  })

  it('accept 与建议同标题（无实际编辑）仍记 user_confirmed', async () => {
    const h = makeEngineHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id, { title: s.title })
    expect(h.history.list()[0].actionReason).toBe('user_confirmed')
  })

  it('ignore 记录 ignored + 原因映射，且既有 LRU 行为不回归', async () => {
    const h = makeEngineHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(h.engine.ignore(s.id, 'duplicate')).toBe(true)

    const rows = h.history.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('ignored')
    expect(rows[0].actionReason).toBe('already_exists')
    // 忽略 LRU 照常写入。
    expect(h.ignored.has(SIG)).toBe(true)
  })

  it('ignore 无原因 → user_manually_dismissed（不感兴趣）', async () => {
    const h = makeEngineHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.ignore(s.id)
    expect(h.history.list()[0].actionReason).toBe('user_manually_dismissed')
  })

  it('getLevel 注入的分级随记录落库（t47：展示时分级，noop 先行、动作回填保持）', async () => {
    const h = makeEngineHarness()
    // t47 语义：分级在展示时（runAnalysis 尾部）经 getLevel 产出，随 noop
    // 记录落 RecommendationRecord.level；accept/ignore 回填保持展示分级。
    h.levels[FP_SIG] = 2
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    expect(s.level).toBe(2)
    const shown = h.history.list()[0]
    expect(shown.level).toBe(2)
    expect(shown.outcome).toBe('noop')
    h.engine.ignore(s.id, 'not_now')
    const resolved = h.history.list()[0]
    expect(resolved.level).toBe(2)
    expect(resolved.outcome).toBe('ignored')
  })

  it('冷却门：忽略后同指纹（同小时桶）的下一趟分析被抑制', async () => {
    const h = makeEngineHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.ignore(s.id, 'not_now') // L1 24h 冷却

    // 同小时桶的新批次（2_000_000 → hour 0，与 10_000 同桶）。
    h.events = []
    await trigger(h, batch(2_000_000))
    // [suggestions, ignore(), 第二次 pass] — 第二次被冷却门压空。
    expect(h.pushed).toHaveLength(3)
    expect(h.pushed[2]).toHaveLength(0)
  })

  it('冷却门：accepted 指纹同桶永不重推', async () => {
    const h = makeEngineHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.accept(s.id)

    h.events = []
    await trigger(h, batch(2_000_000))
    expect(h.pushed[2]).toHaveLength(0)
  })

  it('冷却结束后的新活动（同应用组合）可再次建议', async () => {
    const h = makeEngineHarness()
    h.engine.start()
    await trigger(h, batch())
    const [s] = h.pushed[0]
    h.engine.ignore(s.id, 'not_now')

    // 冷却期过后，同一小时内桶再次出现（下一小时桶 = 新会话，指纹不同）。
    h.events = []
    await trigger(h, batch(2_000_000 + MS_HOUR))
    expect(h.pushed[2].length).toBeGreaterThan(0)
  })

  it('无 history 选项时 accept/ignore 行为与既有版本一致', async () => {
    const h = makeEngineHarness()
    // 重新构造不带 history 的引擎（既有测试形态）。
    const bare = createSuggestionEngine({
      now: () => h.now,
      readEvents: () => h.events,
      store: h.store,
      getSettings: () => ({ suggestionMinEvents: 5, suggestionSilenceSeconds: 60 }),
      ledger: createActivityLedger({
        evidence: h.evidence,
        getTasks: () => h.store.list(),
        getParams: () => ({ ...DEFAULT_SEGMENT_PARAMS, confidenceHigh: 0.7, confidenceLow: 0.45 }),
        ignored: h.ignored
      }),
      onSuggestions: (sugs) => h.pushed.push(sugs)
    })
    bare.start()
    await trigger({ ...h, engine: bare }, batch())
    const [s] = h.pushed[0]
    expect(bare.accept(s.id)).toBeTruthy()
    expect(bare.ignore('s_unknown')).toBe(false)
    expect(h.history.size()).toBe(0)
  })
})
