/**
 * aiLog — persistent JSONL observability log for the AI + task pipeline.
 *
 * Answers "what did the AI actually do": the context sent to the provider,
 * the reply, the algorithm outputs (segments/suggestions/titles), and every
 * memory write. One JSON object per line, appended synchronously (the main
 * process never awaits it). Rotated once at startup when the file exceeds
 * 1 MB (newest 1000 lines kept). Any failure is swallowed — logging must
 * never break the pipeline it observes.
 *
 * File: <userData>/ai-log.jsonl (configured in index.ts via paths.ts).
 * Contents are the user's own task/clipboard material — same trust domain
 * as tasks.json, kept on the local disk only.
 *
 * Positioning (spec 决策 8 / t41): NOT a query source of truth anymore —
 * the trace table (electron/store/traceStore.ts) is canonical for AI
 * rationale. This file is demoted to crash-safe append / diagnostics /
 * export input (scripts/export-golden-seed.cjs still consumes it).
 * Do not add read/query APIs here; new AI-rationale reads go to traceStore.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_KEEP_LINES = 1000
const MAX_FIELD_CHARS = 2000

let filePath: string | null = null

/** Point the logger at its file (index.ts startup); null disables it. */
export function configureAiLog(path: string | null): void {
  filePath = path
  if (!path || !existsSync(path)) return
  try {
    if (statSync(path).size > MAX_FILE_BYTES) {
      const lines = readFileSync(path, 'utf8').split('\n')
      writeFileSync(path, lines.slice(-MAX_KEEP_LINES).join('\n'))
    }
  } catch {
    // log never blocks the app
  }
}

/** Clip long strings so a runaway payload can't balloon the file. */
function clipStrings(_key: string, value: unknown): unknown {
  return typeof value === 'string' && value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value
}

/** Append one entry. Never throws. */
export function logAi(entry: Record<string, unknown>): void {
  if (!filePath) return
  try {
    appendFileSync(filePath, JSON.stringify({ ts: Date.now(), ...entry }, clipStrings) + '\n', 'utf8')
  } catch {
    // never throws
  }
}
