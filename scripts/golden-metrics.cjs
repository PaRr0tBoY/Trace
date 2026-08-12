/**
 * golden-metrics.cjs — metric computation for the Golden Dataset (spec §13).
 *
 * Pure Node module, no electron imports: usable from the eval CLI
 * (scripts/eval-golden.cjs) and importable from vitest tests.
 *
 * Contracts
 * ---------
 * Golden records:     [{ id, labels: { <seven labels> }, ... }]
 * System output:      [{ id, labels: { <predicted labels> } }, ...]
 *                     (id must reference a golden record id; a bare top-level
 *                     array or { records: [...] } are both accepted by the CLI.)
 *
 * Seven first-level labels (spec §13): activityBoundary / currentTask /
 * candidateRanking / switch / merge / suggestionLevel / reason.
 *
 * Five metrics
 * ------------
 * precision       TP / (TP + FP)  over the binary labels activityBoundary,
 *                                 switch, merge (predictions where both sides
 *                                 carry a boolean value). 0 when no positives.
 * recall          TP / (TP + FN)  over the same binary labels. 0 when no
 *                                 golden positives.
 * falsePositive   FP count — absolute number of binary labels the system
 *                                 asserted while golden says false.
 * duplicateRate   duplicate prediction rows / total prediction rows. A row is
 *                                 a duplicate when an earlier row in the same
 *                                 output has the identical (id, labels) pair.
 * switchAccuracy  correct switch predictions / switch predictions where both
 *                                 sides carry a boolean switch label.
 *
 * Non-boolean labels (currentTask / candidateRanking / suggestionLevel /
 * reason) and null/absent values never count toward precision/recall/FP;
 * unmatched ids are reported in `detail` and skipped.
 */
'use strict'

/** The seven first-level labels, in spec order. */
const SEVEN_LABELS = [
  'activityBoundary',
  'currentTask',
  'candidateRanking',
  'switch',
  'merge',
  'suggestionLevel',
  'reason'
]

/** Binary labels scored for precision / recall / false positive. */
const BINARY_LABELS = ['activityBoundary', 'switch', 'merge']

/** Stable fingerprint of one prediction row (id + labels). */
function fingerprint(row) {
  const labels = row && row.labels ? row.labels : {}
  const ordered = {}
  for (const k of SEVEN_LABELS) {
    if (labels[k] !== undefined) ordered[k] = labels[k]
  }
  return JSON.stringify([row && row.id, ordered])
}

/**
 * Score a system output against golden records.
 * @param {Array<{id: string, labels: object}>} goldenRecords
 * @param {Array<{id: string, labels: object}>} predictions
 * @returns {{precision: number, recall: number, falsePositive: number,
 *            duplicateRate: number, switchAccuracy: number, detail: object}}
 */
function computeMetrics(goldenRecords, predictions) {
  const goldenById = new Map((goldenRecords || []).map((g) => [g && g.id, g]))

  let tp = 0
  let fp = 0
  let fn = 0
  let switchCorrect = 0
  let switchTotal = 0
  let duplicates = 0
  let unmatched = 0
  const seen = new Set()

  for (const row of predictions || []) {
    const f = fingerprint(row)
    if (seen.has(f)) duplicates++
    else seen.add(f)

    const golden = goldenById.get(row && row.id)
    if (!golden || !golden.labels) {
      unmatched++
      continue
    }
    const gl = golden.labels
    const pl = row.labels || {}
    for (const label of BINARY_LABELS) {
      if (typeof pl[label] !== 'boolean' || typeof gl[label] !== 'boolean') continue
      if (pl[label]) {
        if (gl[label]) tp++
        else fp++
      } else if (gl[label]) {
        fn++
      }
    }
    if (typeof pl.switch === 'boolean' && typeof gl.switch === 'boolean') {
      switchTotal++
      if (pl.switch === gl.switch) switchCorrect++
    }
  }

  const total = (predictions || []).length
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0
  const duplicateRate = total > 0 ? duplicates / total : 0
  const switchAccuracy = switchTotal > 0 ? switchCorrect / switchTotal : 0

  return {
    precision,
    recall,
    falsePositive: fp,
    duplicateRate,
    switchAccuracy,
    detail: { tp, fp, fn, duplicates, total, unmatched, switchCorrect, switchTotal }
  }
}

module.exports = { computeMetrics, SEVEN_LABELS, BINARY_LABELS, fingerprint }
