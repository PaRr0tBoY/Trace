/**
 * AI-rationale HTML report generator (t42, spec 实现决策 8).
 *
 * Developer view of a complete decision chain: every trace row (observed /
 * recall / decision / result / privacy) with its version columns and the
 * retrieval hit paths, in a standalone self-contained HTML file. Pure logic
 * (no Electron imports — hard constraint): the IPC layer owns the save
 * dialog and file write, this module only builds the markup.
 */
import type { TraceRecordDto } from '../../shared/types'

const TRACE_KINDS: Record<string, true> = {
  observed: true,
  recall: true,
  decision: true,
  result: true,
  privacy: true
}

/** Runtime shape guard for IPC payloads (renderer input is untrusted). */
export function isTraceRecordDto(v: unknown): v is TraceRecordDto {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.decisionId === 'string' &&
    typeof r.kind === 'string' &&
    r.kind in TRACE_KINDS &&
    typeof r.payload === 'object' &&
    r.payload !== null &&
    (r.taskId === undefined || typeof r.taskId === 'string') &&
    (r.agentVersion === undefined || typeof r.agentVersion === 'string') &&
    (r.policyVersion === undefined || typeof r.policyVersion === 'string') &&
    (r.classifierVersion === undefined || typeof r.classifierVersion === 'string') &&
    (r.promptVersion === undefined || typeof r.promptVersion === 'string') &&
    typeof r.createdAt === 'number'
  )
}

/** Escape untrusted payload strings (reasons, previews, queries) for HTML. */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Preferred field display order per kind; unknown fields append after. */
const PREFERRED_FIELDS: Record<string, string[]> = {
  observed: ['summary', 'activityId'],
  recall: ['tool', 'query', 'count', 'preview', 'hitPath', 'hops'],
  decision: ['action', 'targetTaskId', 'title', 'reason', 'rating', 'confidence'],
  result: ['outcome', 'proposalId', 'taskId', 'actionReason'],
  privacy: ['reason', 'access', 'appExePath', 'contentType']
}

/** Stable key/field rendering for a kind payload: known fields first, extras after. */
function payloadRows(record: TraceRecordDto): Array<[string, unknown]> {
  const p = record.payload
  const preferred = PREFERRED_FIELDS[record.kind] ?? []
  const byKey = new Map<string, unknown>(Object.entries(p))
  const extras = Object.keys(p).filter((k) => !preferred.includes(k))
  return [...preferred.filter((k) => byKey.has(k)).map((k) => [k, byKey.get(k)] as [string, unknown]), ...extras.map((k) => [k, byKey.get(k)] as [string, unknown])]
}

function valueHtml(v: unknown): string {
  if (v === null || v === undefined) return '<span class="muted">—</span>'
  if (Array.isArray(v)) return `<span class="path">${v.map((x) => esc(x)).join(' → ')}</span>`
  if (typeof v === 'number') return `<span class="num">${esc(v)}</span>`
  return esc(v)
}

/** Kind section label (developer report is English; data-driven content). */
const KIND_LABEL: Record<string, string> = {
  observed: 'Observed',
  recall: 'Recalled',
  decision: 'Decision',
  result: 'Result',
  privacy: 'Privacy filtered'
}

function versionCell(label: string, value: string | undefined): string {
  return `<div class="ver"><span>${label}</span><code>${esc(value ?? '—')}</code></div>`
}

function chainHtml(records: TraceRecordDto[]): string {
  return records
    .map((r) => {
      const privacy = r.kind === 'privacy'
      return `<section class="row ${r.kind}${privacy ? ' blocked' : ''}">
  <div class="row-head">
    <span class="kind">${KIND_LABEL[r.kind] ?? esc(r.kind)}</span>
    <span class="time">${esc(new Date(r.createdAt).toLocaleString())}</span>
    ${privacy ? '<span class="badge">Blocked by privacy policy</span>' : ''}
  </div>
  <table>
${payloadRows(r)
  .map(([k, v]) => `    <tr><th>${esc(k)}</th><td>${valueHtml(v)}</td></tr>`)
  .join('\n')}
  </table>
  <div class="versions">
    ${versionCell('agent', r.agentVersion)}
    ${versionCell('policy', r.policyVersion)}
    ${versionCell('classifier', r.classifierVersion)}
    ${versionCell('prompt', r.promptVersion)}
  </div>
</section>`
    })
    .join('\n')
}

/** Build a standalone HTML document for one decision chain (or task's trace). */
export function renderTraceReportHtml(records: TraceRecordDto[]): string {
  const now = new Date().toLocaleString()
  const kinds = [...new Set(records.map((r) => r.kind))]
  const chain = chainHtml(records)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace — AI Rationale Report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 60px; background: #0b0b0d; color: #e4e4e7;
         font: 13px/1.55 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; }
  header { border-bottom: 1px solid rgba(255,255,255,.12); padding-bottom: 16px; margin-bottom: 20px; }
  h1 { margin: 0 0 6px; font-size: 19px; }
  .meta { color: #a1a1aa; font-size: 12px; }
  .stats { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; color: #a1a1aa; font-size: 12px; }
  .stats b { color: #e4e4e7; font-weight: 600; }
  .row { border: 1px solid rgba(255,255,255,.1); border-radius: 10px; background: rgba(255,255,255,.03);
         padding: 12px 14px; margin-bottom: 12px; }
  .row.privacy { border-color: rgba(251,191,36,.35); background: rgba(251,191,36,.05); }
  .row-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .kind { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #d4d4d8; }
  .row.privacy .kind { color: #fbbf24; }
  .time { margin-left: auto; color: #71717a; font-size: 11px; }
  .badge { border: 1px solid rgba(251,191,36,.4); color: #fbbf24; background: rgba(251,191,36,.12);
           border-radius: 999px; padding: 1px 9px; font-size: 10.5px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #a1a1aa; font-weight: 500; width: 140px; vertical-align: top;
       padding: 2px 8px 2px 0; font-size: 12px; }
  td { padding: 2px 0; word-break: break-word; }
  .num { color: #7dd3fc; font-variant-numeric: tabular-nums; }
  .path { color: #c4b5fd; font-size: 12px; }
  .muted { color: #52525b; }
  .versions { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; padding-top: 8px;
              border-top: 1px solid rgba(255,255,255,.08); }
  .ver { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: #71717a; }
  .ver code { color: #a1a1aa; background: rgba(255,255,255,.06); border-radius: 5px; padding: 0 6px; }
  .empty { color: #71717a; text-align: center; padding: 48px 0; }
  footer { margin-top: 24px; color: #52525b; font-size: 11px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Trace — AI Rationale Report</h1>
    <div class="meta">Generated ${esc(now)} · decision chain: <code>${esc(records[0]?.decisionId ?? '(empty)')}</code></div>
    <div class="stats">
      <span><b>${records.length}</b> trace rows</span>
      <span>kinds: <b>${esc(kinds.join(', ') || '—')}</b></span>
    </div>
  </header>
  ${records.length > 0 ? chain : '<div class="empty">No AI rationale data recorded for this chain.</div>'}
  <footer>Trace AI rationale export — trace table is the canonical source (spec decision 8).</footer>
</div>
</body>
</html>`
}
