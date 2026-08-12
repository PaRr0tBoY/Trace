/**
 * IgnoredTable — local signature table for dismissed suggestions (t19).
 *
 * "Ignore" means "don't show me this kind of suggestion again": the
 * ActivityLedger (t40) hashes the activity's app combination + time slot
 * (suggestionSignature in store/activityLedger.ts) and skips any activity
 * whose signature the table holds. The LLM is stateless by design
 * (spec 实现决策 5) — this table IS the memory.
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
