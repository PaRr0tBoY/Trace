/**
 * IgnoredTable — local signature table for dismissed suggestions (t19).
 *
 * "Ignore" means "don't show me this kind of suggestion again": the engine
 * hashes the suggestion's app combination + time slot, and the table skips
 * any suggestion whose signature is present. The LLM is stateless by design
 * (spec 实现决策 5) — this file IS the memory.
 *
 * Pure module: no Electron imports. Persistence (ignored.json under userData)
 * is injected, so vitest drives it with an in-memory adapter. The table is
 * an LRU capped at 200 signatures: `add` refreshes an existing entry (it is
 * not a pure set — re-ignoring the same kind keeps it young), and the oldest
 * entry is evicted past the cap.
 */
export interface IgnoredTable {
  /** True when the signature is currently suppressed. */
  has(signature: string): boolean
  /** Insert or refresh a signature; evicts the LRU tail past the cap. */
  add(signature: string): void
  /** Current number of stored signatures (tests / status). */
  size(): number
}

export interface IgnoredTableOptions {
  /** Persisted signatures, newest first; null = nothing on disk. */
  load: () => string[] | null
  /** Persist the full ordered list (newest first). Called after every add. */
  save: (signatures: string[]) => void
  /** LRU capacity; defaults to 200 (spec). */
  limit?: number
}

export const DEFAULT_IGNORED_LIMIT = 200

/**
 * FNV-1a over `sorted-app-keys#hour-bucket`, hex-encoded. Deterministic and
 * stable across runs: the key material is the app identity keys (lowercase
 * exePath, fallback appName) sorted ascending plus the hour the segment
 * started in — the same app combination in a later hour is a new session and
 * may be suggested again.
 */
export function suggestionSignature(appKeys: string[], segmentStartTs: number, bucketMs = 3_600_000): string {
  const keys = [...appKeys]
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .sort()
  const bucket = Math.floor(segmentStartTs / bucketMs)
  const material = `${keys.join('|')}#${bucket}`
  let hash = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0 // FNV prime, keep as uint32
  }
  return hash.toString(16)
}

export function createIgnoredTable(options: IgnoredTableOptions): IgnoredTable {
  const limit = options.limit ?? DEFAULT_IGNORED_LIMIT
  let list = sanitize(options.load())
  const persist = (): void => options.save([...list])

  return {
    has(signature: string): boolean {
      return list.includes(signature)
    },
    add(signature: string): void {
      list = [signature, ...list.filter((s) => s !== signature)]
      if (list.length > limit) list = list.slice(0, limit)
      persist()
    },
    size(): number {
      return list.length
    }
  }
}

function sanitize(raw: string[] | null): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of raw) {
    if (typeof s !== 'string' || s.length === 0 || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}
