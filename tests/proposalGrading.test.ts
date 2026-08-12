/**
 * Proposal grading (t47, spec 决策 9) — 纯模块单元测试。
 * 覆盖：升降级规则（禁 L3→L1 直升、L2→L1 升级）、近期同类拒绝两档、权重门槛、
 * 任务比对两路、批内去重两路、不变量 G（L1 ≤ 上限）。全部确定性输入直测。
 */
import { describe, expect, it } from 'vitest'
import {
  appCoverage,
  capL1,
  dedupBatch,
  defaultPatternScore,
  gradeProposal,
  L1_MIN_PATTERN_WEIGHT,
  L3_MAX_PATTERN_WEIGHT,
  MAX_L1_SUGGESTIONS,
  RECENT_REJECTION_MS,
  TASK_COVERAGE_THRESHOLD,
  TIME_OVERLAP_WINDOW_MS,
  type GradeInput
} from '../electron/store/proposalGrading'
import { derivePatternScore, type PatternScore } from '../electron/store/recommendationHistory'
import type { RecommendationLevel, RecommendationRecord, Task } from '../shared/types'

const NOW = 2_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 单次忽略后的模式权重（t46 衰减表 × BASE 0.5）。 */
function weightAfter(actionReason: 'wrong_task' | 'already_exists' | 'user_manually_dismissed' | 'not_now'): PatternScore {
  return derivePatternScore('pk', [
    { id: 'r', fingerprint: 'f', patternKey: 'pk', level: 2, shownAt: NOW - 8 * DAY, outcome: 'ignored', actionReason }
  ])
}

function record(overrides: Partial<RecommendationRecord> = {}): RecommendationRecord {
  return {
    id: 'r1',
    fingerprint: 'f',
    patternKey: 'pk',
    level: 2,
    shownAt: NOW - HOUR,
    outcome: 'noop',
    ...overrides
  }
}

function grade(overrides: Partial<GradeInput> = {}): RecommendationLevel {
  return gradeProposal({
    zone: 'high',
    margin: 0.3,
    marginFloor: 0.25,
    taskPoolSize: 2,
    coveredByTask: false,
    coveredByActiveTask: false,
    pattern: defaultPatternScore('pk'),
    lastRecord: record(),
    now: NOW,
    ...overrides
  })
}

function appRef(id: string, name: string, exePath?: string) {
  return { id, name, ...(exePath !== undefined ? { exePath } : {}) }
}

const CODE = 'c:/apps/code.exe'
const CHROME = 'c:/apps/chrome.exe'
const EXCEL = 'c:/apps/excel.exe'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Writing report',
    status: 'running',
    statusSource: 'system',
    apps: [appRef(CODE, 'Code'), appRef(CHROME, 'Chrome')],
    resources: [],
    windowTitles: [],
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: NOW - 1_000,
    activeMs: 0,
    ...overrides
  }
}

describe('gradeProposal — 升降级路径（决策 9）', () => {
  it('首次出现（无同类记录）→ L2：即使证据全绿也不直升 L1', () => {
    expect(grade({ lastRecord: undefined })).toBe(2)
  })

  it('L2 记录（noop 展示）→ 下一次同类出现升级 L1', () => {
    expect(grade({ lastRecord: record({ level: 2 }) })).toBe(1)
  })

  it('L1 记录 → 保持 L1', () => {
    expect(grade({ lastRecord: record({ level: 1 }) })).toBe(1)
  })

  it('L3 记录 → 最高 L2（禁 L3→L1 直升）', () => {
    expect(grade({ lastRecord: record({ level: 3 }) })).toBe(2)
  })

  it('从未展示过（无记录）即使有 L2 级权重也不升（升级必须经展示路径）', () => {
    expect(grade({ lastRecord: undefined, pattern: weightAfter('not_now') })).toBe(2)
  })
})

describe('gradeProposal — 近期同类拒绝（窗口 = L3 冷却 7 天）', () => {
  it('近期强拒 wrong_task → L3 不展示', () => {
    expect(
      grade({ lastRecord: record({ level: 1, outcome: 'ignored', actionReason: 'wrong_task', shownAt: NOW - HOUR }) })
    ).toBe(3)
  })

  it('近期强拒 already_exists → L3', () => {
    expect(
      grade({ lastRecord: record({ level: 1, outcome: 'ignored', actionReason: 'already_exists', shownAt: NOW - HOUR }) })
    ).toBe(3)
  })

  it('近期轻拒 not_now → L2 观察（不主动打扰）', () => {
    expect(
      grade({ lastRecord: record({ level: 1, outcome: 'ignored', actionReason: 'not_now', shownAt: NOW - HOUR }) })
    ).toBe(2)
  })

  it('近期手动关闭 → L2', () => {
    expect(
      grade({ lastRecord: record({ level: 2, outcome: 'dismissed', actionReason: 'user_manually_dismissed', shownAt: NOW - HOUR }) })
    ).toBe(2)
  })

  it('超过 7 天的旧拒绝不再挡（窗口过期，权重门槛接管）', () => {
    expect(
      grade({
        lastRecord: record({ level: 1, outcome: 'ignored', actionReason: 'wrong_task', shownAt: NOW - 8 * DAY }),
        pattern: weightAfter('wrong_task')
      })
    ).toBe(3) // 权重 0.1 仍低于 L3_MAX_PATTERN_WEIGHT 0.25 → L3
  })

  it('旧 not_now 拒绝 + 权重 0.4 → 够格 L1', () => {
    expect(
      grade({
        lastRecord: record({ level: 1, outcome: 'ignored', actionReason: 'not_now', shownAt: NOW - 8 * DAY }),
        pattern: weightAfter('not_now')
      })
    ).toBe(1)
  })
})

describe('gradeProposal — 模式权重门槛（t46 衰减可区分）', () => {
  it(`权重 < ${L3_MAX_PATTERN_WEIGHT}（单次 already_exists 0.2）→ L3 静默`, () => {
    expect(grade({ pattern: weightAfter('already_exists') })).toBe(3)
    expect(grade({ pattern: weightAfter('wrong_task') })).toBe(3) // 0.1 与 0.2 可区分
  })

  it('权重 0.3（单次手动关闭）→ 不 L3，但低于 L1 门槛 → L2', () => {
    expect(grade({ pattern: weightAfter('user_manually_dismissed') })).toBe(2)
  })

  it(`权重 ≥ ${L1_MIN_PATTERN_WEIGHT}（单次 not_now 0.4）→ L1 候选资格`, () => {
    expect(grade({ pattern: weightAfter('not_now') })).toBe(1)
  })

  it('默认权重 0.5（无历史）→ 不因权重挡路', () => {
    expect(grade({ pattern: defaultPatternScore('pk') })).toBe(1)
  })
})

describe('gradeProposal — 任务比对（与现有任务）', () => {
  it('被活跃任务覆盖（时段重叠 + 任务活跃）→ L3 明显重复丢弃', () => {
    expect(grade({ coveredByActiveTask: true })).toBe(3)
  })

  it('被现有任务覆盖（含归属目标）→ L2 命中强化，不升 L1', () => {
    expect(grade({ coveredByTask: true })).toBe(2)
  })

  it('低置信证据带 → 最高 L2', () => {
    expect(grade({ zone: 'low', lastRecord: record({ level: 2 }) })).toBe(2)
  })

  it('new 带 + 边距不足（任务池非空）→ L2', () => {
    expect(grade({ zone: 'new', margin: 0.1, marginFloor: 0.25, taskPoolSize: 2 })).toBe(2)
  })

  it('new 带 + 边距 ≥ 下限 → 证据稳定 → L1', () => {
    expect(grade({ zone: 'new', margin: 0.3, marginFloor: 0.25, taskPoolSize: 2 })).toBe(1)
  })

  it('new 带 + 任务池为空（无竞争退化态）→ 视为稳定 → L1', () => {
    expect(grade({ zone: 'new', margin: 0, marginFloor: 0.25, taskPoolSize: 0 })).toBe(1)
  })
})

describe('dedupBatch — 批内去重两路（决策 9）', () => {
  const entries = [
    { id: 'a', fingerprint: 'f1' },
    { id: 'b', fingerprint: 'f1' },
    { id: 'c', fingerprint: 'f2' }
  ]

  it('确定性路径：同指纹合并，先到者胜', () => {
    const merges = dedupBatch(entries, { semantic: false })
    expect(merges.get('a')).toEqual(['b'])
    expect(merges.size).toBe(1)
  })

  it('语义路径：草稿标题归一化相等合并（大小写/空白不敏感），无草稿回落指纹', () => {
    const merges = dedupBatch(
      [
        { id: 'a', fingerprint: 'f1', semanticLabel: '  Write   Report ' },
        { id: 'b', fingerprint: 'f2', semanticLabel: 'write report' },
        { id: 'c', fingerprint: 'f3' },
        { id: 'd', fingerprint: 'f3' }
      ],
      { semantic: true }
    )
    expect(merges.get('a')).toEqual(['b']) // 草稿语义合并
    expect(merges.get('c')).toEqual(['d']) // 无草稿 → 指纹兜底
    expect(merges.size).toBe(2)
  })

  it('语义路径：不同草稿不合并', () => {
    const merges = dedupBatch(
      [
        { id: 'a', fingerprint: 'f1', semanticLabel: 'Write report' },
        { id: 'b', fingerprint: 'f2', semanticLabel: 'Figma handoff' }
      ],
      { semantic: true }
    )
    expect(merges.size).toBe(0)
  })

  it('semantic=false 时忽略草稿（确定性签名兜底路径）', () => {
    const merges = dedupBatch(
      [
        { id: 'a', fingerprint: 'f1', semanticLabel: 'same draft' },
        { id: 'b', fingerprint: 'f2', semanticLabel: 'same draft' }
      ],
      { semantic: false }
    )
    expect(merges.size).toBe(0)
  })
})

describe('capL1 — 不变量 G：L1 数量 ≤ 上限', () => {
  it(`超出上限（${MAX_L1_SUGGESTIONS}）时按置信度降序保留，其余就地降 L2`, () => {
    const entries = [
      { id: 'low', level: 1 as RecommendationLevel, confidence: 0.3, segmentStartTs: 100 },
      { id: 'high', level: 1 as RecommendationLevel, confidence: 0.9, segmentStartTs: 300 },
      { id: 'mid', level: 1 as RecommendationLevel, confidence: 0.6, segmentStartTs: 200 },
      { id: 'late', level: 1 as RecommendationLevel, confidence: 0.6, segmentStartTs: 400 }
    ]
    capL1(entries)
    // 置信度优先（high > mid/late > low）；mid 与 late 并列时更早段胜。
    expect(entries.filter((e) => e.level === 1).map((e) => e.id)).toEqual(['high', 'mid', 'late'])
    expect(entries.find((e) => e.id === 'low')?.level).toBe(2)
  })

  it('不超过上限 → 原样保留', () => {
    const entries = [
      { id: 'a', level: 1 as RecommendationLevel, confidence: 0.5, segmentStartTs: 1 },
      { id: 'b', level: 2 as RecommendationLevel, confidence: 0.9, segmentStartTs: 2 }
    ]
    capL1(entries)
    expect(entries.map((e) => e.level)).toEqual([1, 2])
  })

  it('置信度并列 → 更早段优先', () => {
    const entries = [
      { id: 'early', level: 1 as RecommendationLevel, confidence: 0.5, segmentStartTs: 100 },
      { id: 'late', level: 1 as RecommendationLevel, confidence: 0.5, segmentStartTs: 200 },
      { id: 'a', level: 1 as RecommendationLevel, confidence: 0.5, segmentStartTs: 300 },
      { id: 'b', level: 1 as RecommendationLevel, confidence: 0.5, segmentStartTs: 400 }
    ]
    capL1(entries)
    expect(entries.filter((e) => e.level === 1).map((e) => e.id)).toEqual(['early', 'late', 'a'])
  })
})

describe('appCoverage — 应用集覆盖率', () => {
  it('候选键被任务键覆盖的比例（≥ 0.6 判同工作）', () => {
    const t = task()
    expect(appCoverage([CODE, CHROME], t)).toBe(1)
    expect(appCoverage([CODE, CHROME, EXCEL], t)).toBeCloseTo(2 / 3)
    expect(appCoverage([EXCEL], t)).toBe(0)
  })

  it('大小写/路径分隔符归一化（normalizeAppKey）', () => {
    const t = task()
    expect(appCoverage(['C:\\APPS\\Code.EXE', 'c:/apps/chrome.exe'], t)).toBe(1)
  })

  it('空候选键集 → 0（无从判定）', () => {
    expect(appCoverage([], task())).toBe(0)
  })

  it('任务无应用 → 0', () => {
    expect(appCoverage([CODE], task({ apps: [] }))).toBe(0)
  })

  it('覆盖率阈值常量与时段窗口常量锚定（决策 9/10 语义）', () => {
    expect(TASK_COVERAGE_THRESHOLD).toBe(0.6) // 与 memoryGraph 余弦去重同档
    expect(TIME_OVERLAP_WINDOW_MS).toBe(HOUR) // 指纹小时桶
    expect(RECENT_REJECTION_MS).toBe(7 * DAY) // L3 冷却 7 天
  })
})
