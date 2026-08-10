import { describe, expect, it, vi } from 'vitest'

import {
  MemoryStore,
  STORAGE_VERSION,
  type MemoryIndex,
  type MemoryStoreDeps
} from '../electron/store/MemoryStore'
import type { Memory, MemoryType } from '../shared/types'

/** In-memory storage + fake clock harness. */
function makeHarness(deps?: Partial<Pick<MemoryStoreDeps, 'decay'>>) {
  let saved: MemoryIndex | null = null
  let now = 1_000_000
  const store = new MemoryStore({
    load: () => saved,
    save: (index) => { saved = index },
    now: () => now,
    ...deps
  })
  store.load()
  return {
    store,
    storage: { load: () => saved, save: (index: MemoryIndex) => { saved = index } },
    tick: (ms: number) => { now += ms },
    now: () => now
  }
}

const suggest = (store: MemoryStore, type: MemoryType, content: string) =>
  store.suggestMemory({ type, content, source: 'task-feedback' })

describe('MemoryStore — four-type writes', () => {
  it('writes all four memory types as suggested candidates', () => {
    const { store, now } = makeHarness()
    const specs: [MemoryType, string][] = [
      ['identity', '用户是机械+软件双学位'],
      ['tool', '常用 koffi FFI'],
      ['project', 'Trace 剪贴板管理器'],
      ['workflow', '先类型检查再提交']
    ]
    for (const [type, content] of specs) {
      const m = store.suggestMemory({ type, content, source: 'ai-suggest' })
      expect(m).not.toBeNull()
      expect(m!.id).toMatch(/^m_/)
      expect(m!.type).toBe(type)
      expect(m!.content).toBe(content)
      expect(m!.userState).toBe('suggested') // never live without user confirmation
      expect(m!.hitCount).toBe(0)
      expect(m!.confidence).toBe(0)
      expect(m!.source).toBe('ai-suggest')
      expect(m!.createdAt).toBe(now())
      expect(m!.lastSeenAt).toBe(now())
    }
    expect(store.list()).toHaveLength(4)
  })

  it('passes any source through', () => {
    const { store } = makeHarness()
    const m = store.suggestMemory({ type: 'project', content: 'x', source: 'user' })
    expect(m!.source).toBe('user')
  })

  it('rejects blank content and invalid types', () => {
    const { store } = makeHarness()
    expect(store.suggestMemory({ type: 'tool', content: '   ', source: 'user' })).toBeNull()
    expect(store.suggestMemory({ type: 'zombie' as never, content: 'x', source: 'user' })).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  it('dedupes identical content+type in any state (case-insensitive)', () => {
    const { store } = makeHarness()
    const m = suggest(store, 'project', 'CAD Agent')
    expect(m).not.toBeNull()
    expect(suggest(store, 'project', 'cad agent')).toBeNull() // same content, other case
    expect(suggest(store, 'tool', 'CAD Agent')).not.toBeNull() // other type is fine
    store.ignore(m!.id)
    expect(suggest(store, 'project', 'CAD Agent')).toBeNull() // still deduped after ignore
  })
})

describe('MemoryStore — suggested → confirmed/ignored/banned flow', () => {
  it('confirms a suggested candidate: live, hitCount 1, lastSeenAt bumped', () => {
    const { store, tick, now } = makeHarness()
    const m = suggest(store, 'project', 'CAD Agent')!
    tick(5_000)
    expect(store.confirm(m.id)).toBe(true)
    const got = store.get(m.id)!
    expect(got.userState).toBe('confirmed')
    expect(got.hitCount).toBe(1)
    expect(got.lastSeenAt).toBe(now())
    expect(got.confidence).toBeCloseTo(0.5) // sat(1), Δt = 0
  })

  it('only confirms suggested candidates', () => {
    const { store } = makeHarness()
    const confirmed = suggest(store, 'tool', 'koffi')!
    store.confirm(confirmed.id)
    expect(store.confirm(confirmed.id)).toBe(false) // already confirmed
    const ignored = suggest(store, 'tool', 'other')!
    store.ignore(ignored.id)
    expect(store.confirm(ignored.id)).toBe(false)
    const banned = suggest(store, 'tool', 'third')!
    store.ban(banned.id)
    expect(store.confirm(banned.id)).toBe(false)
    expect(store.confirm('m_missing')).toBe(false)
  })

  it('ignores a suggested candidate without touching counters', () => {
    const { store } = makeHarness()
    const confirmed = suggest(store, 'workflow', '先测后提')!
    store.confirm(confirmed.id)
    const ignored = suggest(store, 'workflow', '先测后提2')!
    store.ignore(ignored.id)
    expect(store.get(ignored.id)!.userState).toBe('ignored')
    expect(store.get(ignored.id)!.hitCount).toBe(0)
    expect(store.ignore(confirmed.id)).toBe(false) // confirmed is not ignorable
  })

  it('bans from any state; the ban is permanent and idempotent', () => {
    const { store } = makeHarness()
    const suggested = suggest(store, 'project', 'CAD')!
    const confirmed = suggest(store, 'tool', 'koffi')!
    store.confirm(confirmed.id)

    expect(store.ban(suggested.id)).toBe(true)
    expect(store.ban(confirmed.id)).toBe(true)
    expect(store.get(suggested.id)!.userState).toBe('banned')
    expect(store.get(confirmed.id)!.userState).toBe('banned')
    expect(store.ban(suggested.id)).toBe(false) // already banned
    expect(store.ban('m_missing')).toBe(false)
  })

  it('candidates() only lists pending suggestions; decisions remove them', () => {
    const { store } = makeHarness()
    const a = suggest(store, 'project', 'A')!
    const b = suggest(store, 'tool', 'B')!
    store.confirm(a.id)
    store.ban(b.id)
    const c = suggest(store, 'workflow', 'C')!
    store.ignore(c.id)
    const d = suggest(store, 'identity', 'D')!
    expect(store.candidates().map((m) => m.id)).toEqual([d.id])
  })
})

describe('MemoryStore — banned matching (keyword and type)', () => {
  it('matches a banned keyword as a case-insensitive substring across types', () => {
    const { store } = makeHarness()
    const m = suggest(store, 'workflow', 'CAD 设计')!
    store.ban(m.id)
    expect(store.isBanned('开发 CAD 设计工具', 'project')).toBe(true)
    expect(store.isBanned('开发 cad 设计工具', 'identity')).toBe(true)
    expect(store.isBanned('写周报', 'project')).toBe(false)
  })

  it('a banned type retires the whole category', () => {
    const { store } = makeHarness()
    const m = suggest(store, 'workflow', '先写设计文档')!
    store.ban(m.id)
    expect(store.isBanned('完全不相关的 workflow 内容', 'workflow')).toBe(true)
    expect(store.isBanned('完全不相关的 project 内容', 'project')).toBe(false)
  })

  it('blocks suggestions that hit a keyword or type ban', () => {
    const { store } = makeHarness()
    const m = suggest(store, 'project', 'CAD 建模')!
    store.ban(m.id)
    expect(suggest(store, 'tool', 'CAD 建模软件')).toBeNull() // keyword
    expect(suggest(store, 'project', '别的项目')).toBeNull() // type
    expect(suggest(store, 'tool', 'koffi FFI')).not.toBeNull() // unaffected
  })

  it('isBanned ignores non-banned memories', () => {
    const { store } = makeHarness()
    const confirmed = suggest(store, 'tool', 'koffi')!
    store.confirm(confirmed.id)
    const ignored = suggest(store, 'tool', 'rust')!
    store.ignore(ignored.id)
    expect(store.isBanned('koffi FFI', 'tool')).toBe(false)
    expect(store.isBanned('rust', 'tool')).toBe(false)
  })
})

describe('MemoryStore — decay formula (injected clock, sat × exp)', () => {
  it('applies sat(hitCount) × exp(-λ·weeks) with λ = 0.25/week', () => {
    const { store, tick } = makeHarness()
    const m = suggest(store, 'project', 'CAD Agent')!
    store.confirm(m.id) // hitCount 1 → sat = 0.5
    tick(14 * 24 * 60 * 60 * 1000) // 2 weeks
    const expected = 0.5 * Math.exp(-0.25 * 2)
    expect(store.get(m.id)!.confidence).toBeCloseTo(expected, 10)
  })

  it('reinforces on hits and restarts decay from the hit', () => {
    const { store, tick } = makeHarness()
    const m = suggest(store, 'project', 'CAD Agent')!
    store.confirm(m.id)
    tick(14 * 24 * 60 * 60 * 1000)
    expect(store.hit(m.id)).toBe(true)
    expect(store.get(m.id)!.hitCount).toBe(2)
    expect(store.get(m.id)!.confidence).toBeCloseTo(2 / 3, 10) // sat(2), decay reset
    tick(7 * 24 * 60 * 60 * 1000)
    expect(store.get(m.id)!.confidence).toBeCloseTo((2 / 3) * Math.exp(-0.25), 10)
  })

  it('hit() only applies to confirmed memories', () => {
    const { store } = makeHarness()
    const suggested = suggest(store, 'tool', 'koffi')!
    expect(store.hit(suggested.id)).toBe(false)
    const confirmed = suggest(store, 'tool', 'rust')!
    store.confirm(confirmed.id)
    const ignored = suggest(store, 'tool', 'go')!
    store.ignore(ignored.id)
    expect(store.hit(ignored.id)).toBe(false)
    expect(store.hit('m_missing')).toBe(false)
    expect(store.hit(confirmed.id)).toBe(true)
  })

  it('persisted confidence stays at the mutation-time value; reads are time-aware', () => {
    const { store, storage, tick } = makeHarness()
    const m = suggest(store, 'project', 'CAD Agent')!
    store.confirm(m.id)
    tick(14 * 24 * 60 * 60 * 1000)
    expect(storage.load()!.memories[0]!.confidence).toBe(0.5) // sat(1) at Δt = 0
    expect(store.get(m.id)!.confidence).toBeCloseTo(0.5 * Math.exp(-0.25 * 2), 10)
  })

  it('uses injected decay parameters (constructor + setDecay), clamped like Settings', () => {
    const { store, tick } = makeHarness({ decay: { lambda: 0.5 } })
    const m = suggest(store, 'project', 'CAD Agent')!
    store.confirm(m.id)
    tick(7 * 24 * 60 * 60 * 1000)
    expect(store.get(m.id)!.confidence).toBeCloseTo(0.5 * Math.exp(-0.5), 10) // λ = 0.5 from deps

    store.setDecay({ lambda: 0 }) // clamped to 0.01
    store.hit(m.id) // reset decay baseline at hitCount 2
    tick(7 * 24 * 60 * 60 * 1000)
    expect(store.get(m.id)!.confidence).toBeCloseTo((2 / 3) * Math.exp(-0.01), 10)

    store.setDecay({ lambda: 9 }) // clamped to 1
    store.hit(m.id)
    tick(7 * 24 * 60 * 60 * 1000)
    expect(store.get(m.id)!.confidence).toBeCloseTo((3 / 4) * Math.exp(-1), 10)
  })

  it('list() reports time-aware confidence and is detached from the store', () => {
    const { store, tick } = makeHarness()
    const m = suggest(store, 'tool', 'koffi')!
    store.confirm(m.id)
    tick(7 * 24 * 60 * 60 * 1000)
    const list = store.list()
    expect(list[0]!.confidence).toBeCloseTo(0.5 * Math.exp(-0.25), 10)
    ;(list as Memory[]).push(list[0]!) // mutating the view must not touch the store
    expect(store.list()).toHaveLength(1)
  })
})

describe('MemoryStore — cleanup candidates', () => {
  it('keeps fresh and strong memories out of the cleanup list', () => {
    const { store, tick } = makeHarness()
    const fresh = suggest(store, 'project', '新项目')!
    store.confirm(fresh.id)
    tick(10 * 24 * 60 * 60 * 1000)
    expect(store.cleanupCandidates()).toHaveLength(0)
    tick(50 * 24 * 60 * 60 * 1000) // now stale (60 days)
    expect(store.cleanupCandidates().map((m) => m.id)).toEqual([fresh.id])
  })

  it('only lists stale + low-scoring memories (formula-driven)', () => {
    const { store, tick } = makeHarness()
    const weak = suggest(store, 'project', '弱记忆')!
    store.confirm(weak.id) // sat(1) = 0.5
    const strong = suggest(store, 'tool', '强记忆')!
    store.confirm(strong.id)
    for (let i = 0; i < 9; i++) store.hit(strong.id) // sat(10) ≈ 0.909
    tick(60 * 24 * 60 * 60 * 1000)

    const candidates = store.cleanupCandidates()
    expect(candidates.map((m) => m.id)).toEqual([weak.id])
    // weak: 0.5 × exp(-0.25·60/7) ≈ 0.0587 < 0.1; strong: ≈ 0.1067 ≥ 0.1
    expect(store.get(weak.id)!.confidence).toBeCloseTo(0.5 * Math.exp(-0.25 * (60 / 7)), 10)
  })

  it('suggested and banned memories are never cleanup candidates', () => {
    const { store, tick } = makeHarness()
    const suggested = suggest(store, 'workflow', '待决定')!
    const banned = suggest(store, 'identity', '永禁')!
    store.ban(banned.id)
    tick(100 * 24 * 60 * 60 * 1000)
    expect(store.cleanupCandidates()).toHaveLength(0)
    void suggested
  })

  it('stale ignored memories rot into the cleanup list (hitCount 0 → score 0)', () => {
    const { store, tick } = makeHarness()
    const ignored = suggest(store, 'tool', '忽略的')!
    store.ignore(ignored.id)
    tick(60 * 24 * 60 * 60 * 1000)
    expect(store.cleanupCandidates().map((m) => m.id)).toEqual([ignored.id])
  })

  it('sorts candidates by confidence ascending (worst first)', () => {
    const { store, tick } = makeHarness()
    const ignored = suggest(store, 'tool', '零分')!
    store.ignore(ignored.id) // confidence 0
    const weak = suggest(store, 'project', '低分')!
    store.confirm(weak.id) // 0.5 × decay
    tick(60 * 24 * 60 * 60 * 1000)
    expect(store.cleanupCandidates().map((m) => m.id)).toEqual([ignored.id, weak.id])
  })

  it('deletes cleanup candidates only via explicit delete()', () => {
    const { store, tick, storage } = makeHarness()
    const m = suggest(store, 'project', '过期')!
    store.confirm(m.id)
    tick(60 * 24 * 60 * 60 * 1000)
    expect(store.cleanupCandidates()).toHaveLength(1)
    expect(store.delete(m.id)).toBe(true)
    expect(store.delete(m.id)).toBe(false)
    expect(store.delete('m_missing')).toBe(false)
    expect(store.list()).toHaveLength(0)
    expect(storage.load()!.memories).toHaveLength(0) // deletion persisted
  })

  it('honors setDecay for staleDays (clamped to 7-365)', () => {
    const { store, tick } = makeHarness()
    store.setDecay({ staleDays: 5 }) // clamped up to 7
    const m = suggest(store, 'tool', '忽略')!
    store.ignore(m.id)
    tick(6 * 24 * 60 * 60 * 1000)
    expect(store.cleanupCandidates()).toHaveLength(0)
    tick(8 * 24 * 60 * 60 * 1000) // 14 days ≥ 7
    expect(store.cleanupCandidates().map((x) => x.id)).toEqual([m.id])
  })
})

describe('MemoryStore — persistence round-trip', () => {
  it('persists with a version field and reloads identically', () => {
    const harness = makeHarness()
    const { store } = harness
    const a = suggest(store, 'project', 'CAD Agent')!
    store.confirm(a.id)
    store.hit(a.id)
    const b = suggest(store, 'tool', 'koffi FFI')!
    store.ban(b.id)
    const c = suggest(store, 'identity', '双学位')!
    store.ignore(c.id)
    const d = suggest(store, 'workflow', '先测后提')!

    expect(harness.storage.load()!.version).toBe(STORAGE_VERSION)

    const reloaded = new MemoryStore({ load: harness.storage.load, save: harness.storage.save, now: harness.now })
    reloaded.load()
    expect(reloaded.list()).toEqual(store.list())
    expect(reloaded.candidates().map((m) => m.id)).toEqual([d.id])
  })

  it('salvages corrupt or missing indexes instead of crashing', () => {
    const empty = new MemoryStore({ load: () => null, save: () => {} })
    empty.load()
    expect(empty.list()).toEqual([])

    const garbage = new MemoryStore({ load: () => ({ version: 1, memories: 'nope' as never }), save: () => {} })
    garbage.load()
    expect(garbage.list()).toEqual([])
  })

  it('drops structurally broken records, repairs weak fields, dedupes ids', () => {
    const broken = [
      null,
      { id: 'm_ok', type: 'project', content: '好', source: 'task-feedback', userState: 'confirmed', confidence: 0.5, hitCount: 1, lastSeenAt: 3, createdAt: 1 },
      { id: 'm_noContent', type: 'tool', content: '   ' },
      { id: 'm_badType', type: 'zombie', content: 'x' },
      { id: 'm_badState', type: 'tool', content: '坏状态', userState: 'exploding' },
      { id: 'm_badState', type: 'tool', content: '重复id' },
      { id: 'm_badNums', type: 'workflow', content: '坏数字', hitCount: -3, confidence: 5, lastSeenAt: 'x', createdAt: NaN },
      { id: 'm_badSource', type: 'identity', content: '坏来源', source: 'llm' }
    ]
    let saved: MemoryIndex | null = null
    const persisted = new MemoryStore({ load: () => ({ version: 1, memories: broken as never }), save: (i) => { saved = i } })
    persisted.load()

    const byId = new Map(persisted.list().map((m) => [m.id, m]))
    expect(byId.size).toBe(4)
    expect(byId.get('m_ok')!.userState).toBe('confirmed')
    expect(byId.get('m_badState')!.userState).toBe('suggested') // unreadable state never resurrects as live
    expect(byId.get('m_badNums')!.hitCount).toBe(0)
    expect(byId.get('m_badNums')!.lastSeenAt).toBe(0)
    expect(byId.get('m_badNums')!.createdAt).toBe(0)
    expect(byId.get('m_badSource')!.source).toBe('ai-suggest')

    // list() reports time-aware confidence, so the clamp is only visible on
    // disk: flush the sanitized index with one mutation.
    persisted.delete('m_ok')
    const stored = new Map(saved!.memories.map((m) => [m.id, m]))
    expect(stored.get('m_badNums')!.confidence).toBe(1) // clamped to [0,1]
  })

  it('logs tagged diagnostics: one init line, tagged errors on salvage', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new MemoryStore({ load: () => ({ version: 1, memories: [{ id: 'm_x' }] as never }), save: () => {} })
      store.load()
      expect(info).toHaveBeenCalledWith(expect.stringContaining('[Memory] init complete'))
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[Memory] discarded 1 malformed record(s)'))
    } finally {
      info.mockRestore()
      error.mockRestore()
    }
  })
})
