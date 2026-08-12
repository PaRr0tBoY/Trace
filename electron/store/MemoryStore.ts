/**
 * MemoryStore — long-term memory (identity/tool/project/workflow) with
 * reinforcement, time decay and the user-state machine.
 *
 * Pure module: no Electron imports. Persistence, the clock and the decay
 * parameters are injected, so vitest drives it with fake storage and a fake
 * clock; the main process assembles the real file adapter (PATHS +
 * memories.json) around this class.
 *
 * Rules only — no AI anywhere in this module. Nothing enters 'confirmed'
 * without the user: suggestMemory() only creates 'suggested' candidates,
 * confirm()/ignore()/ban() are the user's decisions. The decay formula:
 *
 *   confidence = sat(hitCount) × exp(-λ·Δt)
 *
 *   sat(x) = x/(x+1) — bounded reinforcement, repeated hits asymptote to 1.
 *   Δt = weeks since lastSeenAt; λ is per-week (default 0.25).
 *
 * λ being weekly (not daily) matches the clustering time-decay precedent
 * (research/10, spec decision 08) so memory decay and cluster freshness move
 * on the same timescale. Defaults mirror DEFAULT_SETTINGS (memoryLambda /
 * memoryStaleDays / memoryCleanupScore); Settings wins at runtime via
 * setDecay().
 */
import { createId } from './ids'
import type { Memory, MemoryType, MemoryUserState } from '../../shared/types'

/** Sources a memory can come from (mirrors the inline union in shared/types). */
export type MemorySource = 'ai-suggest' | 'task-feedback' | 'user'

export interface MemoryIndex {
  version: number
  memories: Memory[]
}

export interface MemoryDecayParams {
  /** Decay λ per week (0.01-1, default 0.25). */
  lambda: number
  /** Days without a hit before a memory is stale (7-365, default 60). */
  staleDays: number
  /** Confidence floor below which a stale memory is a cleanup candidate (0-1, default 0.1). */
  cleanupScore: number
}

export interface MemoryStoreDeps {
  load: () => MemoryIndex | null
  save: (index: MemoryIndex) => void
  now?: () => number
  /** Decay parameters; defaults mirror DEFAULT_SETTINGS, Settings overrides at runtime. */
  decay?: Partial<MemoryDecayParams>
  /** Observability sink (ai-log.jsonl): every memory write, with content. */
  log?: (entry: Record<string, unknown>) => void
}

export const STORAGE_VERSION = 1
const MEMORY_ID_PREFIX = 'm_'
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
export const DEFAULT_LAMBDA = 0.25
const DEFAULT_STALE_DAYS = 60
const DEFAULT_CLEANUP_SCORE = 0.1
export const MIN_LAMBDA = 0.01
export const MAX_LAMBDA = 1
const MIN_STALE_DAYS = 7
const MAX_STALE_DAYS = 365
const VALID_TYPES: readonly MemoryType[] = ['identity', 'tool', 'project', 'workflow']
const VALID_USER_STATES: readonly MemoryUserState[] = ['confirmed', 'suggested', 'ignored', 'banned']
const VALID_SOURCES: readonly MemorySource[] = ['ai-suggest', 'task-feedback', 'user']

function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (VALID_TYPES as readonly string[]).includes(v)
}

function isUserState(v: unknown): v is MemoryUserState {
  return typeof v === 'string' && (VALID_USER_STATES as readonly string[]).includes(v)
}

function isSource(v: unknown): v is MemorySource {
  return typeof v === 'string' && (VALID_SOURCES as readonly string[]).includes(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** Bounded reinforcement: sat(hitCount) = hitCount/(hitCount+1), asymptotes to 1. */
export function saturation(hitCount: number): number {
  return hitCount / (hitCount + 1)
}

/**
 * 指数时间衰减项（从 effectiveConfidence 抽出共享，t48 记忆图复用）：
 * exp(-λ·周数)，λ 为每周衰减率。返回 [0, 1]。
 */
export function expDecay(lastSeenAt: number, now: number, lambda: number): number {
  const weeks = Math.max(0, (now - lastSeenAt) / WEEK_MS)
  return Math.exp(-lambda * weeks)
}

/** 现有衰减全式（本类置信度）：sat(hitCount) × exp(-λ·周数)。 */
export function memoryDecay(hitCount: number, lastSeenAt: number, now: number, lambda: number): number {
  return saturation(hitCount) * expDecay(lastSeenAt, now, lambda)
}

/** Salvage a persisted record: drop structurally broken ones, repair weak fields. */
function sanitizeMemory(raw: unknown): Memory | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (!nonEmptyString(m.id) || !nonEmptyString(m.content) || !isMemoryType(m.type)) return null
  return {
    id: m.id,
    type: m.type,
    content: m.content.trim(),
    confidence: isFiniteNumber(m.confidence) ? Math.min(1, Math.max(0, m.confidence)) : 0,
    hitCount: isFiniteNumber(m.hitCount) ? Math.max(0, Math.floor(m.hitCount)) : 0,
    lastSeenAt: isFiniteNumber(m.lastSeenAt) ? m.lastSeenAt : 0,
    createdAt: isFiniteNumber(m.createdAt) ? m.createdAt : 0,
    // Unknown source/state coerce to the non-live defaults: a memory whose
    // state is unreadable must never resurrect as live without confirmation.
    source: isSource(m.source) ? m.source : 'ai-suggest',
    userState: isUserState(m.userState) ? m.userState : 'suggested'
  }
}

function sanitizeIndex(index: MemoryIndex | null): Memory[] {
  if (!index || !Array.isArray(index.memories)) return []
  const memories: Memory[] = []
  const seenIds = new Set<string>()
  for (const raw of index.memories) {
    const memory = sanitizeMemory(raw)
    if (!memory || seenIds.has(memory.id)) continue
    seenIds.add(memory.id)
    memories.push(memory)
  }
  return memories
}

export class MemoryStore {
  private memories: Memory[] = []
  private lambda = DEFAULT_LAMBDA
  private staleDays = DEFAULT_STALE_DAYS
  private cleanupScore = DEFAULT_CLEANUP_SCORE
  private readonly deps: MemoryStoreDeps
  private readonly log: (entry: Record<string, unknown>) => void

  constructor(deps: MemoryStoreDeps) {
    this.deps = deps
    this.log = deps.log ?? (() => {})
    if (deps.decay) this.setDecay(deps.decay)
  }

  /** Load persisted state from disk. Called once at startup. */
  load(): void {
    const index = this.deps.load()
    const raw = index && Array.isArray(index.memories) ? index.memories : null
    this.memories = sanitizeIndex(index)
    if (raw && raw.length !== this.memories.length) {
      console.error(`[Memory] discarded ${raw.length - this.memories.length} malformed record(s)`)
    }
    console.info(`[Memory] init complete (${this.memories.length} memories)`)
  }

  /** Update decay parameters (clamped like Settings; Settings changes at runtime). */
  setDecay(params: Partial<MemoryDecayParams>): void {
    if (params.lambda !== undefined) {
      const n = Number(params.lambda)
      this.lambda = Math.min(MAX_LAMBDA, Math.max(MIN_LAMBDA, Number.isFinite(n) ? n : DEFAULT_LAMBDA))
    }
    if (params.staleDays !== undefined) {
      const n = Number(params.staleDays)
      this.staleDays = Math.min(
        MAX_STALE_DAYS,
        Math.max(MIN_STALE_DAYS, Number.isFinite(n) ? Math.round(n) : DEFAULT_STALE_DAYS)
      )
    }
    if (params.cleanupScore !== undefined) {
      const n = Number(params.cleanupScore)
      this.cleanupScore = Math.min(1, Math.max(0, Number.isFinite(n) ? n : DEFAULT_CLEANUP_SCORE))
    }
  }

  /**
   * Create a 'suggested' candidate from any source. Never live: enters at zero
   * confidence, becomes confirmed only via confirm(). Returns null when the
   * content/type hits a banned pattern or an identical memory already exists
   * in any state (a re-suggestion would just re-ask the user).
   */
  suggestMemory(input: { type: MemoryType; content: string; source: MemorySource }): Memory | null {
    const content = input.content.trim()
    if (!content || !isMemoryType(input.type)) return null
    if (this.isBanned(content, input.type)) return null
    const lower = content.toLowerCase()
    if (this.memories.some((m) => m.type === input.type && m.content.toLowerCase() === lower)) return null

    const now = this.now()
    const memory: Memory = {
      id: `${MEMORY_ID_PREFIX}${createId()}`,
      type: input.type,
      content,
      confidence: 0,
      hitCount: 0,
      lastSeenAt: now,
      createdAt: now,
      source: input.source,
      userState: 'suggested'
    }
    this.memories.push(memory)
    this.persist()
    this.log({ kind: 'memory', action: 'suggest', memoryId: memory.id, type: memory.type, content: memory.content, source: memory.source })
    return memory
  }

  /** Accept a suggested candidate: becomes live and counts as a hit. */
  confirm(id: string): boolean {
    const memory = this.memories.find((m) => m.id === id)
    if (!memory || memory.userState !== 'suggested') return false
    memory.userState = 'confirmed'
    this.strengthen(memory)
    this.log({ kind: 'memory', action: 'confirm', memoryId: memory.id, type: memory.type, content: memory.content })
    return true
  }

  /** Dismiss a suggested candidate (no pattern registered, unlike ban). */
  ignore(id: string): boolean {
    const memory = this.memories.find((m) => m.id === id)
    if (!memory || memory.userState !== 'suggested') return false
    memory.userState = 'ignored'
    this.persist()
    this.log({ kind: 'memory', action: 'ignore', memoryId: memory.id, type: memory.type, content: memory.content })
    return true
  }

  /**
   * Permanently block: content becomes a keyword pattern and the type a
   * category pattern (see isBanned). Applies from any state; only unban()
   * lifts it.
   */
  ban(id: string): boolean {
    const memory = this.memories.find((m) => m.id === id)
    if (!memory || memory.userState === 'banned') return false
    memory.userState = 'banned'
    this.persist()
    this.log({ kind: 'memory', action: 'ban', memoryId: memory.id, type: memory.type, content: memory.content })
    return true
  }

  /**
   * Lift a ban: the entry returns to 'ignored' (dead, never live without
   * confirmation) and its keyword/type patterns stop suppressing new
   * suggestions. The same content+type stays deduped, so only the veto is
   * lifted — a re-suggestion of the identical text still won't re-ask.
   */
  unban(id: string): boolean {
    const memory = this.memories.find((m) => m.id === id)
    if (!memory || memory.userState !== 'banned') return false
    memory.userState = 'ignored'
    this.persist()
    this.log({ kind: 'memory', action: 'unban', memoryId: memory.id, type: memory.type, content: memory.content })
    return true
  }

  /** A live (confirmed) memory matched in context: reinforce it. */
  hit(id: string): boolean {
    const memory = this.memories.find((m) => m.id === id)
    if (!memory || memory.userState !== 'confirmed') return false
    this.strengthen(memory)
    this.log({ kind: 'memory', action: 'hit', memoryId: memory.id, type: memory.type, content: memory.content })
    return true
  }

  /**
   * Banned patterns match two ways (decision 08: keyword/type matching, so
   * the same kind is never proposed again):
   *   - keyword: the candidate text contains a banned content string
   *     (case-insensitive substring);
   *   - type: the candidate type equals a banned memory's type — one ban
   *     retires the whole category ("某个领域永不进记忆").
   */
  isBanned(text: string, type: MemoryType): boolean {
    const needle = text.trim().toLowerCase()
    for (const m of this.memories) {
      if (m.userState !== 'banned') continue
      const pattern = m.content.trim().toLowerCase()
      if (pattern && needle.includes(pattern)) return true
      if (m.type === type) return true
    }
    return false
  }

  /**
   * Rotted memories: stale (no hit for >= staleDays) AND low-scoring
   * (effective confidence below cleanupScore). Only live (confirmed) and dead
   * (ignored) memories qualify — suggested ones are still awaiting the user's
   * decision, banned ones are deliberate patterns and never auto-removed.
   * Removal itself still waits for the user (delete()).
   */
  cleanupCandidates(): Memory[] {
    const now = this.now()
    const cutoff = now - this.staleDays * DAY_MS
    return this.memories
      .filter((m) => {
        if (m.userState !== 'confirmed' && m.userState !== 'ignored') return false
        if (m.lastSeenAt > cutoff) return false
        return this.effectiveConfidence(m, now) < this.cleanupScore
      })
      .map((m) => this.withEffectiveConfidence(m, now))
      .sort((a, b) => a.confidence - b.confidence)
  }

  /** Hard delete (user-confirmed cleanup). Returns whether a memory was removed. */
  delete(id: string): boolean {
    const memory = this.memories.find((m) => m.id === id)
    const before = this.memories.length
    this.memories = this.memories.filter((m) => m.id !== id)
    if (this.memories.length === before) return false
    this.persist()
    if (memory) {
      this.log({ kind: 'memory', action: 'delete', memoryId: memory.id, type: memory.type, content: memory.content })
    }
    return true
  }

  /** One memory with time-aware confidence. */
  get(id: string): Memory | undefined {
    const memory = this.memories.find((m) => m.id === id)
    return memory ? this.withEffectiveConfidence(memory, this.now()) : undefined
  }

  /** All memories with time-aware confidence, newest first. */
  list(): readonly Memory[] {
    const now = this.now()
    return [...this.memories]
      .map((m) => this.withEffectiveConfidence(m, now))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Pending user decisions — the memory panel's candidate list. */
  candidates(): Memory[] {
    return this.list().filter((m) => m.userState === 'suggested')
  }

  /* ------------------------------ internals ------------------------------ */

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** hitCount+1, lastSeenAt bumped, confidence = sat(hitCount) at Δt = 0. */
  private strengthen(memory: Memory): void {
    memory.hitCount += 1
    memory.lastSeenAt = this.now()
    memory.confidence = saturation(memory.hitCount)
    this.persist()
  }

  /** Time-aware confidence: sat(hitCount) × exp(-λ·weeksSinceLastSeen). */
  private effectiveConfidence(memory: Memory, now: number): number {
    return memoryDecay(memory.hitCount, memory.lastSeenAt, now, this.lambda)
  }

  private withEffectiveConfidence(memory: Memory, now: number): Memory {
    return { ...memory, confidence: this.effectiveConfidence(memory, now) }
  }

  private persist(): void {
    this.deps.save({ version: STORAGE_VERSION, memories: this.memories })
  }
}
