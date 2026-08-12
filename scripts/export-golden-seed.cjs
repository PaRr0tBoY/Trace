#!/usr/bin/env node
/**
 * export-golden-seed.cjs — build golden/dev seed records from ai-log.jsonl
 *
 * Source log: %APPDATA%\Trace\ai-log.jsonl (override with AI_LOG_PATH).
 * Output:     golden/dev/seed-golden.json (matches the seed-*.json convention).
 *
 * What becomes a seed: every suggestion produced by an `analysis` entry. Each
 * seed carries the seven first-level labels from spec §13 plus the raw input
 * (segment + candidates as logged) and raw output (suggestion + outcome).
 *
 * Label derivation (from real decisions in the log — user spot-checks later):
 *   activityBoundary  — segment.zone === 'new' (clusterer cut a fresh segment
 *                       not continuing a known task); false = continues one.
 *   currentTask       — segment.taskId (null when the segment is unattributed).
 *   candidateRanking  — 1-based position of the suggestion in the analysis's
 *                       candidate list (the engine's own ordering).
 *   switch            — accepted only: true when the accepted task differs from
 *                       the task known before this analysis (prevTask tracked in
 *                       ts order across analyses + accepts); null = no decision.
 *   merge             — accepted only: the accept entry's `merged` flag; null
 *                       = no decision.
 *   suggestionLevel   — 'llm' when the candidate was LLM-titled, else 'algorithm'.
 *   reason            — accepted: the suggestion's logged reason; ignored: the
 *                       literal 'ignored'; null = no decision observed.
 *
 * Idempotency: records are keyed by `a<analysisTs>-<suggestionId>`; existing
 * records in the seed file are loaded and merged, so re-running never
 * duplicates. Identical input ⇒ byte-identical output.
 *
 * Pure Node (no ts-node, no electron imports).
 */
'use strict'

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const GOLDEN_DEV = path.join(REPO_ROOT, 'golden', 'dev')
const SEED_FILE = path.join(GOLDEN_DEV, 'seed-golden.json')
const DEFAULT_LOG = path.join(process.env.APPDATA || '', 'Trace', 'ai-log.jsonl')
const LOG_PATH = process.env.AI_LOG_PATH || DEFAULT_LOG

/** Parse a JSONL file into entries; malformed lines are counted, not fatal. */
function loadEntries(logPath) {
  if (!fs.existsSync(logPath)) {
    console.error(`[export-golden-seed] ai-log not found: ${logPath}`)
    console.error('[export-golden-seed] set AI_LOG_PATH to point at a jsonl log')
    process.exit(1)
  }
  const entries = []
  let skipped = 0
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      skipped++
    }
  }
  return { entries, skipped }
}

/** Dominant task of an analysis window: taskId of the longest attributed segment. */
function dominantTask(analysis) {
  const segments = Array.isArray(analysis.segments) ? analysis.segments : []
  let best = null
  for (const seg of segments) {
    if (!seg || typeof seg.taskId !== 'string') continue
    const dur = typeof seg.durationMs === 'number' ? seg.durationMs : 0
    if (!best || dur > best.durationMs) best = { taskId: seg.taskId, durationMs: dur }
  }
  return best ? best.taskId : null
}

/** Build one seed record from an analysis entry + one suggestion + its outcome. */
function buildSeed(analysis, suggestion, idx, accept, ignore, prevTask) {
  const segments = Array.isArray(analysis.segments) ? analysis.segments : []
  const segment = segments[idx] ?? null
  const level = suggestion.llmTitle === true || analysis.mode === 'llm' ? 'llm' : 'algorithm'

  const record = {
    id: `a${analysis.ts}-${suggestion.id}`,
    ts: analysis.ts,
    labels: {
      activityBoundary: segment ? segment.zone === 'new' : null,
      currentTask: segment && typeof segment.taskId === 'string' ? segment.taskId : null,
      candidateRanking: idx + 1,
      switch: accept ? Boolean(prevTask && prevTask !== accept.taskId) : null,
      merge: accept ? Boolean(accept.merged) : null,
      suggestionLevel: level,
      reason: accept ? (typeof suggestion.reason === 'string' ? suggestion.reason : null)
        : ignore ? 'ignored'
        : null
    },
    outcome: accept ? 'accepted' : ignore ? 'ignored' : 'pending',
    input: {
      ts: analysis.ts,
      mode: analysis.mode ?? null,
      events: analysis.events ?? null,
      ocrChars: analysis.ocrChars ?? null,
      segment,
      candidates: Array.isArray(analysis.suggestions) ? analysis.suggestions : []
    },
    output: { suggestion }
  }
  if (accept) record.output.accept = accept
  if (ignore) record.output.ignore = ignore
  return record
}

function main() {
  fs.mkdirSync(GOLDEN_DEV, { recursive: true })
  const { entries, skipped } = loadEntries(LOG_PATH)

  const byKind = {}
  const accepts = new Map() // suggestionId -> accept entry
  const ignores = new Map() // suggestionId -> ignore entry
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1
    if (e.kind === 'accept' && typeof e.suggestionId === 'string') accepts.set(e.suggestionId, e)
    if (e.kind === 'ignore' && typeof e.suggestionId === 'string') ignores.set(e.suggestionId, e)
  }

  // Walk entries in ts order so `prevTask` reflects what was known *before* each analysis.
  const records = []
  let prevTask = null
  for (const e of [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    if (e.kind === 'accept' && typeof e.taskId === 'string') prevTask = e.taskId
    if (e.kind !== 'analysis') continue
    const suggestions = Array.isArray(e.suggestions) ? e.suggestions : []
    suggestions.forEach((s, idx) => {
      if (!s || typeof s.id !== 'string') return
      const accept = accepts.get(s.id) ?? null
      const ignore = ignores.get(s.id) ?? null
      records.push(buildSeed(e, s, idx, accept, ignore, prevTask))
    })
    const dom = dominantTask(e)
    if (dom != null) prevTask = dom
  }

  // Idempotent merge with any existing seed file (keyed by record id).
  const existing = new Map()
  if (fs.existsSync(SEED_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
    for (const r of Array.isArray(parsed) ? parsed : []) existing.set(r.id, r)
  }
  let added = 0
  for (const r of records) {
    if (!existing.has(r.id)) {
      existing.set(r.id, r)
      added++
    }
  }
  const merged = [...existing.values()].sort((a, b) =>
    (a.ts ?? 0) - (b.ts ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
  fs.writeFileSync(SEED_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8')

  const byOutcome = {}
  for (const r of merged) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1
  console.log(`[export-golden-seed] source: ${LOG_PATH}`)
  console.log(`[export-golden-seed] entries: ${entries.length} (${skipped} malformed) ${JSON.stringify(byKind)}`)
  console.log(`[export-golden-seed] seeds: ${merged.length} total (${added} new) -> ${path.relative(REPO_ROOT, SEED_FILE)}`)
  console.log(`[export-golden-seed] by outcome: ${JSON.stringify(byOutcome)}`)
  console.log('[export-golden-seed] NEXT STEP: spot-check golden/dev/seed-golden.json and fix labels —' +
    ' corrected records move to golden/eval/ for scoring.')
}

main()
