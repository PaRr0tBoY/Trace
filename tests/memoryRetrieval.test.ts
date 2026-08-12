/**
 * t50 — 记忆检索（spec 实现决策 10 / 用户故事 27、28）。
 *
 * Covers: 确定性预筛四要素（活动 / 时间窗 / 实体 / 相关性命中，非 Top-K、
 * 无 embedding）、validNow 时间过滤、关系扩散（默认 1-hop / 2-hop 上限强制、
 * 命中路径与 hop 数）、排序 = 权重 × 时间有效性（检索时重算）、trace 记录
 * （kind='recall'，payload 含路径与原因）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeDatabase, openDatabase, type TraceDatabase } from '../electron/store/db'
import {
  clampMaxHops,
  createSqliteMemoryGraph,
  DEFAULT_MAX_HOPS,
  DEFAULT_RETRIEVAL_USER_STATES,
  diffuseHits,
  HIT_REASONS,
  MAX_HOPS_CAP,
  normalizeContent,
  rankHits,
  recordMemoryRecall,
  seedReasonsFor,
  windowsOverlap,
  type FactRecord,
  type HitReason,
  type MemoryGraphStore,
  type MemoryHit,
  type SeedMatchContext
} from '../electron/store/memoryGraph'
import { createMemoryTraceStore, type TraceRecallPayload } from '../electron/store/traceStore'

/** The installed better-sqlite3 addon may target a different runtime ABI than
 * the test runner's Node; fall back to the cached Node-ABI prebuild (same
 * seam as tests/db.test.ts / tests/memoryGraph.test.ts). */
const CACHED_NODE_BINDING = join(process.cwd(), 'node_modules', '.cache', 'better-sqlite3-node', 'better_sqlite3.node')

function isAbiMismatch(e: unknown): e is Error {
  return e instanceof Error && e.message.includes('NODE_MODULE_VERSION')
}

function openForTest(filePath: string): TraceDatabase {
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

/** Temp-file harness: 注入时钟 + 固定 λ = 0.25（与默认设置同源）。 */
interface Harness {
  db: TraceDatabase
  graph: MemoryGraphStore
  filePath: string
  now: number
}

const openDbs: TraceDatabase[] = []
const tempDirs: string[] = []

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'trace-memret-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'trace.db')
  const db = openForTest(filePath)
  openDbs.push(db)
  const h: Harness = { db, graph: undefined as never, filePath, now: 1_000_000 }
  h.graph = createSqliteMemoryGraph(db, { now: () => h.now, lambda: 0.25 })
  return h
}

afterEach(() => {
  for (const db of openDbs) closeDatabase(db)
  openDbs.length = 0
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

/** 一条基础事实（user-create = 0.9，fresh）。 */
function baseFact(over: Partial<FactRecord> = {}): FactRecord {
  return {
    id: 'f_1',
    type: 'profile',
    content: '用户所在城市是北京',
    source: 'inferred',
    userState: 'confirmed',
    intent: 'user-create',
    weight: 0.9,
    episodeId: null,
    entityIds: null,
    validAt: null,
    invalidAt: null,
    expiredAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    hitCount: 0,
    lastSeenAt: 1_000,
    ...over
  }
}

/** 空种子匹配上下文（各路由默认关闭）；活动键按组装方契约归一化一次。 */
function seedCtx(over: Partial<SeedMatchContext> = {}): SeedMatchContext {
  return {
    ...{
      activityKeys: [],
      entityIds: new Set<string>(),
      entityNameById: new Map<string, string>(),
      windowStart: null,
      windowEnd: null,
      episodeId: null
    },
    ...over,
    activityKeys: (over.activityKeys ?? []).map(normalizeContent)
  }
}

describe('memoryRetrieval — 确定性预筛四要素（纯函数）', () => {
  it('活动匹配：app / 窗口 / 内容键归一化子串命中 content', () => {
    const fact = baseFact({ content: '用户常开 Figma 做界面设计', entityIds: ['ent_1'] })
    expect(seedReasonsFor(fact, seedCtx({ activityKeys: ['Figma'] }))).toEqual(['activity'])
    // 窗口标题键：content 不含完整标题，但实体名 Figma 是其子串 → 双向包含命中
    expect(seedReasonsFor(fact, seedCtx({ activityKeys: ['Figma - Untitled'], entityNameById: new Map([['ent_1', 'Figma']]) }))).toEqual(['activity'])
    expect(seedReasonsFor(fact, seedCtx({ activityKeys: ['Blender'] }))).toEqual([])
    // 单字符键不参与；单字符实体名不做反向包含（避免 "excel" ⊇ "x" 假阳性）
    expect(seedReasonsFor(baseFact({ content: 'excel 表格' }), seedCtx({ activityKeys: ['x'] }))).toEqual([])
  })

  it('活动匹配：键子串命中所挂实体名', () => {
    const fact = baseFact({ content: '用户所在城市是北京', entityIds: ['ent_1'] })
    const ctx = seedCtx({ activityKeys: ['北京'], entityNameById: new Map([['ent_1', '北京']]) })
    expect(seedReasonsFor(fact, ctx)).toEqual(['activity'])
  })

  it('时间窗：事实窗口与查询时段重叠（null = 无界）', () => {
    expect(windowsOverlap(100, 200, 150, 300)).toBe(true)
    expect(windowsOverlap(100, 200, 300, 400)).toBe(false)
    expect(windowsOverlap(null, null, 150, 300)).toBe(true)
    expect(windowsOverlap(100, 200, null, null)).toBe(true)
    expect(seedReasonsFor(baseFact({ validAt: 100, expiredAt: 200 }), seedCtx({ windowStart: 150, windowEnd: 300 }))).toEqual(['time-window'])
    expect(seedReasonsFor(baseFact({ validAt: 100, expiredAt: 200 }), seedCtx({ windowStart: 300, windowEnd: 400 }))).toEqual([])
    // 无查询时段 → 路由关闭；恒有效事实（无窗口）不走时间窗路由
    expect(seedReasonsFor(baseFact({ validAt: 100 }), seedCtx())).toEqual([])
    expect(seedReasonsFor(baseFact(), seedCtx({ windowStart: 150, windowEnd: 300 }))).toEqual([])
  })

  it('实体命中：主语/宾语（实体 id 交集）', () => {
    const fact = baseFact({ entityIds: ['ent_1', 'ent_2'] })
    expect(seedReasonsFor(fact, seedCtx({ entityIds: new Set(['ent_2']) }))).toEqual(['entity'])
    expect(seedReasonsFor(fact, seedCtx({ entityIds: new Set(['ent_9']) }))).toEqual([])
  })

  it('相关性命中：来源链同 episode 的姊妹事实', () => {
    const fact = baseFact({ episodeId: 'ep_1' })
    expect(seedReasonsFor(fact, seedCtx({ episodeId: 'ep_1' }))).toEqual(['related'])
    expect(seedReasonsFor(fact, seedCtx({ episodeId: 'ep_2' }))).toEqual([])
  })

  it('多要素同时命中按规范顺序返回；无命中 = 空数组', () => {
    const fact = baseFact({ content: '用户常开 Figma 做设计', entityIds: ['ent_1'], episodeId: 'ep_1', validAt: 100, expiredAt: 200 })
    const ctx = seedCtx({ activityKeys: ['figma'], entityIds: new Set(['ent_1']), windowStart: 150, windowEnd: 300, episodeId: 'ep_1' })
    expect(seedReasonsFor(fact, ctx)).toEqual(['activity', 'time-window', 'entity', 'related'])
    expect(seedReasonsFor(baseFact(), seedCtx())).toEqual([])
    expect(HIT_REASONS).toEqual(['activity', 'time-window', 'entity', 'related'])
  })
})

describe('memoryRetrieval — store 集成（预筛 + validNow 过滤）', () => {
  it('活动键命中 content；无命中返回空结果', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: '用户常开 Figma 做界面设计', source: 'user', userState: 'confirmed' })
    const r = h.graph.retrieveMemories({ activityKeys: ['figma'] })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.reasons).toEqual(['activity'])
    expect(r.seedCount).toBe(1)
    expect(h.graph.retrieveMemories({ activityKeys: ['blender'] }).hits).toHaveLength(0)
  })

  it('entityNames 解析为实体 id 命中（任 type）', () => {
    const h = makeHarness()
    h.graph.ensureEntity('Figma', 'app')
    h.graph.addFact({ type: 'profile', content: '用户常用设计工具', source: 'user', userState: 'confirmed', entities: [{ name: 'Figma', type: 'app' }] })
    const r = h.graph.retrieveMemories({ entityNames: ['figma'] })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.reasons).toEqual(['entity'])
  })

  it('时间窗命中：带窗口事实与当前时段重叠', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'pattern', content: '本周排期已定', source: 'user', userState: 'confirmed', validAt: 900_000, expiredAt: 1_100_000 })
    h.graph.addFact({ type: 'pattern', content: '上周排期', source: 'user', userState: 'confirmed', validAt: 100_000, expiredAt: 300_000 })
    const r = h.graph.retrieveMemories({ windowStart: 950_000, windowEnd: 1_050_000 })
    expect(r.hits.map((x) => x.fact.content)).toEqual(['本周排期已定'])
    expect(r.hits[0]!.reasons).toEqual(['time-window'])
    // 恒有效事实不因时间窗路由成为种子
    h.graph.addFact({ type: 'profile', content: '用户常开 Figma', source: 'user', userState: 'confirmed' })
    expect(h.graph.retrieveMemories({ windowStart: 950_000, windowEnd: 1_050_000 }).hits).toHaveLength(1)
  })

  it('相关性命中：同 episode 姊妹事实', () => {
    const h = makeHarness()
    const ep = h.graph.addEpisode({ content: '当前会话' })
    h.graph.addFact({ type: 'task', content: '本会话产生的任务记忆', source: 'inferred', userState: 'suggested', episodeId: ep.id })
    h.graph.addFact({ type: 'profile', content: '无关事实', source: 'user', userState: 'confirmed' })
    const r = h.graph.retrieveMemories({ episodeId: ep.id })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.reasons).toEqual(['related'])
  })

  it('validNow 时间过滤：失效 / 过期 / 未开始事实不进入结果', () => {
    const h = makeHarness()
    h.graph.putFact({ id: 'f_dead', type: 'pattern', content: '失效模式 figma', source: 'user', userState: 'confirmed', invalidAt: 900_000, createdAt: 800_000 })
    h.graph.putFact({ id: 'f_expired', type: 'pattern', content: '过期模式 figma', source: 'user', userState: 'confirmed', expiredAt: 900_000, createdAt: 800_000 })
    h.graph.putFact({ id: 'f_future', type: 'pattern', content: '未开始模式 figma', source: 'user', userState: 'confirmed', validAt: 2_000_000, createdAt: 800_000 })
    h.graph.putFact({ id: 'f_ok', type: 'pattern', content: '有效模式 figma', source: 'user', userState: 'confirmed', validAt: 900_000, expiredAt: 2_000_000, createdAt: 800_000 })
    const r = h.graph.retrieveMemories({ activityKeys: ['figma'] })
    expect(r.hits.map((x) => x.fact.id)).toEqual(['f_ok'])
  })

  it('默认排除 banned / ignored；显式 userStates 可覆盖', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: 'Figma 是设计工具', source: 'user', userState: 'banned' })
    h.graph.addFact({ type: 'profile', content: '用户用 Blender 建模', source: 'user', userState: 'confirmed' })
    expect(DEFAULT_RETRIEVAL_USER_STATES).toEqual(['confirmed', 'suggested'])
    expect(h.graph.retrieveMemories({ activityKeys: ['figma'] }).hits).toHaveLength(0)
    expect(h.graph.retrieveMemories({ activityKeys: ['figma'], userStates: ['banned'] }).hits).toHaveLength(1)
  })

  it('不内置截断：返回全量排序命中，消费端自行 slice', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'pattern', content: '模式一', source: 'user', userState: 'confirmed' }) // user-create 0.9
    h.graph.addFact({ type: 'pattern', content: '模式二', source: 'inferred', userState: 'confirmed' }) // adopt-suggestion 0.7
    const r = h.graph.retrieveMemories({ activityKeys: ['模式'] })
    expect(r.hits).toHaveLength(2)
    expect(r.hits.slice(0, 1)[0]!.fact.content).toBe('模式一')
  })

  it('空 userStates 数组视为缺省（banned 仍排除）', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: 'Figma 是设计工具', source: 'user', userState: 'banned' })
    h.graph.addFact({ type: 'profile', content: '用户用 Blender 建模', source: 'user', userState: 'confirmed' })
    expect(h.graph.retrieveMemories({ activityKeys: ['figma'], userStates: [] }).hits).toHaveLength(0)
    expect(h.graph.retrieveMemories({ activityKeys: ['figma'], userStates: ['banned'] }).hits).toHaveLength(1)
  })
})

describe('memoryRetrieval — 关系扩散与路径', () => {
  it('默认 1-hop：种子 + 一条实体边邻居；孤立事实不扩散', () => {
    const h = makeHarness()
    const shared = h.graph.ensureEntity('设计工作', 'concept')
    const seed = h.graph.addFact({ type: 'profile', content: '用户常用 Figma 做设计', source: 'user', userState: 'confirmed', entityIds: [shared] })!
    const hop1 = h.graph.addFact({ type: 'pattern', content: '导出流程与命名习惯', source: 'inferred', userState: 'suggested', entityIds: [shared] })!
    const lonely = h.graph.addFact({ type: 'profile', content: '快捷键习惯', source: 'inferred', userState: 'suggested' })!
    const r = h.graph.retrieveMemories({ activityKeys: ['figma'] })
    expect(r.maxHops).toBe(DEFAULT_MAX_HOPS)
    const byId = new Map(r.hits.map((x) => [x.fact.id, x]))
    expect(byId.has(seed.id)).toBe(true)
    expect(byId.get(seed.id)!.hops).toBe(0)
    expect(byId.has(hop1.id)).toBe(true)
    expect(byId.get(hop1.id)!.hops).toBe(1)
    expect(byId.get(hop1.id)!.path).toEqual([seed.id, hop1.id])
    expect(byId.has(lonely.id)).toBe(false)
  })

  it('2-hop 上限强制：maxHops=3 被截断到 2，链上第 3 跳不返回', () => {
    const h = makeHarness()
    const ea = h.graph.ensureEntity('甲', 'concept')
    const eb = h.graph.ensureEntity('乙', 'concept')
    const ec = h.graph.ensureEntity('丙', 'concept')
    const seed = h.graph.addFact({ type: 'profile', content: '用户最近在做 Figma 相关工作', source: 'user', userState: 'confirmed', entityIds: [ea] })!
    const a = h.graph.addFact({ type: 'pattern', content: '整理设计规范', source: 'inferred', userState: 'suggested', entityIds: [ea, eb] })!
    const b = h.graph.addFact({ type: 'pattern', content: '输出交付物', source: 'inferred', userState: 'suggested', entityIds: [eb, ec] })!
    const c = h.graph.addFact({ type: 'pattern', content: '归档流程', source: 'inferred', userState: 'suggested', entityIds: [ec] })!
    const r = h.graph.retrieveMemories({ activityKeys: ['figma'], maxHops: 3 })
    expect(r.maxHops).toBe(MAX_HOPS_CAP)
    const byId = new Map(r.hits.map((x) => [x.fact.id, x]))
    expect(byId.get(seed.id)!.hops).toBe(0)
    expect(byId.get(a.id)!.hops).toBe(1)
    expect(byId.get(a.id)!.path).toEqual([seed.id, a.id])
    expect(byId.get(b.id)!.hops).toBe(2)
    expect(byId.get(b.id)!.path).toEqual([seed.id, a.id, b.id])
    expect(byId.has(c.id)).toBe(false)
  })

  it('同 episode 边扩散（默认 1-hop 内）', () => {
    const h = makeHarness()
    const ep = h.graph.addEpisode({ content: '来源' })
    const seed = h.graph.addFact({ type: 'profile', content: '种子 figma', source: 'user', userState: 'confirmed', episodeId: ep.id })!
    const sib1 = h.graph.addFact({ type: 'pattern', content: '姊妹一', source: 'inferred', userState: 'suggested', episodeId: ep.id })!
    const sib2 = h.graph.addFact({ type: 'pattern', content: '姊妹二', source: 'inferred', userState: 'suggested', episodeId: ep.id })!
    const r = h.graph.retrieveMemories({ activityKeys: ['figma'] })
    const byId = new Map(r.hits.map((x) => [x.fact.id, x]))
    expect(byId.get(sib1.id)!.hops).toBe(1)
    expect(byId.get(sib1.id)!.path).toEqual([seed.id, sib1.id])
    expect(byId.get(sib2.id)!.hops).toBe(1)
    expect(byId.get(sib2.id)!.path).toEqual([seed.id, sib2.id])
  })

  it('纯函数：环安全（双向边只访问一次）、种子优先于扩散、最短路径先到先得', () => {
    const seed = baseFact({ id: 's', content: '种子', entityIds: ['e1'] })
    const n = baseFact({ id: 'n', content: '邻居', entityIds: ['e1', 'e2'] })
    const far = baseFact({ id: 'far', content: '远端', entityIds: ['e2'] })
    const alsoSeed = baseFact({ id: 'also', content: '也命中', entityIds: ['e1'] })
    const hits = diffuseHits(
      [seed, n, far, alsoSeed],
      [
        { fact: seed, reasons: ['activity'] },
        { fact: alsoSeed, reasons: ['related'] }
      ],
      2
    )
    const byId = new Map(hits.map((x) => [x.fact.id, x]))
    expect(hits).toHaveLength(4)
    expect(byId.get('s')!.hops).toBe(0)
    expect(byId.get('also')!.hops).toBe(0) // 种子优先于扩散
    expect(byId.get('also')!.reasons).toEqual(['related'])
    expect(byId.get('n')!.hops).toBe(1) // 经 s 或 also 均为 1 跳，先到先得
    expect(byId.get('n')!.path).toEqual(['s', 'n'])
    expect(byId.get('far')!.hops).toBe(2)
    expect(byId.get('far')!.path).toEqual(['s', 'n', 'far'])
  })

  it('clampMaxHops：默认 1、超 2 截断、非有限值回默认', () => {
    expect(clampMaxHops(undefined)).toBe(DEFAULT_MAX_HOPS)
    expect(clampMaxHops(2)).toBe(2)
    expect(clampMaxHops(3)).toBe(MAX_HOPS_CAP)
    expect(clampMaxHops(0)).toBe(1)
    expect(clampMaxHops(-5)).toBe(1)
    expect(clampMaxHops(Number.NaN)).toBe(1)
  })

  it('diffuseHits 直调也钳制 hop 上限（2-hop 不变量不只在 store 边界生效）', () => {
    const seed = baseFact({ id: 's', content: '种子', entityIds: ['e1'] })
    const a = baseFact({ id: 'a', content: '甲', entityIds: ['e1', 'e2'] })
    const b = baseFact({ id: 'b', content: '乙', entityIds: ['e2', 'e3'] })
    const c = baseFact({ id: 'c', content: '丙', entityIds: ['e3'] })
    const hits = diffuseHits([seed, a, b, c], [{ fact: seed, reasons: ['activity'] }], 5)
    const byId = new Map(hits.map((x) => [x.fact.id, x]))
    expect(byId.get('a')!.hops).toBe(1)
    expect(byId.get('b')!.hops).toBe(2)
    expect(byId.has('c')).toBe(false) // 第 3 跳被钳制截断
  })
})

describe('memoryRetrieval — 排序与 trace', () => {
  it('排序 = 权重 × 时间有效性（检索时重算）', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'pattern', content: '模式高意图 figma', source: 'user', userState: 'confirmed' }) // 0.9
    h.graph.addFact({ type: 'pattern', content: '模式低意图 figma', source: 'inferred', userState: 'confirmed' }) // 0.7
    const r = h.graph.retrieveMemories({ activityKeys: ['figma'] })
    expect(r.hits[0]!.fact.content).toBe('模式高意图 figma')
    expect(r.hits[1]!.fact.content).toBe('模式低意图 figma')
    expect(r.hits[0]!.score).toBeGreaterThan(r.hits[1]!.score)
  })

  it('rankHits 纯函数：分数 = computeWeight（意图 × 衰减 × 时段），同分新事实优先', () => {
    const fresh = baseFact({ id: 'fresh', lastSeenAt: 1_000_000 })
    const stale = baseFact({ id: 'stale', lastSeenAt: 1_000_000 - 14 * 86_400_000 })
    const hits: MemoryHit[] = [
      { fact: stale, reasons: [], path: [stale.id], hops: 0, score: 0 },
      { fact: fresh, reasons: [], path: [fresh.id], hops: 0, score: 0 }
    ]
    const ranked = rankHits(hits, 1_000_000, 0.25)
    expect(ranked.map((x) => x.fact.id)).toEqual(['fresh', 'stale'])
    expect(ranked[0]!.score).toBeCloseTo(0.9, 10)
    expect(ranked[1]!.score).toBeCloseTo(0.9 * Math.exp(-0.5), 10)
  })

  it('recordMemoryRecall：kind=recall，路径 / hop / 原因 / 预览入 payload（≤200 字符）', () => {
    const h = makeHarness()
    const shared = h.graph.ensureEntity('设计', 'concept')
    const seed = h.graph.addFact({ type: 'profile', content: '用户用 Figma 做设计', source: 'user', userState: 'confirmed', entityIds: [shared] })!
    const sib = h.graph.addFact({ type: 'pattern', content: '导出流程说明', source: 'inferred', userState: 'suggested', entityIds: [shared] })!
    const result = h.graph.retrieveMemories({ activityKeys: ['figma'] })
    expect(result.hits.map((x) => x.fact.id)).toEqual([seed.id, sib.id])
    expect(result.hits[1]!.hops).toBe(1)

    const trace = createMemoryTraceStore({ now: () => h.now, createId: (() => { let n = 0; return () => `t-${n++}` })() })
    const record = recordMemoryRecall(trace, 'd1', { query: 'figma', result })
    expect(record.kind).toBe('recall')
    const payload = record.payload as TraceRecallPayload & { reasons: HitReason[]; maxHops: number }
    expect(payload.tool).toBe('search_memories')
    expect(payload.query).toBe('figma')
    expect(payload.count).toBe(2)
    expect(payload.hops).toBe(1)
    expect(payload.reasons).toEqual(['activity'])
    expect(payload.maxHops).toBe(DEFAULT_MAX_HOPS)
    expect(payload.hitPath).toEqual([seed.id, sib.id]) // 去重扁平路径

    // 预览截断 ≤200
    const long = recordMemoryRecall(trace, 'd2', {
      query: 'x',
      result: { hits: [{ fact: { ...seed, content: '长'.repeat(300) }, reasons: [], path: [seed.id], hops: 0, score: 0.9 }], maxHops: 1, seedCount: 1 }
    })
    expect((long.payload as TraceRecallPayload).preview!.length).toBe(200)

    // 空结果也可记录（count 0 / hops 0）
    const empty = recordMemoryRecall(trace, 'd3', { query: 'zzz', result: { hits: [], maxHops: 1, seedCount: 0 } })
    expect((empty.payload as TraceRecallPayload).count).toBe(0)
    expect((empty.payload as TraceRecallPayload).hops).toBe(0)
    expect(trace.listByDecisionId('d1')).toHaveLength(1)
    expect(trace.listByDecisionId('d3')).toHaveLength(1)
  })

  it('recordMemoryRecall 记全量召回原因：扩散事实排前且消费端 slice 时不丢种子原因', () => {
    const h = makeHarness()
    const shared = h.graph.ensureEntity('设计', 'concept')
    // 种子（system-infer 0.5）权重低于扩散事实（user-create 0.9）→ 排序后扩散事实在前
    const seed = h.graph.addFact({ type: 'profile', content: '用户用 Figma 做设计', source: 'ai-suggest', userState: 'suggested', entityIds: [shared] })!
    const sib = h.graph.addFact({ type: 'pattern', content: '导出流程说明', source: 'user', userState: 'confirmed', entityIds: [shared] })!
    const result = h.graph.retrieveMemories({ activityKeys: ['figma'] })
    expect(result.hits[0]!.fact.id).toBe(sib.id)
    expect(result.hits[0]!.hops).toBe(1)
    expect(result.hits).toHaveLength(2) // 不内置截断：全量供 trace

    const trace = createMemoryTraceStore({ now: () => h.now, createId: (() => { let n = 0; return () => `t-${n++}` })() })
    const record = recordMemoryRecall(trace, 'd1', { query: 'figma', result })
    const payload = record.payload as TraceRecallPayload & { reasons: HitReason[]; maxHops: number }
    expect(payload.count).toBe(2)
    expect(payload.reasons).toEqual(['activity']) // 种子原因不因消费端 slice 丢失
    expect(payload.hops).toBe(1)
    expect(payload.hitPath).toEqual([seed.id, sib.id]) // 路径链以种子开头，扁平去重
  })
})
