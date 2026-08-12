import { describe, expect, it } from 'vitest'

import goldenMetrics from '../scripts/golden-metrics.cjs'

const { computeMetrics, SEVEN_LABELS, BINARY_LABELS } = goldenMetrics

/** Convenience: full seven-label record with sensible defaults. */
const rec = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  labels: {
    activityBoundary: false,
    currentTask: null,
    candidateRanking: 1,
    switch: false,
    merge: false,
    suggestionLevel: 'algorithm',
    reason: null,
    ...overrides
  }
})

describe('golden dataset labels contract', () => {
  it('exports exactly the seven first-level labels from spec §13', () => {
    expect(SEVEN_LABELS).toEqual([
      'activityBoundary',
      'currentTask',
      'candidateRanking',
      'switch',
      'merge',
      'suggestionLevel',
      'reason'
    ])
  })

  it('scores the three binary labels for precision/recall', () => {
    expect(BINARY_LABELS).toEqual(['activityBoundary', 'switch', 'merge'])
  })
})

describe('computeMetrics', () => {
  it('perfect match: precision 1, recall 1, no false positives, no duplicates, switch accuracy 1', () => {
    const golden = [
      rec('a', { activityBoundary: true, switch: true, merge: true }),
      rec('b', { activityBoundary: false, switch: false, merge: false })
    ]
    const predictions = [
      { id: 'a', labels: { activityBoundary: true, switch: true, merge: true } },
      { id: 'b', labels: { activityBoundary: false, switch: false, merge: false } }
    ]
    const m = computeMetrics(golden, predictions)
    expect(m.precision).toBe(1)
    expect(m.recall).toBe(1)
    expect(m.falsePositive).toBe(0)
    expect(m.duplicateRate).toBe(0)
    expect(m.switchAccuracy).toBe(1)
    expect(m.detail).toMatchObject({ tp: 3, fp: 0, fn: 0 }) // only positive cells are counted
  })

  it('mixed fixture: precision 0.5, recall 0.5, one false positive, switch accuracy 0.5', () => {
    const golden = [
      rec('a', { activityBoundary: true, switch: true, merge: false }),
      rec('b', { activityBoundary: false, switch: false, merge: false })
    ]
    const predictions = [
      { id: 'a', labels: { activityBoundary: true, switch: false, merge: false } },
      { id: 'b', labels: { activityBoundary: true, switch: false, merge: false } }
    ]
    const m = computeMetrics(golden, predictions)
    // a.activityBoundary TP; b.activityBoundary FP; a.switch FN; rest TN.
    expect(m.precision).toBeCloseTo(0.5)
    expect(m.recall).toBeCloseTo(0.5)
    expect(m.falsePositive).toBe(1)
    expect(m.switchAccuracy).toBeCloseTo(0.5) // a wrong, b correct
    expect(m.detail).toMatchObject({ tp: 1, fp: 1, fn: 1 })
  })

  it('duplicate rate: repeated identical rows count as duplicates', () => {
    const golden = [rec('a', { activityBoundary: true, switch: true })]
    const predictions = [
      { id: 'a', labels: { activityBoundary: true, switch: true } },
      { id: 'a', labels: { activityBoundary: true, switch: true } }
    ]
    const m = computeMetrics(golden, predictions)
    expect(m.duplicateRate).toBeCloseTo(0.5) // 1 of 2 rows is a duplicate
    expect(m.detail.duplicates).toBe(1)
    expect(m.precision).toBe(1) // duplicates are still scored once each
  })

  it('same id with different labels is NOT a duplicate', () => {
    const golden = [rec('a', { activityBoundary: true })]
    const predictions = [
      { id: 'a', labels: { activityBoundary: true } },
      { id: 'a', labels: { activityBoundary: false } }
    ]
    const m = computeMetrics(golden, predictions)
    expect(m.duplicateRate).toBe(0)
    expect(m.detail.duplicates).toBe(0)
  })

  it('empty predictions: every metric is 0', () => {
    const golden = [rec('a', { activityBoundary: true, switch: true })]
    const m = computeMetrics(golden, [])
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
    expect(m.falsePositive).toBe(0)
    expect(m.duplicateRate).toBe(0)
    expect(m.switchAccuracy).toBe(0)
    expect(m.detail).toMatchObject({ tp: 0, fp: 0, fn: 0, total: 0 })
  })

  it('unmatched ids are skipped and reported in detail', () => {
    const golden = [rec('a', { activityBoundary: true })]
    const predictions = [{ id: 'zzz', labels: { activityBoundary: true, switch: true } }]
    const m = computeMetrics(golden, predictions)
    expect(m.detail.unmatched).toBe(1)
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
    expect(m.falsePositive).toBe(0)
  })

  it('all-wrong switch predictions give switch accuracy 0', () => {
    const golden = [rec('a', { switch: true })]
    const predictions = [{ id: 'a', labels: { switch: false } }]
    const m = computeMetrics(golden, predictions)
    expect(m.switchAccuracy).toBe(0)
    expect(m.detail).toMatchObject({ switchCorrect: 0, switchTotal: 1, fn: 1 })
  })

  it('non-boolean labels (currentTask / candidateRanking / level / reason) never feed precision/recall', () => {
    const golden = [rec('a', { currentTask: 't1', candidateRanking: 2, suggestionLevel: 'llm', reason: 'x' })]
    const predictions = [{ id: 'a', labels: { currentTask: 't2', candidateRanking: 1, suggestionLevel: 'algorithm', reason: 'y' } }]
    const m = computeMetrics(golden, predictions)
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
    expect(m.falsePositive).toBe(0)
    expect(m.detail).toMatchObject({ tp: 0, fp: 0, fn: 0, switchTotal: 0 })
  })

  it('null labels on either side are ignored, not scored', () => {
    const golden = [rec('a', { switch: null, merge: null })]
    const predictions = [{ id: 'a', labels: { switch: true } }]
    const m = computeMetrics(golden, predictions)
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
    expect(m.switchAccuracy).toBe(0) // golden switch is null → unscorable
  })

  it('tolerates missing labels objects', () => {
    const golden = [{ id: 'a', labels: { switch: true } }]
    const m = computeMetrics(golden, [{ id: 'a' }, { id: 'b' }])
    expect(m.precision).toBe(0)
    expect(m.detail.unmatched).toBe(1)
  })
})
