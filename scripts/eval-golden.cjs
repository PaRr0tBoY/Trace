#!/usr/bin/env node
/**
 * eval-golden.cjs — score a system output against golden data (spec §13).
 *
 * Usage:
 *   node scripts/eval-golden.cjs <golden> <system-output.json>
 *
 *   <golden>           a golden JSON file, or a directory (every *.json inside
 *                      is loaded; seed files already carry { id, labels }).
 *   <system-output>    JSON file: an array of { id, labels } or a
 *                      { records: [...] } wrapper. `id` references a golden
 *                      record; `labels` holds the predicted seven labels.
 *
 * Prints the five metrics (precision / recall / false positive / duplicate
 * rate / switch accuracy) plus a detail line, and exits 0 on success.
 *
 * Pure Node, no electron imports.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { computeMetrics } = require('./golden-metrics.cjs')

function loadJson(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return Array.isArray(parsed) ? parsed : parsed.records
}

function loadGolden(target) {
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    const files = fs
      .readdirSync(target)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(target, f))
    if (files.length === 0) {
      console.error(`[eval-golden] no *.json files in ${target}`)
      process.exit(1)
    }
    const records = []
    for (const f of files) {
      const loaded = loadJson(f)
      if (Array.isArray(loaded)) records.push(...loaded)
    }
    return records
  }
  return loadJson(target)
}

function main() {
  const [, , goldenArg, outputArg] = process.argv
  if (!goldenArg || !outputArg) {
    console.error('Usage: node scripts/eval-golden.cjs <golden-file-or-dir> <system-output.json>')
    process.exit(1)
  }
  const golden = loadGolden(goldenArg)
  const predictions = loadJson(outputArg)
  if (!Array.isArray(predictions)) {
    console.error(`[eval-golden] system output must be an array or {records:[...]}: ${outputArg}`)
    process.exit(1)
  }

  const m = computeMetrics(golden, predictions)
  const round = (x) => (Math.round(x * 10000) / 10000).toFixed(4)
  console.log(`golden records: ${golden.length}`)
  console.log(`predictions:    ${predictions.length}`)
  console.log('--- metrics ---')
  console.log(`precision        ${round(m.precision)}`)
  console.log(`recall           ${round(m.recall)}`)
  console.log(`false positive   ${m.falsePositive}`)
  console.log(`duplicate rate   ${round(m.duplicateRate)}`)
  console.log(`switch accuracy  ${round(m.switchAccuracy)}`)
  console.log('--- detail ---')
  console.log(JSON.stringify(m.detail))
}

main()
