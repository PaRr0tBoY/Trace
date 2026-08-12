/**
 * Local model candidate optimizer (t54, spec 实现决策 6/11) — the CandidateActivity
 * enhancement seam.
 *
 * Pipeline position (接入点): 聚类产出候选后、决策前 — the suggestion engine
 * builds CandidateActivity[] from the algorithm candidates and hands them to
 * this optimizer, which filters to ≤3, drafts titles (semanticLabel) and
 * reranks (reply order = the model's preference). 关闭或失败 → the caller
 * passes the algorithm candidates through unchanged (不变量 H: 功能等价,
 * 绝不污染决策数据) — every failure path in here returns `null`, never a
 * partial or fabricated list.
 *
 * Pure logic: no Electron imports. The model call is the injected
 * `inferJson` (LocalModelRuntime.inferJson in prod; a fake in vitest, per
 * the t53 fake-engine precedent). Attribution stays algorithmic: the reply
 * only carries an order + optional title drafts; scores/confidence on the
 * output CandidateActivity are the algorithm's own (归因全由算法).
 *
 * Contract notes:
 * - The reply's `index` refers to the input candidate position; deduplicated,
 *   out-of-range indexes are dropped.
 * - The optimized list is capped at `maxCandidates` (spec-confirmed 过滤 ≤3).
 * - An empty or invalid reply degrades to `null` (algorithm pass-through);
 *   an empty optimized list is treated the same — the local model can limit
 *   or reorder, never silence the pipeline.
 */
import type { ChatMessage, JsonSchemaObject } from '../main/provider'
import type { LocalModelInferRequest } from './localModelRuntime'
import type { CandidateActivity } from '../../shared/types'

/** Spec-confirmed cap: 过滤 ≤3 (spec 决策 6/11). */
export const MAX_LOCAL_CANDIDATES = 3

/** Context budget: the optimizer sees the same bounded set as the LLM annotation. */
export const MAX_OPTIMIZER_INPUT = 8

/** Title drafts are display-bound by the engine (MAX_TITLE_CHARS); keep them bounded here too. */
const MAX_DRAFT_CHARS = 60

export interface CandidateOptimizer {
  /**
   * Refine the candidate list (filter ≤3 / title drafts / rerank). Resolves
   * with the refined candidates, or `null` when the local model is
   * unavailable or the call failed — the caller must then pass the
   * algorithm candidates through unchanged (不变量 H).
   */
  optimize(candidates: CandidateActivity[]): Promise<CandidateActivity[] | null>
}

export interface CandidateOptimizerDeps {
  /**
   * Strict-JSON inference (LocalModelRuntime.inferJson bound in prod). Any
   * rejection is caught and reported as `null` — the pipeline never sees
   * model failures as data.
   */
  inferJson: (req: LocalModelInferRequest) => Promise<unknown>
  /** Hard cap on the optimized list (default MAX_LOCAL_CANDIDATES = 3). */
  maxCandidates?: number
}

/** Reply schema: an ordered list of { index, optional title draft }. */
const REPLY_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          title: { type: 'string' }
        },
        required: ['index']
      }
    }
  },
  required: ['items']
}

function buildMessages(candidates: CandidateActivity[]): ChatMessage[] {
  const payload = {
    candidates: candidates.map((c, i) => ({
      index: i,
      title: c.semanticLabel ?? '',
      score: c.score,
      evidence: c.evidenceRefs.slice(0, 6)
    }))
  }
  return [
    {
      role: 'system',
      content:
        'You rank short work-session candidates for a task tracker. Given a JSON list of activity candidates, reply with JSON only: ' +
        '{"items": [{"index": 0, "title": "..."}]}. Keep at most 3 items, best first. ' +
        'index refers to the input candidate position and is required. ' +
        'title: an optional concise task title, at most 8 words, no quotes, ' +
        'written in the same language as the window titles in "evidence".'
    },
    { role: 'user', content: `Candidates: ${JSON.stringify(payload)}` }
  ]
}

/**
 * Pure mapping from the model reply to the refined candidate list.
 * Malformed entries (missing/wrong `index`, out of range, duplicates) are
 * skipped; the valid ones are kept in reply order. Returns `null` only when
 * the reply itself is structurally broken or no valid entry remains — the
 * caller then falls back to the algorithm path, so the model can never
 * silence the pipeline. The order of the reply is the rerank; input scores
 * and evidence travel unchanged (归因全由算法).
 */
export function applyOptimizerReply(
  candidates: readonly CandidateActivity[],
  parsed: unknown,
  maxCandidates: number
): CandidateActivity[] | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (!('items' in parsed) || !Array.isArray(parsed.items)) return null

  const seen = new Set<number>()
  const out: CandidateActivity[] = []
  for (const raw of parsed.items) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    if (!('index' in raw) || !Number.isInteger(raw.index)) continue
    const idx = raw.index
    if (idx < 0 || idx >= candidates.length || seen.has(idx)) continue
    seen.add(idx)
    const src = candidates[idx]
    // Title draft is optional; a blank draft keeps the algorithm/LLM title.
    const draft = 'title' in raw && typeof raw.title === 'string'
      ? raw.title.trim().replace(/\s+/g, ' ').slice(0, MAX_DRAFT_CHARS)
      : ''
    out.push(draft.length > 0 ? { ...src, semanticLabel: draft } : src)
    if (out.length >= maxCandidates) break
  }
  return out.length > 0 ? out : null
}

/**
 * Production seam: build the optimizer over an injected strict-JSON
 * inference call. All model failures (throw, timeout, malformed reply) are
 * caught here and reported as `null` — 不变量 H: the caller's algorithm
 * candidates pass through untouched.
 */
export function createCandidateOptimizer(deps: CandidateOptimizerDeps): CandidateOptimizer {
  const maxCandidates = deps.maxCandidates ?? MAX_LOCAL_CANDIDATES
  return {
    async optimize(candidates: CandidateActivity[]): Promise<CandidateActivity[] | null> {
      if (candidates.length === 0) return []
      const input = candidates.slice(0, MAX_OPTIMIZER_INPUT)
      try {
        const parsed = await deps.inferJson({
          messages: buildMessages(input),
          schema: REPLY_SCHEMA
        })
        return applyOptimizerReply(input, parsed, maxCandidates)
      } catch {
        return null
      }
    }
  }
}
