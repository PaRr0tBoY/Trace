#!/usr/bin/env node
/**
 * golden-runner.cjs — Golden Dataset 首次跑分（票 58 验收项 1）。
 *
 * 用法：
 *   node scripts/golden-runner.cjs [seed.json] [output.json]
 *   缺省：golden/dev/seed-golden.json → golden/eval/baseline-<yyyy-mm-dd>.json
 *
 * 仓库无 tsx；主 seam（CurrentTaskController 链）是纯逻辑 TS。本脚本用 esbuild
 * （vite 传递依赖，node_modules 已装）把 scripts/golden-baseline.ts 打包成临时
 * CJS，require 后逐条回放 seed 记录，把 {id, labels} 预测写到 golden/eval/。
 *
 * 幂等：同一 seed 输入 → 字节一致输出（预测标签不含任何随机量；会话/决策 id 是
 * 随机 createId，但不进标签，trace 也未接线）。
 *
 * seed 完整性：全部 seed id 必须命中且无多余 id，否则退出码 1。
 *
 * Pure Node，零 Electron import。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const esbuild = require('esbuild')

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_SEED = path.join(REPO_ROOT, 'golden', 'dev', 'seed-golden.json')
const ENTRY = path.join(__dirname, 'golden-baseline.ts')

function defaultOutput() {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return path.join(REPO_ROOT, 'golden', 'eval', `baseline-${stamp}.json`)
}

async function main() {
  const seedPath = path.resolve(process.argv[2] ?? DEFAULT_SEED)
  const outPath = path.resolve(process.argv[3] ?? defaultOutput())
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
  if (!Array.isArray(seed) || seed.length === 0) {
    console.error(`[golden-runner] seed must be a non-empty array: ${seedPath}`)
    process.exit(1)
  }

  const bundlePath = path.join(os.tmpdir(), `golden-baseline-${process.pid}-${Date.now()}.cjs`)
  let rows
  try {
    esbuild.buildSync({
      entryPoints: [ENTRY],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile: bundlePath,
      logLevel: 'warning'
    })
    const { runGoldenBaseline } = require(bundlePath)
    rows = await runGoldenBaseline(seed)
  } finally {
    fs.rmSync(bundlePath, { force: true })
  }

  // seed 完整性：181 条全部命中、无多余、无重复。
  const seedIds = new Set(seed.map((r) => r.id))
  const missing = seed.filter((r) => !seedIds.has(r.id) || !rows.some((p) => p.id === r.id)).map((r) => r.id)
  const seen = new Set()
  const duplicated = rows.filter((p) => seen.has(p.id) || !seen.add(p.id)).map((p) => p.id)
  const extra = rows.filter((p) => !seedIds.has(p.id)).map((p) => p.id)
  if (rows.length !== seed.length || missing.length > 0 || extra.length > 0 || duplicated.length > 0) {
    console.error(`[golden-runner] seed integrity FAILED: predicted=${rows.length} seed=${seed.length}`)
    if (missing.length > 0) console.error(`  missing: ${missing.join(', ')}`)
    if (extra.length > 0) console.error(`  extra: ${extra.join(', ')}`)
    if (duplicated.length > 0) console.error(`  duplicated ids: ${duplicated.join(', ')}`)
    process.exit(1)
  }

  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2) + '\n')

  const count = (k, v) => rows.filter((p) => p.labels[k] === v).length
  console.log(`[golden-runner] seed integrity: all ${seedIds.size} ids predicted, no extras, no duplicates`)
  console.log(`[golden-runner] seed:    ${seedPath}`)
  console.log(`[golden-runner] output:  ${rows.length} predictions -> ${outPath}`)
  console.log(`[golden-runner] activityBoundary: true=${count('activityBoundary', true)} false=${count('activityBoundary', false)}`)
  console.log(`[golden-runner] switch:  true=${count('switch', true)} false=${count('switch', false)} null=${count('switch', null)}`)
  console.log(`[golden-runner] merge:   true=${count('merge', true)} false=${count('merge', false)} null=${count('merge', null)}`)
  console.log(`[golden-runner] suggestionLevel: llm=${count('suggestionLevel', 'llm')} algorithm=${count('suggestionLevel', 'algorithm')} null=${count('suggestionLevel', null)}`)
  console.log(`[golden-runner] eval:    node scripts/eval-golden.cjs golden/dev "${path.relative(REPO_ROOT, outPath).replace(/\\/g, '/')}"`)
}

main().catch((err) => {
  console.error('[golden-runner]', err)
  process.exit(1)
})
