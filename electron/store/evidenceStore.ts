/**
 * Evidence timeline store (t39, spec 实现决策 2).
 *
 * Pure logic: no Electron imports (hard constraint). Persists captured usage
 * events — app switches and clipboard copies — into db.ts's `events` table as
 * the canonical evidence timeline, and serves the two `search_activities`
 * modes from spec decision 2:
 *   1. time window + FTS5 keyword query (newest first),
 *   2. by-id detail, including the clipboard material preview (text ≤200
 *      chars / image dims+bytes / file paths, spec story 35).
 *
 * Retention (default 30 days, setting-adjustable) is a single indexed range
 * DELETE over `capturedAt` — the caller schedules it on a background timer so
 * it never blocks capture. The clock is injected by the caller passing the
 * cutoff timestamp to `purgeBefore`.
 *
 * Same DI shape as sessionStore.ts: consumers depend on the `EvidenceStore`
 * interface; this module provides the better-sqlite3 implementation over
 * db.ts's `events` table and an in-memory implementation for tests and
 * non-persistent harnesses. The event-bus subscription lives in the main
 * glue layer (state.ts); the store only exposes the API.
 */
import { createId } from './ids'
import { appKeyFromIdentity } from '../../shared/appKey'
import type { ClipboardItem, UsageEvent } from '../../shared/types'
import type { TraceDatabase } from './db'

/** Default page size for timeline queries. */
export const DEFAULT_EVIDENCE_QUERY_LIMIT = 50
/** Hard cap so one Agent tool call can never slurp the whole timeline. */
export const MAX_EVIDENCE_QUERY_LIMIT = 200
/** Text material preview bound (spec story 35: 文本 ≤200 字符). */
export const EVIDENCE_TEXT_PREVIEW_LENGTH = 200

export type EvidenceEventKind = 'app-switch' | 'clipboard'

/** One row of the evidence timeline (db.ts `events` table shape). */
export interface EvidenceEvent {
  id: string
  kind: EvidenceEventKind
  /** Unix epoch ms of capture (the bus event's `ts`). */
  capturedAt: number
  /** Normalized app key (appKey semantics: lowercase exePath, else process name). */
  source: string
  /** Foreground window title (app-switch only). */
  windowTitle?: string
  /** Kind-specific JSON body: pid always; clipboard adds itemId + material preview. */
  payload?: Record<string, unknown>
}

/** One `search_activities` mode: time window + optional FTS5 keyword. */
export interface EvidenceQuery {
  /** Inclusive lower bound (epoch ms). */
  from?: number
  /** Exclusive upper bound (epoch ms). */
  to?: number
  /** Full-text keyword; terms are AND-combined and injected safely. Omit for a time-window-only scan. */
  keyword?: string
  /** Restrict to these kinds; empty/omitted = both. Unknown kinds are ignored. */
  kinds?: EvidenceEventKind[]
  /** Max rows (default 50, capped at 200). */
  limit?: number
  /** Pagination offset (default 0). */
  offset?: number
}

/** Durable evidence timeline sink. Injected into consumers (tests use the memory impl). */
export interface EvidenceStore {
  /** Append one captured event. Caller owns the id (glue generates it via the bus mapper). */
  record(event: EvidenceEvent): void
  /** Newest-first scan: time window + optional FTS5 keyword + kind filter + pagination. */
  query(options?: EvidenceQuery): EvidenceEvent[]
  /** Full detail of one event (incl. clipboard material preview in `payload`). */
  getById(id: string): EvidenceEvent | undefined
  /** Delete every event captured strictly before `cutoffMs`; returns rows removed. */
  purgeBefore(cutoffMs: number): number
  /** Total rows (tests + diagnostics). */
  count(): number
}

/* ------------------------- clipboard material preview ------------------------- */

/**
 * Bounded preview of a captured clipboard item (spec story 35): text is
 * clipped to 200 chars, images keep dimensions + byte count (no pixels),
 * files keep their path list. Stored in the clipboard event's payload so the
 * by-id detail answers "what was copied" without touching ItemStore.
 */
export interface ClipboardEvidencePreview {
  /** Text material: first ≤200 chars. */
  text?: string
  /** Image material: dimensions + total byte count. */
  image?: { width: number; height: number; bytes: number }
  /** File material: path list. */
  files?: string[]
}

export function buildClipboardPreview(item: Pick<ClipboardItem, 'data'>): ClipboardEvidencePreview | undefined {
  switch (item.data.kind) {
    case 'text': {
      const text = item.data.text.slice(0, EVIDENCE_TEXT_PREVIEW_LENGTH)
      return text.length > 0 ? { text } : undefined
    }
    case 'image':
      return { image: { width: item.data.width, height: item.data.height, bytes: item.data.bytes } }
    case 'image-collection': {
      const first = item.data.images[0]
      const bytes = item.data.images.reduce((sum, img) => sum + img.bytes, 0)
      return { image: { width: first?.width ?? 0, height: first?.height ?? 0, bytes } }
    }
    case 'files':
      return item.data.paths.length > 0 ? { files: [...item.data.paths] } : undefined
  }
}

/* ------------------------- bus event → store row mapper ------------------------- */

/**
 * Map a gated bus event (app-switch / clipboard) to a store row. `source` is
 * the shared appKey rule (attributor uses the same identity); clipboard rows
 * carry `itemId` plus the caller-supplied material preview.
 */
export function evidenceFromUsageEvent(
  event: UsageEvent,
  enrich: { preview?: ClipboardEvidencePreview } = {}
): EvidenceEvent {
  const common = {
    id: createId(),
    kind: event.type,
    capturedAt: event.ts,
    source: appKeyFromIdentity({ name: event.appName, exePath: event.exePath }),
    payload: { pid: event.pid }
  }
  if (event.type === 'app-switch') {
    return { ...common, windowTitle: event.windowTitle }
  }
  return { ...common, payload: { pid: event.pid, itemId: event.itemId, preview: enrich.preview } }
}

/* ------------------------- in-memory implementation ------------------------- */

function matchesKeyword(event: EvidenceEvent, keyword: string): boolean {
  const haystack = [event.source, event.windowTitle ?? '', JSON.stringify(event.payload ?? {})]
    .join(' ')
    .toLowerCase()
  return keyword.split(/\s+/).every((token) => haystack.includes(token.toLowerCase()))
}

function matchesQuery(event: EvidenceEvent, options: EvidenceQuery): boolean {
  if (options.from !== undefined && event.capturedAt < options.from) return false
  if (options.to !== undefined && event.capturedAt >= options.to) return false
  const kinds = (options.kinds ?? []).filter(isEventKind)
  if (kinds.length > 0 && !kinds.includes(event.kind)) return false
  const keyword = options.keyword?.trim() ?? ''
  if (keyword.length > 0 && !matchesKeyword(event, keyword)) return false
  return true
}

function isEventKind(v: unknown): v is EvidenceEventKind {
  return v === 'app-switch' || v === 'clipboard'
}

/** Query limits/offsets: shared by both implementations so harness results match production. */
function clampLimit(value: unknown): number {
  const n = Number(value)
  const rounded = Math.round(Number.isFinite(n) ? n : DEFAULT_EVIDENCE_QUERY_LIMIT)
  return Math.min(MAX_EVIDENCE_QUERY_LIMIT, Math.max(1, rounded))
}

function clampOffset(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

/**
 * In-memory implementation — the test fake and the no-persistence default.
 * Keyword matching approximates the SQLite FTS5 semantics for harness use
 * (case-insensitive, AND across whitespace-separated terms).
 */
export function createMemoryEvidenceStore(): EvidenceStore {
  const events: EvidenceEvent[] = []
  return {
    record: (event) => {
      events.push({ ...event, payload: event.payload ? { ...event.payload } : undefined })
    },
    query: (options = {}) =>
      events
        .filter((e) => matchesQuery(e, options))
        .sort((a, b) => b.capturedAt - a.capturedAt)
        .slice(clampOffset(options.offset), clampOffset(options.offset) + clampLimit(options.limit))
        .map((e) => ({ ...e, payload: e.payload ? { ...e.payload } : undefined })),
    getById: (id) => {
      const found = events.find((e) => e.id === id)
      return found ? { ...found, payload: found.payload ? { ...found.payload } : undefined } : undefined
    },
    purgeBefore: (cutoffMs) => {
      const before = events.length
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.capturedAt < cutoffMs) events.splice(i, 1)
      }
      return before - events.length
    },
    count: () => events.length
  }
}

/* ------------------------- SQLite implementation ------------------------- */

interface EventRow {
  id: string
  kind: EvidenceEventKind
  capturedAt: number
  source: string
  windowTitle: string | null
  payload: string | null
}

const EVENT_COLUMNS = 'id, kind, capturedAt, source, windowTitle, payload'
/** Same columns, qualified for the events_fts × events join. */
const EVENT_COLUMNS_QUALIFIED = EVENT_COLUMNS.split(', ').map((c) => `e.${c}`).join(', ')

/** Payload is always JSON we wrote; a corrupt row must never crash a query. */
function parsePayload(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function toEvent(row: EventRow): EvidenceEvent {
  return {
    id: row.id,
    kind: row.kind,
    capturedAt: row.capturedAt,
    source: row.source,
    windowTitle: row.windowTitle ?? undefined,
    payload: parsePayload(row.payload)
  }
}

/**
 * Escape a user keyword into an FTS5 MATCH expression: each whitespace term
 * becomes a double-quoted phrase (embedded quotes doubled), terms AND-ed. A
 * quoted term is literal — `-`, `*`, `OR` etc. can never inject syntax.
 */
function toFtsMatch(keyword: string): string {
  return keyword
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' AND ')
}

/** Build the query SQL + named params; FTS5 joins `events_fts` only when a keyword is present. */
function buildQuerySql(options: EvidenceQuery): { sql: string; params: Record<string, string | number> } {
  const where: string[] = []
  const params: Record<string, string | number> = {}
  if (options.from !== undefined) {
    where.push('e.capturedAt >= @from')
    params.from = options.from
  }
  if (options.to !== undefined) {
    where.push('e.capturedAt < @to')
    params.to = options.to
  }
  const kinds = (options.kinds ?? []).filter(isEventKind)
  if (kinds.length > 0) {
    where.push(`e.kind IN (${kinds.map((_, i) => `@kind${i}`).join(', ')})`)
    kinds.forEach((kind, i) => {
      params[`kind${i}`] = kind
    })
  }
  const keyword = options.keyword?.trim() ?? ''
  const ftsMatch = keyword.length > 0 ? toFtsMatch(keyword) : ''
  if (ftsMatch.length > 0) {
    params.keyword = ftsMatch
    where.push('events_fts MATCH @keyword AND events_fts.id = e.id')
  }
  const fromClause = ftsMatch.length > 0 ? 'FROM events_fts, events e' : 'FROM events e'
  const whereClause = where.length > 0 ? where.join(' AND ') : '1=1'
  const sql =
    `SELECT ${EVENT_COLUMNS_QUALIFIED} ${fromClause} WHERE ${whereClause}` +
    ` ORDER BY e.capturedAt DESC LIMIT @limit OFFSET @offset`
  params.limit = clampLimit(options.limit)
  params.offset = clampOffset(options.offset)
  return { sql, params }
}

/** better-sqlite3 implementation over db.ts's `events` table (+ events_fts triggers). */
export function createSqliteEvidenceStore(db: TraceDatabase): EvidenceStore {
  const insert = db.prepare(
    `INSERT INTO events (id, kind, capturedAt, source, windowTitle, payload)
     VALUES (@id, @kind, @capturedAt, @source, @windowTitle, @payload)`
  )
  const selectById = db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`)
  const selectCount = db.prepare(`SELECT COUNT(*) AS n FROM events`)
  const purge = db.prepare(`DELETE FROM events WHERE capturedAt < ?`)

  return {
    record: (event) => {
      insert.run({
        id: event.id,
        kind: event.kind,
        capturedAt: event.capturedAt,
        source: event.source,
        windowTitle: event.windowTitle ?? null,
        payload: event.payload !== undefined ? JSON.stringify(event.payload) : null
      })
    },
    query: (options = {}) => {
      const { sql, params } = buildQuerySql(options)
      return db.prepare(sql).all(params).map((row) => toEvent(row as EventRow))
    },
    getById: (id) => {
      const row = selectById.get(id) as EventRow | undefined
      return row ? toEvent(row) : undefined
    },
    purgeBefore: (cutoffMs) => purge.run(cutoffMs).changes,
    count: () => (selectCount.get() as { n: number }).n
  }
}
