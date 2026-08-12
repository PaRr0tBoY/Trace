import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeDatabase, openDatabase, type TraceDatabase } from '../electron/store/db'
import { createSqliteMemoryGraph, type MemoryGraphStore } from '../electron/store/memoryGraph'
import {
  createChatEpisodeExtractor,
  createEpisodeConsolidator,
  FALLBACK_MS,
  type EpisodeConsolidator,
  type EpisodeExtractor,
  type ExtractedFact,
  type FactTimestamp
} from '../electron/store/episodeConsolidator'
import type { ChatResult } from '../electron/main/provider'
import type { EpisodeRecord } from '../electron/store/memoryGraph'
import type { TaskSession } from '../shared/types'

/**
 * The installed better-sqlite3 addon may target a different runtime ABI than
 * the test runner's Node — same nativeBinding fallback seam as db.test.ts.
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

/** 注入时钟的计数提取器（节点/时间戳各计数；可脚本化失败与批内事实）。 */
class FakeExtractor implements EpisodeExtractor {
  nodesCalls = 0
  timestampsCalls = 0
  failNodes = false
  failTimestamps = false
  nodesBuilder: ((episodes: EpisodeRecord[]) => ExtractedFact[]) | null = null
  timestampsBuilder: ((facts: ExtractedFact[]) => FactTimestamp[]) | null = null

  async extractNodesAndEdges(episodes: EpisodeRecord[]): Promise<{ facts: ExtractedFact[] }> {
    this.nodesCalls++
    if (this.failNodes) throw new Error('nodes extraction failed')
    return { facts: this.nodesBuilder ? this.nodesBuilder(episodes) : [] }
  }

  async extractTimestamps(facts: ExtractedFact[]): Promise<FactTimestamp[]> {
    this.timestampsCalls++
    if (this.failTimestamps) throw new Error('timestamps extraction failed')
    return this.timestampsBuilder ? this.timestampsBuilder(facts) : []
  }
}

interface Harness {
  db: TraceDatabase
  graph: MemoryGraphStore
  filePath: string
  now: number
  sessions: TaskSession[]
  evidence: Array<{ at: number; source: string; windowTitle?: string }>
  extractor: FakeExtractor
  consolidator: EpisodeConsolidator
}

const openDbs: TraceDatabase[] = []
const tempDirs: string[] = []

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'trace-epi-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'trace.db')
  const db = openForTest(filePath)
  openDbs.push(db)
  const h: Harness = {
    db,
    graph: undefined as never,
    filePath,
    now: new Date(2026, 7, 13, 10, 0).getTime(),
    sessions: [],
    evidence: [],
    extractor: new FakeExtractor(),
    consolidator: undefined as never
  }
  h.graph = createSqliteMemoryGraph(db, { now: () => h.now, lambda: 0.25 })
  h.consolidator = createEpisodeConsolidator({
    now: () => h.now,
    graph: h.graph,
    readSessions: () => h.sessions,
    taskTitle: (taskId) => `任务 ${taskId}`,
    getExtractor: () => h.extractor,
    readEvidence: (from, to) =>
      h.evidence.filter((e) => e.at >= from && e.at < to).map((e) => ({ source: e.source, windowTitle: e.windowTitle })),
    log: () => {}
  })
  return h
}

afterEach(() => {
  for (const db of openDbs) closeDatabase(db)
  openDbs.length = 0
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

function session(over: Partial<TaskSession> = {}): TaskSession {
  return {
    id: 's_1',
    taskId: 't1',
    startedAt: new Date(2026, 7, 13, 9, 0).getTime(),
    endedAt: new Date(2026, 7, 13, 9, 50).getTime(),
    confidence: 0.8,
    transitionReason: 'user_completed',
    ...over
  }
}

const at = (hh: number, mm = 0): number => new Date(2026, 7, 13, hh, mm).getTime()

/** 每批一条事实：episodeId 指向批内首个 episode。 */
function oneFactPerBatch(content: string, type = 'pattern') {
  return (episodes: EpisodeRecord[]): ExtractedFact[] =>
    episodes.map((ep, i) => ({
      id: `f${i}`,
      episodeId: ep.id,
      type,
      content
    }))
}

describe('episodeConsolidator — 三种触发', () => {
  it('会话结束触发：闭合 episode 落库（免费）→ 整批提取 → 事实入库 + 来源链', async () => {
    const h = makeHarness()
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    h.extractor.nodesBuilder = (eps) => [
      { id: 'f1', episodeId: eps[0].id, type: 'pattern', content: '用户上午用编辑器写代码' }
    ]
    h.extractor.timestampsBuilder = (facts) => facts.map((f) => ({ factId: f.id, validAt: at(9), expiredAt: null }))

    const r = await h.consolidator.run()

    expect(r.triggers).toContain('session-end')
    expect(r.synced).toBe(1)
    expect(r.batch).toBe(1)
    expect(r.factsWritten).toBe(1)
    expect(r.failed).toBe(false)

    // episode：sessionId/endedAt/内容（任务标题在原始材料里），已标记完成。
    const eps = h.graph.listEpisodes()
    expect(eps).toHaveLength(1)
    expect(eps[0].sessionId).toBe('s1')
    expect(eps[0].endedAt).toBe(at(9, 50))
    expect(eps[0].content).toContain('任务 t1')
    expect(eps[0].summary).not.toBeNull()
    expect(h.graph.listEpisodes({ pendingOnly: true })).toHaveLength(0)

    // 来源链：fact.episodeId 指向源 episode。
    const facts = h.graph.listFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].episodeId).toBe(eps[0].id)
    expect(facts[0].source).toBe('inferred')
    expect(facts[0].intent).toBe('raw-extract')
    expect(facts[0].validAt).toBe(at(9))

    // 提取调用预算：整批恰好 2 次。
    expect(h.extractor.nodesCalls).toBe(1)
    expect(h.extractor.timestampsCalls).toBe(1)
  })

  it('时段边界触发：进行中会话在 12:00 切段整理，会话结束后补尾段', async () => {
    const h = makeHarness()
    // 会话 09:00 开始、尚未结束；14:00 才结束。
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: undefined, transitionReason: '' })]
    h.extractor.nodesBuilder = (eps) => eps.map((ep, i) => ({ id: `f${i}`, episodeId: ep.id, type: 'pattern', content: '用户专注开发' }))

    // 第一次 run（11:00）：无触发（时段键记录），零 LLM 调用。
    h.now = at(11)
    const first = await h.consolidator.run()
    expect(first.triggers).toHaveLength(0)
    expect(h.extractor.nodesCalls).toBe(0)

    // 跨过 12:00 边界：09:00-12:00 chunk 闭合并整理。
    h.now = at(12, 5)
    const second = await h.consolidator.run()
    expect(second.triggers).toContain('boundary')
    expect(second.batch).toBe(1)
    expect(h.extractor.nodesCalls).toBe(1)

    const eps1 = h.graph.listEpisodes()
    expect(eps1).toHaveLength(1)
    expect(eps1[0].startedAt).toBe(at(9))
    expect(eps1[0].endedAt).toBe(at(12))
    expect(eps1[0].summary).not.toBeNull()

    // 会话 14:00 结束：尾段 [12:00, 14:00] 补落库并整理。
    h.sessions[0] = { ...h.sessions[0], endedAt: at(14) }
    const third = await h.consolidator.run()
    expect(third.triggers).toContain('session-end')
    expect(third.synced).toBe(1)
    expect(h.extractor.nodesCalls).toBe(2)

    const eps2 = h.graph.listEpisodes()
    expect(eps2).toHaveLength(2)
    expect(eps2[1].startedAt).toBe(at(12))
    expect(eps2[1].endedAt).toBe(at(14))
    expect(eps2[1].summary).not.toBeNull()
  })

  it('6h 兜底触发：开段满 6h 切段整理（夜窗口无边界可等）', async () => {
    const h = makeHarness()
    // 19:00 开始的长会话（下一个边界是次日 06:00，11 小时后）。
    h.sessions = [session({ id: 's1', startedAt: at(19), endedAt: undefined, transitionReason: '' })]
    h.extractor.nodesBuilder = (eps) => eps.map((ep, i) => ({ id: `f${i}`, episodeId: ep.id, type: 'pattern', content: '用户深夜工作' }))

    h.now = at(19) // 首个 run：无触发
    expect((await h.consolidator.run()).triggers).toHaveLength(0)

    // 次日 01:00 = 满 6h：fallback 触发（无边界跨过）。
    h.now = new Date(2026, 7, 14, 1, 0).getTime()
    const r = await h.consolidator.run()
    expect(r.triggers).toContain('fallback')
    expect(r.batch).toBe(1)
    expect(h.extractor.nodesCalls).toBe(1)

    const eps = h.graph.listEpisodes()
    expect(eps).toHaveLength(1)
    expect(eps[0].startedAt).toBe(at(19))
    expect(eps[0].endedAt).toBe(at(19) + FALLBACK_MS)
    expect(eps[0].summary).not.toBeNull()
  })
})

describe('episodeConsolidator — 调用预算与失败降级', () => {
  it('整批多 episode 恰好 2 次 LLM 调用；无触发时零调用', async () => {
    const h = makeHarness()
    h.sessions = [
      session({ id: 's1', startedAt: at(9), endedAt: at(9, 30) }),
      session({ id: 's2', taskId: 't2', startedAt: at(9, 40), endedAt: at(10, 10) }),
      session({ id: 's3', taskId: 't3', startedAt: at(10, 20), endedAt: at(10, 50) })
    ]
    h.extractor.nodesBuilder = (eps) =>
      eps.map((ep, i) => ({ id: `f${i}`, episodeId: ep.id, type: 'pattern', content: `事实 ${i}` }))
    h.extractor.timestampsBuilder = (facts) => facts.map((f) => ({ factId: f.id, validAt: null, expiredAt: null }))

    const r = await h.consolidator.run()
    expect(r.batch).toBe(3)
    expect(r.factsWritten).toBe(3)
    // 整批 combined extraction：节点边一次 + 时间戳一次。
    expect(h.extractor.nodesCalls).toBe(1)
    expect(h.extractor.timestampsCalls).toBe(1)

    // 同状态再跑：无新触发 → 零 LLM 调用。
    const again = await h.consolidator.run()
    expect(again.triggers).toHaveLength(0)
    expect(h.extractor.nodesCalls).toBe(1)
    expect(h.extractor.timestampsCalls).toBe(1)
  })

  it('节点提取失败：静默降级，无事实写入，episode 保持 pending', async () => {
    const h = makeHarness()
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    h.extractor.failNodes = true

    const r = await h.consolidator.run()
    expect(r.failed).toBe(true)
    expect(r.factsWritten).toBe(0)
    expect(h.graph.listFacts()).toHaveLength(0)
    // 无部分写入：episode 仍未标记（summary null、仍在 pending）。
    expect(h.graph.listEpisodes({ pendingOnly: true })).toHaveLength(1)
    expect(h.graph.listEpisodes()[0].summary).toBeNull()
  })

  it('时间戳提取失败：已提取的事实也不落库（无部分写入）', async () => {
    const h = makeHarness()
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    h.extractor.nodesBuilder = (eps) => [
      { id: 'f1', episodeId: eps[0].id, type: 'pattern', content: '这条不该落库' }
    ]
    h.extractor.failTimestamps = true

    const r = await h.consolidator.run()
    expect(r.failed).toBe(true)
    expect(r.factsWritten).toBe(0)
    expect(h.graph.listFacts()).toHaveLength(0)
    expect(h.graph.listEpisodes({ pendingOnly: true })).toHaveLength(1)
  })

  it('失败后下一触发自动重试：旧 pending 与新 episode 同批整理', async () => {
    const h = makeHarness()
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    h.extractor.failNodes = true
    expect((await h.consolidator.run()).failed).toBe(true)

    // 提取器恢复；新的已结束会话触发下一轮。
    h.extractor.failNodes = false
    h.extractor.nodesBuilder = (eps) => eps.map((ep, i) => ({ id: `f${i}`, episodeId: ep.id, type: 'pattern', content: '重试成功' }))
    h.sessions.push(session({ id: 's2', taskId: 't2', startedAt: at(10), endedAt: at(10, 30) }))

    const r = await h.consolidator.run()
    expect(r.failed).toBe(false)
    expect(r.batch).toBe(2) // 旧 pending + 新 episode
    expect(r.factsWritten).toBe(2)
    expect(h.graph.listEpisodes({ pendingOnly: true })).toHaveLength(0)
  })

  it('并发调用共享一轮 run（in-flight 保护）：同批只提取一次', async () => {
    const h = makeHarness()
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    h.extractor.nodesBuilder = (eps) => [
      { id: 'f1', episodeId: eps[0].id, type: 'pattern', content: '并发只跑一轮' }
    ]
    // 慢提取器：挂起首轮，验证第二轮 run 复用同一 in-flight 执行。
    let release = (): void => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const original = h.extractor.extractNodesAndEdges.bind(h.extractor)
    h.extractor.extractNodesAndEdges = async (eps) => {
      await gate
      return original(eps)
    }

    const p1 = h.consolidator.run()
    const p2 = h.consolidator.run()
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.batch).toBe(1)
    expect(r2.batch).toBe(1)
    expect(h.extractor.nodesCalls).toBe(1)
    expect(h.extractor.timestampsCalls).toBe(1)
    // 同一轮：事实只落一次（合并 hitCount 不虚增）。
    expect(h.graph.listFacts()).toHaveLength(1)
    expect(h.graph.listFacts()[0].hitCount).toBe(0)
  })

  it('空提取 = 正常零产出：标记完成、不花第二次调用', async () => {
    const h = makeHarness()
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    h.extractor.nodesBuilder = () => [] // 空批次返回空数组

    const r = await h.consolidator.run()
    expect(r.failed).toBe(false)
    expect(r.factsWritten).toBe(0)
    expect(h.extractor.nodesCalls).toBe(1)
    expect(h.extractor.timestampsCalls).toBe(0) // 空事实不花第二次调用
    expect(h.graph.listEpisodes({ pendingOnly: true })).toHaveLength(0) // 已标记
  })

  it('无时间戳的重提取合并不覆盖旧时间窗口（省略键 = 保留窗口路径）', async () => {
    const h = makeHarness()
    // 第一批带时间窗口。
    h.extractor.nodesBuilder = oneFactPerBatch('用户偏好深夜工作', 'preference')
    h.extractor.timestampsBuilder = (facts) => facts.map((f) => ({ factId: f.id, validAt: at(9), expiredAt: null }))
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    expect((await h.consolidator.run()).factsWritten).toBe(1)

    // 第二批同内容但时间戳提取未回填（空）→ 合并走保留旧窗口路径。
    h.extractor.timestampsBuilder = () => []
    h.sessions = [session({ id: 's2', taskId: 't2', startedAt: at(10), endedAt: at(10, 30) })]
    expect((await h.consolidator.run()).factsWritten).toBe(1)

    const facts = h.graph.listFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].validAt).toBe(at(9)) // 窗口未被清成 null
  })

  it('提取器不可用（AI 未接线）：episode 落库照常（免费），提取跳过不标记', async () => {
    const h = makeHarness()
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    const noExtractor = createEpisodeConsolidator({
      now: () => h.now,
      graph: h.graph,
      readSessions: () => h.sessions,
      taskTitle: (id) => id,
      getExtractor: () => null
    })
    const r = await noExtractor.run()
    expect(r.failed).toBe(false)
    expect(r.factsWritten).toBe(0)
    // episode 免费落库，保持 pending（AI 恢复后的下一触发补整理）。
    expect(h.graph.listEpisodes()).toHaveLength(1)
    expect(h.graph.listEpisodes({ pendingOnly: true })).toHaveLength(1)
  })
})

describe('episodeConsolidator — 去重/矛盾消解与来源链', () => {
  it('同内容事实跨批合并强化（复用 addFact 去重）；无重复行', async () => {
    const h = makeHarness()
    h.extractor.nodesBuilder = oneFactPerBatch('用户的工作模式是深度专注', 'pattern')

    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    expect((await h.consolidator.run()).factsWritten).toBe(1)

    // 第二、三批同内容 → 全部并入首行：1 行、hitCount 随合并逐次 +1。
    h.sessions = [session({ id: 's2', taskId: 't2', startedAt: at(10), endedAt: at(10, 30) })]
    expect((await h.consolidator.run()).factsWritten).toBe(1)
    h.sessions = [session({ id: 's3', taskId: 't3', startedAt: at(11), endedAt: at(11, 30) })]
    expect((await h.consolidator.run()).factsWritten).toBe(1)

    const facts = h.graph.listFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].hitCount).toBe(2)
  })

  it('矛盾消解复用：同主语异取值 + 时间窗口 → 旧事实写 invalid_at，绝不覆盖', async () => {
    const h = makeHarness()
    // 第一段：北京。
    h.extractor.nodesBuilder = oneFactPerBatch('用户所在城市是北京', 'profile')
    h.extractor.timestampsBuilder = (facts) => facts.map((f) => ({ factId: f.id, validAt: at(9), expiredAt: null }))
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    expect((await h.consolidator.run()).factsWritten).toBe(1)

    // 第二段：上海（同主语键 + validAt 窗口）→ 北京 invalid_at = 上海 validAt。
    h.extractor.nodesBuilder = oneFactPerBatch('用户所在城市是上海', 'profile')
    h.extractor.timestampsBuilder = (facts) => facts.map((f) => ({ factId: f.id, validAt: at(13), expiredAt: null }))
    h.sessions = [session({ id: 's2', taskId: 't2', startedAt: at(12), endedAt: at(14) })]
    expect((await h.consolidator.run()).factsWritten).toBe(1)

    const all = h.graph.listFacts({ includeInvalidated: true })
    expect(all).toHaveLength(2)
    const beijing = all.find((f) => f.content.includes('北京'))
    const shanghai = all.find((f) => f.content.includes('上海'))
    expect(beijing?.invalidAt).toBe(at(13))
    expect(shanghai?.invalidAt).toBeNull()
    // 默认查询（不含失效行）只剩上海。
    expect(h.graph.listFacts()).toHaveLength(1)
  })

  it('来源链完整性：episodeId 不在批次内的事实被丢弃，不虚构来源', async () => {
    const h = makeHarness()
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    h.extractor.nodesBuilder = (eps) => [
      { id: 'f1', episodeId: eps[0].id, type: 'pattern', content: '合法来源事实' },
      { id: 'f2', episodeId: 'ep_nonexistent', type: 'pattern', content: '虚构来源事实' }
    ]
    h.extractor.timestampsBuilder = (facts) => facts.map((f) => ({ factId: f.id, validAt: null, expiredAt: null }))

    const r = await h.consolidator.run()
    expect(r.failed).toBe(false)
    const facts = h.graph.listFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toBe('合法来源事实')
  })

  it('episode 原始材料包含 L0 证据（应用/窗口）与任务标题', async () => {
    const h = makeHarness()
    h.now = at(9, 10)
    h.evidence = [
      { at: at(9, 5), source: 'code.exe', windowTitle: 'suggestionEngine.ts' },
      { at: at(9, 6), source: 'code.exe', windowTitle: 'suggestionEngine.ts' },
      { at: at(9, 7), source: 'browser.exe', windowTitle: 'GitHub' }
    ]
    h.sessions = [session({ id: 's1', startedAt: at(9), endedAt: at(9, 50) })]
    h.extractor.nodesBuilder = (eps) => eps.map((ep, i) => ({ id: `f${i}`, episodeId: ep.id, type: 'pattern', content: 'x' }))

    await h.consolidator.run()

    const content = h.graph.listEpisodes()[0].content
    expect(content).toContain('任务 t1')
    expect(content).toContain('code.exe')
    expect(content).toContain('suggestionEngine.ts')
    expect(content).toContain('× 2')
    expect(content).toContain('browser.exe')
  })
})

describe('episodeConsolidator — ChatFn 适配器', () => {
  it('createChatEpisodeExtractor：两次结构化调用 + 边界断言', async () => {
    const chatCalls: Array<{ schema?: unknown }> = []
    const chat = async (req: { schema?: unknown }): Promise<ChatResult> => {
      chatCalls.push({ schema: req.schema })
      if (chatCalls.length === 1) {
        return { ok: true, content: '{}', parsed: { facts: [{ id: 'f1', episodeId: 'ep_1', type: 'pattern', content: '用户专注' }] }, provider: {} as never, providerIndex: 0 }
      }
      return { ok: true, content: '{}', parsed: { facts: [{ factId: 'f1', validAt: 100, expiredAt: null }] }, provider: {} as never, providerIndex: 0 }
    }
    const extractor = createChatEpisodeExtractor(chat)
    const facts = await extractor.extractNodesAndEdges([{ id: 'ep_1', sessionId: null, startedAt: 0, endedAt: 100, summary: null, content: 'x', createdAt: 0 }])
    expect(facts.facts[0].episodeId).toBe('ep_1')
    const timestamps = await extractor.extractTimestamps(facts.facts)
    expect(timestamps[0]).toEqual({ factId: 'f1', validAt: 100, expiredAt: null })
    expect(chatCalls).toHaveLength(2)
    expect(chatCalls[0].schema).toBeDefined()
  })

  it('createChatEpisodeExtractor：provider 失败 → 抛错（整理侧视为失败降级）', async () => {
    const chat = async (): Promise<ChatResult> => ({ ok: false, error: 'provider down', attempts: [] })
    const extractor = createChatEpisodeExtractor(chat)
    await expect(extractor.extractNodesAndEdges([])).rejects.toThrow('provider down')
  })
})
