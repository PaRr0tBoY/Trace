import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeDatabase, openDatabase, type TraceDatabase } from '../electron/store/db'
import {
  computeWeight,
  cosineSimilarity,
  createMemoryIndexAdapter,
  createSqliteMemoryGraph,
  DEDUP_COSINE_THRESHOLD,
  INTENT_TIER_WEIGHT,
  LEGACY_MEMORY_TYPES,
  subjectKey,
  toFtsQuery,
  type IntentTier,
  type MemoryGraphStore
} from '../electron/store/memoryGraph'
import { MemoryStore } from '../electron/store/MemoryStore'
import type { Memory } from '../shared/types'

/**
 * The installed better-sqlite3 addon may target a different runtime ABI than
 * the test runner's Node (the repo keeps the Electron-ABI build for packaging).
 * Fall back to a cached Node-ABI prebuild through the official `nativeBinding`
 * injection seam (same pattern as tests/db.test.ts).
 */
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
  const dir = mkdtempSync(join(tmpdir(), 'trace-mem-'))
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

/** 一条 legacy 面板记忆（memories.json 行的形状）。 */
function legacyMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: 'm_1',
    type: 'project',
    content: 'CAD Agent',
    confidence: 0.5,
    hitCount: 2,
    lastSeenAt: 9_000,
    createdAt: 1_000,
    source: 'task-feedback',
    userState: 'confirmed',
    ...over
  }
}

describe('memoryGraph — 提取（episodes / entities / facts 落库）', () => {
  it('episodes 落库并 close 回填 endedAt', () => {
    const h = makeHarness()
    const ep = h.graph.addEpisode({ sessionId: 's1', startedAt: 500, content: '写 schema' })
    expect(ep.id).toMatch(/^ep_/)
    expect(ep.endedAt).toBeNull()
    expect(h.graph.closeEpisode(ep.id)).toBe(true)
    expect(h.graph.closeEpisode('ep_missing')).toBe(false)
    const row = h.db.prepare(`SELECT endedAt FROM episodes WHERE id = ?`).get(ep.id) as { endedAt: number }
    expect(row.endedAt).toBe(h.now)
  })

  it('entities 按 (name, type) 唯一', () => {
    const h = makeHarness()
    const a = h.graph.ensureEntity('Rust', 'language')
    expect(h.graph.ensureEntity('Rust', 'language')).toBe(a)
    expect(h.graph.ensureEntity('Rust', 'tool')).not.toBe(a)
  })

  it('facts 携带 episode 来源链与实体边；按 type 过滤（UI 分组基础）', () => {
    const h = makeHarness()
    const ep = h.graph.addEpisode({ content: '整理画像' })
    const f = h.graph.addFact({
      type: 'profile',
      content: '用户所在城市是北京',
      source: 'inferred',
      userState: 'suggested',
      episodeId: ep.id,
      entities: [{ name: '北京', type: 'city' }]
    })
    expect(f).not.toBeNull()
    expect(f!.episodeId).toBe(ep.id)
    expect(f!.entityIds).toHaveLength(1)
    expect(f!.userState).toBe('suggested')
    expect(h.graph.listFacts({ types: ['profile'] })).toHaveLength(1)
    expect(h.graph.listFacts({ types: ['pattern'] })).toHaveLength(0)
    const ent = h.db.prepare(`SELECT name FROM entities WHERE type = 'city'`).all()
    expect(ent).toEqual([{ name: '北京' }])
  })
})

describe('memoryGraph — FTS5 检索', () => {
  it('content 全文检索 + 更新同步 + 删除同步', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: 'user city is beijing', source: 'inferred' })
    h.graph.addFact({ type: 'pattern', content: 'typecheck before commit', source: 'inferred' })
    expect(h.graph.searchFacts('beijing').map((f) => f.type)).toEqual(['profile'])
    expect(h.graph.searchFacts('typecheck')).toHaveLength(1)

    const first = h.graph.searchFacts('beijing')[0]!
    h.graph.putFact({ id: first.id, type: 'profile', content: 'user city is shanghai', source: 'inferred' })
    expect(h.graph.searchFacts('beijing')).toHaveLength(0)
    expect(h.graph.searchFacts('shanghai')).toHaveLength(1)

    h.graph.deleteFact(first.id)
    expect(h.graph.searchFacts('shanghai')).toHaveLength(0)
  })

  it('按 type 过滤检索 + 空查询/引号安全', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: 'hello world', source: 'user' })
    h.graph.addFact({ type: 'pattern', content: 'hello world', source: 'user' })
    expect(h.graph.searchFacts('hello', { types: ['profile'] })).toHaveLength(1)
    expect(h.graph.searchFacts('   ')).toHaveLength(0)
    expect(h.graph.searchFacts('" OR *')).toHaveLength(0) // 引号包裹后无命中，不抛错
  })

  it('searchFacts 与 listFacts 同契约：validNow / episodeId 过滤', () => {
    const h = makeHarness()
    const ep = h.graph.addEpisode({ content: 'ep' })
    h.graph.addFact({ type: 'profile', content: 'old claim', source: 'inferred', episodeId: ep.id, validAt: 1_000, expiredAt: 500 }) // 已过期
    h.graph.addFact({ type: 'profile', content: 'fresh claim', source: 'inferred', episodeId: ep.id, validAt: 1_000 })
    h.graph.addFact({ type: 'profile', content: 'other source', source: 'inferred' })
    expect(h.graph.searchFacts('claim')).toHaveLength(2)
    expect(h.graph.searchFacts('claim', { validNow: true })).toHaveLength(1)
    expect(h.graph.searchFacts('claim', { episodeId: ep.id })).toHaveLength(2)
    expect(h.graph.searchFacts('claim', { episodeId: ep.id, validNow: true })).toHaveLength(1)
  })
})

describe('memoryGraph — 确定性去重（归一化键 + 余弦 ≥0.6）', () => {
  it('归一化键同键合并：不新增行、强化计数、保留原 id 与 createdAt', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred' })!
    expect(a.hitCount).toBe(0) // 新建事实从 0 计数
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred' })!
    expect(b.id).toBe(a.id)
    expect(h.graph.listFacts({ types: ['profile'] })).toHaveLength(1)
    expect(b.hitCount).toBe(a.hitCount + 1)
    const c = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred' })!
    expect(c.hitCount).toBe(2) // 每次重复出现 = 一次强化
    expect(h.graph.getFact(a.id)!.createdAt).toBe(a.createdAt)
  })

  it('大小写与空白折叠后视为同键', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: 'CAD  Agent', source: 'user' })
    const b = h.graph.addFact({ type: 'profile', content: 'cad agent', source: 'user' })!
    expect(b.hitCount).toBe(1)
  })

  it('余弦 ≥0.6 语义重复合并（同义改写）', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户在北京工作', source: 'inferred' })!
    const b = h.graph.addFact({ type: 'profile', content: '用户在北京上班', source: 'inferred' })!
    expect(b.id).toBe(a.id)
  })

  it('同主语异取值的对子（矛盾候补）不并入合并', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred' })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred' })!
    expect(b.id).not.toBe(a.id)
    expect(h.graph.listFacts({ types: ['profile'] })).toHaveLength(2)
  })

  it('合并取更高意图档的内容与来源', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: '常用语言是 rust', source: 'inferred' })
    const b = h.graph.addFact({ type: 'profile', content: 'rust 是常用语言', source: 'user', intent: 'user-edit' })!
    const got = h.graph.getFact(b.id)!
    expect(got.content).toBe('rust 是常用语言')
    expect(got.intent).toBe('user-edit')
    expect(got.source).toBe('user')
  })

  it('不同 type 同内容不合并', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: '写周报', source: 'user' })
    const b = h.graph.addFact({ type: 'pattern', content: '写周报', source: 'user' })!
    expect(b.id).not.toBe(h.graph.listFacts({ types: ['profile'] })[0]!.id)
  })

  it('已失效事实不参与去重合并', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1 })!
    h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 600 })
    const c = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred' })!
    expect(c.id).not.toBe(a.id)
  })

  it('合并时入站窗口覆盖旧窗口（已过期事实随新观察复活）', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '常用语言是 rust', source: 'inferred', validAt: 1_000, expiredAt: 2_000 })!
    expect(h.graph.getFact(a.id)!.weight).toBeCloseTo(0.5 * 0.5, 10) // 已过期：时段因子 0.5
    const b = h.graph.addFact({ type: 'profile', content: '常用语言是 rust', source: 'inferred', validAt: 3_000 })!
    expect(b.id).toBe(a.id) // 归一化键合并，不新增行
    const got = h.graph.getFact(a.id)!
    expect(got.validAt).toBe(3_000)
    expect(got.expiredAt).toBeNull() // 新窗口整体覆盖旧窗口
    expect(got.weight).toBeCloseTo(0.5, 10) // 窗口内：时段因子回到 1.0
  })

  it('合并时入站无窗口 → 保留旧窗口', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '常用语言是 rust', source: 'inferred', validAt: 1_000, expiredAt: 2_000 })!
    h.graph.addFact({ type: 'profile', content: '常用语言是 rust', source: 'inferred' })
    const got = h.graph.getFact(a.id)!
    expect(got.validAt).toBe(1_000)
    expect(got.expiredAt).toBe(2_000)
  })
})

describe('memoryGraph — 矛盾消解（时间有效性冲突写 invalid_at，不覆盖）', () => {
  it('同 (type, 主语键) 窗口重叠 → 旧事实写 invalid_at，新事实新行插入', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    expect(b.id).not.toBe(a.id)
    expect(h.graph.getFact(a.id)!.invalidAt).toBe(2_000)
    expect(h.graph.getFact(a.id)!.content).toBe('用户所在城市是北京') // 原事实未被覆盖
    expect(h.graph.getFact(a.id)!.weight).toBe(0)
    expect(h.graph.getFact(b.id)!.invalidAt).toBeNull()
    // 默认查询排除失效行；includeInvalidated 可见历史
    expect(h.graph.listFacts({ types: ['profile'] }).map((f) => f.id)).toEqual([b.id])
    expect(h.graph.listFacts({ types: ['profile'], includeInvalidated: true })).toHaveLength(2)
  })

  it('旧事实无窗口（恒有效）与带窗口新事实冲突 → 同样写 invalid_at', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'identity', content: '用户所在城市是北京', source: 'user' })!
    const b = h.graph.addFact({ type: 'identity', content: '用户所在城市是上海', source: 'user', validAt: 2_000 })!
    expect(h.graph.getFact(a.id)!.invalidAt).toBe(2_000)
    expect(h.graph.getFact(b.id)!.invalidAt).toBeNull()
    expect(h.graph.listFacts({ types: ['identity'] })).toHaveLength(1) // 旧事实退出默认视图
  })

  it('入站无时间窗口 → 不触发矛盾消解（没有时间有效性冲突）', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred' })
    expect(h.graph.getFact(a.id)!.invalidAt).toBeNull()
  })

  it('逆时事实（新窗口早于旧窗口起点）→ v1 不判矛盾', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 5_000 })!
    h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 1_000 })
    expect(h.graph.getFact(a.id)!.invalidAt).toBeNull()
  })
})

describe('memoryGraph — 权重（意图五档 × 现有衰减 × 时段字段）', () => {
  it('五档取值正确且严格单调', () => {
    expect(INTENT_TIER_WEIGHT['user-edit']).toBe(1)
    expect(INTENT_TIER_WEIGHT['user-create']).toBe(0.9)
    expect(INTENT_TIER_WEIGHT['adopt-suggestion']).toBe(0.7)
    expect(INTENT_TIER_WEIGHT['system-infer']).toBe(0.5)
    expect(INTENT_TIER_WEIGHT['raw-extract']).toBe(0.3)
    const order: IntentTier[] = ['user-edit', 'user-create', 'adopt-suggestion', 'system-infer', 'raw-extract']
    for (let i = 1; i < order.length; i++) {
      expect(INTENT_TIER_WEIGHT[order[i - 1]!]).toBeGreaterThan(INTENT_TIER_WEIGHT[order[i]!])
    }
  })

  it('weight = 档位 × exp(-λ·周)（复用 MemoryStore 衰减）', () => {
    const now = 1_000_000
    const base = { lambda: 0.25, lastSeenAt: now, now, validAt: null, invalidAt: null, expiredAt: null }
    expect(computeWeight({ ...base, intent: 'adopt-suggestion' })).toBeCloseTo(0.7, 10)
    const decayed = computeWeight({ ...base, lastSeenAt: now - 14 * 86_400_000, intent: 'adopt-suggestion' })
    expect(decayed).toBeCloseTo(0.7 * Math.exp(-0.5), 10)
  })

  it('时段字段：窗口内 1.0、过期 0.5、未开始 0.5、失效 0', () => {
    const now = 1_000_000
    const base = { intent: 'user-create' as const, lambda: 0.25, lastSeenAt: now, now }
    expect(computeWeight({ ...base, validAt: null, invalidAt: null, expiredAt: null })).toBeCloseTo(0.9, 10)
    expect(computeWeight({ ...base, validAt: now - 100, invalidAt: null, expiredAt: now - 50 })).toBeCloseTo(0.45, 10)
    expect(computeWeight({ ...base, validAt: now + 100, invalidAt: null, expiredAt: null })).toBeCloseTo(0.45, 10)
    expect(computeWeight({ ...base, validAt: null, invalidAt: now - 100, expiredAt: null })).toBeCloseTo(0, 10)
  })

  it('新建事实落库权重 = 意图档位（fresh：衰减 1 × 窗口内 1）', () => {
    const h = makeHarness()
    const f = h.graph.addFact({ type: 'pattern', content: '先测后提', source: 'inferred' })!
    expect(f.intent).toBe('system-infer')
    expect(f.weight).toBeCloseTo(0.5, 10)
    const g = h.graph.addFact({ type: 'preference', content: '默认深色模式', source: 'user', userState: 'confirmed' })!
    expect(g.intent).toBe('user-create')
    expect(g.weight).toBeCloseTo(0.9, 10)
  })

  it('confirm 升意图档并强化（含权重重算）', () => {
    const h = makeHarness()
    const f = h.graph.addFact({ type: 'pattern', content: '先测后提', source: 'inferred' })!
    expect(h.graph.updateFactState(f.id, 'confirmed')).toBe(true)
    const got = h.graph.getFact(f.id)!
    expect(got.userState).toBe('confirmed')
    expect(got.intent).toBe('adopt-suggestion')
    expect(got.hitCount).toBe(1)
    expect(got.weight).toBeCloseTo(0.7, 10)
    // 状态转换守卫与 MemoryStore 一致
    expect(h.graph.updateFactState(f.id, 'confirmed')).toBe(false)
    expect(h.graph.updateFactState('f_missing', 'confirmed')).toBe(false)
  })

  it('reinforceFact 只强化 confirmed 事实', () => {
    const h = makeHarness()
    const f = h.graph.addFact({ type: 'pattern', content: '先测后提', source: 'inferred' })!
    expect(h.graph.reinforceFact(f.id)).toBe(false) // suggested 不可强化
    h.graph.updateFactState(f.id, 'confirmed')
    expect(h.graph.reinforceFact(f.id)).toBe(true)
    expect(h.graph.getFact(f.id)!.hitCount).toBe(2)
  })
})

describe('memoryGraph — memories.json 迁移与面板适配器', () => {
  it('ingest 保留 id/source/userState/计数/时间，返回写入条数', () => {
    const h = makeHarness()
    const memories = [
      legacyMemory(),
      legacyMemory({ id: 'm_2', type: 'tool', content: 'koffi FFI', source: 'user', userState: 'suggested', hitCount: 0, lastSeenAt: 2_000, createdAt: 2_000 })
    ]
    expect(h.graph.ingestLegacyMemories(memories)).toBe(2)
    expect(h.graph.countFacts({ types: LEGACY_MEMORY_TYPES, includeInvalidated: true })).toBe(2)
    const f1 = h.graph.getFact('m_1')!
    expect(f1.source).toBe('task-feedback')
    expect(f1.userState).toBe('confirmed')
    expect(f1.hitCount).toBe(2)
    expect(f1.lastSeenAt).toBe(9_000)
    expect(f1.createdAt).toBe(1_000)
    expect(f1.intent).toBe('adopt-suggestion') // confirmed + task-feedback
    expect(h.graph.countFacts({ types: ['profile'] })).toBe(0) // 面板四型之外不受影响
  })

  it('ingest 是原子事务：中途失败整体回滚，不留部分写入', () => {
    const h = makeHarness()
    let calls = 0
    const flaky = createSqliteMemoryGraph(h.db, {
      now: () => {
        calls += 1
        if (calls === 2) throw new Error('boom')
        return h.now
      }
    })
    const memories = [legacyMemory(), legacyMemory({ id: 'm_2', content: 'koffi' })]
    expect(() => flaky.ingestLegacyMemories(memories)).toThrow('boom')
    // 事务回滚：第一条也未残留 → 续跑判定 countFacts > 0 不成立 → 文件保留（state.ts 重试而非删）
    expect(h.graph.countFacts({ types: LEGACY_MEMORY_TYPES, includeInvalidated: true })).toBe(0)
  })

  it('适配器 load 全量镜像回 Memory[]', () => {
    const h = makeHarness()
    h.graph.ingestLegacyMemories([
      legacyMemory(),
      legacyMemory({ id: 'm_2', type: 'identity', content: '双学位', source: 'ai-suggest', userState: 'banned', hitCount: 0, lastSeenAt: 3_000, createdAt: 3_000 })
    ])
    const index = createMemoryIndexAdapter(h.graph).load()!
    expect(index.version).toBe(1)
    expect(index.memories).toHaveLength(2)
    const byId = new Map(index.memories.map((m) => [m.id, m]))
    expect(byId.get('m_1')!.userState).toBe('confirmed')
    expect(byId.get('m_1')!.source).toBe('task-feedback')
    expect(byId.get('m_2')!.userState).toBe('banned')
  })

  it('适配器 save 差异同步：状态变更/新增/删除只动 m_ 行，图侧事实不受影响', () => {
    const h = makeHarness()
    h.graph.ingestLegacyMemories([legacyMemory()])
    const adapter = createMemoryIndexAdapter(h.graph)
    const index = adapter.load()!
    index.memories[0]!.userState = 'ignored'
    index.memories.push(legacyMemory({ id: 'm_2', type: 'tool', content: 'koffi', source: 'user', userState: 'suggested', hitCount: 0, lastSeenAt: 5_000, createdAt: 5_000 }))
    h.graph.addFact({ type: 'preference', content: '图侧事实', source: 'inferred' })
    adapter.save(index)
    expect(h.graph.getFact('m_1')!.userState).toBe('ignored')
    expect(h.graph.getFact('m_2')!.content).toBe('koffi')
    expect(h.graph.countFacts({ types: ['preference'] })).toBe(1)

    index.memories = [index.memories[1]!]
    adapter.save(index)
    expect(h.graph.getFact('m_1')).toBeUndefined()
    expect(h.graph.getFact('m_2')).toBeDefined()
    expect(h.graph.countFacts({ types: ['preference'] })).toBe(1)
  })

  it('MemoryStore + SQLite 适配器：面板全流程（建议/确认/封禁/命中）重启不回归', () => {
    const h = makeHarness()
    const adapter = createMemoryIndexAdapter(h.graph)
    const store = new MemoryStore({ load: () => adapter.load(), save: (i) => adapter.save(i), now: () => h.now })
    store.load()
    const m = store.suggestMemory({ type: 'project', content: 'CAD Agent', source: 'task-feedback' })!
    store.confirm(m.id)
    store.hit(m.id)
    store.ban(store.suggestMemory({ type: 'tool', content: 'koffi', source: 'ai-suggest' })!.id)

    // 模拟重启：同一 db 文件重开 + 新图 + 新适配器 + 新 MemoryStore
    closeDatabase(h.db)
    const db2 = openForTest(h.filePath)
    openDbs.push(db2)
    const graph2 = createSqliteMemoryGraph(db2, { now: () => h.now })
    const adapter2 = createMemoryIndexAdapter(graph2)
    const store2 = new MemoryStore({ load: () => adapter2.load(), save: (i) => adapter2.save(i), now: () => h.now })
    store2.load()
    expect(store2.list()).toHaveLength(2)
    const confirmed = store2.list().find((x) => x.userState === 'confirmed')!
    expect(confirmed.content).toBe('CAD Agent')
    expect(confirmed.hitCount).toBe(2)
    expect(store2.candidates()).toHaveLength(0)
    const banned = store2.list().find((x) => x.userState === 'banned')!
    expect(banned.content).toBe('koffi')
    expect(store2.isBanned('koffi FFI', 'project')).toBe(true)
  })
})

describe('memoryGraph — 纯函数', () => {
  it('cosine 相似度与阈值', () => {
    expect(cosineSimilarity('用户在北京工作', '用户在北京上班')).toBeGreaterThanOrEqual(DEDUP_COSINE_THRESHOLD)
    // 同主语异取值对子：语义近但仍是不同断言（矛盾候补）
    expect(cosineSimilarity('用户所在城市是北京', '用户所在城市是上海')).toBeGreaterThanOrEqual(DEDUP_COSINE_THRESHOLD)
    expect(cosineSimilarity('写周报', 'rust borrow checker')).toBeLessThan(DEDUP_COSINE_THRESHOLD)
  })

  it('主语键：停顿标点截断 / 末位系词 / 兜底全文', () => {
    expect(subjectKey('用户所在城市是北京')).toBe('用户所在城市')
    expect(subjectKey('先类型检查，再提交')).toBe('先类型检查')
    expect(subjectKey('用户在北京工作')).toBe('用户在北京工作')
  })

  it('toFtsQuery 引号包裹与空过滤', () => {
    expect(toFtsQuery('rust borrow')).toBe('"rust" AND "borrow"')
    expect(toFtsQuery('')).toBe('')
    expect(toFtsQuery('" OR *')).toBe('"or" AND "*"')
    expect(toFtsQuery('""')).toBe('')
  })
})

describe('memoryGraph — 面板冲突（t51）：listConflicts / adjudicateConflict', () => {
  it('listConflicts 返回同 (type, 主语键) 的 (有效方, 被失效方) 对', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    const pairs = h.graph.listConflicts()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.active.id).toBe(b.id)
    expect(pairs[0]!.invalidated.id).toBe(a.id)
    expect(pairs[0]!.invalidated.invalidAt).toBe(2_000)
  })

  it('无待裁决对 → 空列表（无失效 / 不同主语 / 无时间窗口不配对）', () => {
    const h = makeHarness()
    h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'user' })
    h.graph.addFact({ type: 'preference', content: '默认深色模式', source: 'user' })
    // 同 type 不同主语（无标点/系词截断成不同键）不配对
    h.graph.addFact({ type: 'profile', content: '用户在杭州工作', source: 'inferred', validAt: 1_000 })
    h.graph.addFact({ type: 'profile', content: '用户在用 Rust', source: 'inferred', validAt: 2_000 })
    expect(h.graph.listConflicts()).toHaveLength(0)
  })

  it('keep-active：保留当前有效方（弃方维持失效），裁决后退出面板', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    expect(h.graph.adjudicateConflict(b.id, a.id, 'keep-active')).toBe(true)
    expect(h.graph.getFact(b.id)!.invalidAt).toBeNull()
    expect(h.graph.getFact(a.id)!.invalidAt).toBe(2_000)
    // 双方落 resolved_at：该冲突不再展示
    expect(h.graph.listConflicts()).toHaveLength(0)
    expect(h.graph.getFact(a.id)!.resolvedAt).not.toBeNull()
    expect(h.graph.getFact(b.id)!.resolvedAt).not.toBeNull()
  })

  it('keep-invalidated：复活被失效方（清 invalid_at、重算权重）并失效当前方', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    expect(h.graph.adjudicateConflict(b.id, a.id, 'keep-invalidated')).toBe(true)
    const revived = h.graph.getFact(a.id)!
    expect(revived.invalidAt).toBeNull()
    expect(revived.weight).toBeGreaterThan(0) // 权重重算（不再是 0）
    const dropped = h.graph.getFact(b.id)!
    expect(dropped.invalidAt).toBe(h.now)
    expect(dropped.weight).toBe(0)
    expect(h.graph.listConflicts()).toHaveLength(0)
    // 复活方回到默认事实视图
    expect(h.graph.listFacts({ types: ['profile'] }).map((f) => f.id)).toEqual([a.id])
  })

  it('keep-none：双方失效', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    expect(h.graph.adjudicateConflict(b.id, a.id, 'keep-none')).toBe(true)
    expect(h.graph.getFact(a.id)!.invalidAt).toBe(2_000)
    expect(h.graph.getFact(b.id)!.invalidAt).toBe(h.now)
    expect(h.graph.listConflicts()).toHaveLength(0)
    expect(h.graph.listFacts({ types: ['profile'] })).toHaveLength(0)
  })

  it('裁决守卫：不存在的对 / 形状不符（双方同状态 / 主语不同）→ false', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    expect(h.graph.adjudicateConflict('f_missing', a.id, 'keep-active')).toBe(false)
    // active 侧必须有效、invalidated 侧必须已失效
    expect(h.graph.adjudicateConflict(a.id, b.id, 'keep-active')).toBe(false)
    // 不同主语不构成对
    const c = h.graph.addFact({ type: 'profile', content: '用户在杭州工作', source: 'inferred', validAt: 1_000 })!
    expect(h.graph.adjudicateConflict(c.id, a.id, 'keep-active')).toBe(false)
  })

  it('裁决守卫：非法 resolution（IPC 边界任意字符串）→ false 且不落任何行', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    // @ts-expect-error 运行时 IPC 可传任意字符串，白名单守卫必须拦截
    expect(h.graph.adjudicateConflict(b.id, a.id, 'keep-active-everything')).toBe(false)
    // 冲突对仍在待审列表（双方 resolved_at 未被写入）
    expect(h.graph.listConflicts()).toHaveLength(1)
    const rows = h.db.prepare(`SELECT id, invalid_at, resolvedAt FROM facts ORDER BY id`).all() as Array<{ id: string; invalid_at: number | null; resolvedAt: number | null }>
    for (const r of rows) expect(r.resolvedAt).toBeNull()
    expect(h.graph.getFact(a.id)!.invalidAt).toBe(2_000)
    expect(h.graph.getFact(b.id)!.invalidAt).toBeNull()
  })

  it('持久化：裁决结果重启后保持（resolved_at / invalid_at 落库，SQLite 断言）', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    expect(h.graph.adjudicateConflict(b.id, a.id, 'keep-invalidated')).toBe(true)
    // SQLite 断言：行内字段即持久化状态
    const rows = h.db.prepare(`SELECT id, invalid_at, resolvedAt FROM facts ORDER BY id`).all() as Array<{ id: string; invalid_at: number | null; resolvedAt: number | null }>
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(a.id)!.invalid_at).toBeNull()
    expect(byId.get(a.id)!.resolvedAt).toBe(h.now)
    expect(byId.get(b.id)!.invalid_at).toBe(h.now)
    expect(byId.get(b.id)!.resolvedAt).toBe(h.now)

    // 重开同一 DB 文件：图重建后状态一致，冲突不再出现
    closeDatabase(h.db)
    const db2 = openForTest(h.filePath)
    openDbs.push(db2)
    const graph2 = createSqliteMemoryGraph(db2, { now: () => h.now, lambda: 0.25 })
    expect(graph2.getFact(a.id)!.invalidAt).toBeNull()
    expect(graph2.getFact(a.id)!.resolvedAt).toBe(h.now)
    expect(graph2.getFact(b.id)!.invalidAt).toBe(h.now)
    expect(graph2.listConflicts()).toHaveLength(0)
    expect(graph2.listFacts({ types: ['profile'] }).map((f) => f.id)).toEqual([a.id])
  })

  it('已裁决冲突的新矛盾：新入站事实再次失效复活方 → 重新成为待审冲突', () => {
    const h = makeHarness()
    const a = h.graph.addFact({ type: 'profile', content: '用户所在城市是北京', source: 'inferred', validAt: 1_000 })!
    const b = h.graph.addFact({ type: 'profile', content: '用户所在城市是上海', source: 'inferred', validAt: 2_000 })!
    h.graph.adjudicateConflict(b.id, a.id, 'keep-invalidated') // a 复活（resolved_at 清空）
    const c = h.graph.addFact({ type: 'profile', content: '用户所在城市是广州', source: 'inferred', validAt: 3_000 })!
    // a（复活方，resolved_at 已被复活语句清空）与 c 构成新冲突
    const pairs = h.graph.listConflicts()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.active.id).toBe(c.id)
    expect(pairs[0]!.invalidated.id).toBe(a.id)
  })
})
