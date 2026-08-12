/**
 * Local model chat adapter (t54, spec 实现决策 11) — LocalModelRuntime speaking
 * the provider-chain contract (ChatRequest → ChatResult, the `ChatFn` seam
 * suggestionEngine consumes), so the local model coexists with the cloud
 * chain as an optional provider.
 *
 * FUTURE SEAM — intentionally unreferenced by production code today: t54's
 * boundary is the candidate optimizer (localModelOptimizer.ts), which talks
 * to the runtime directly. This adapter exists (and is tested) so a later
 * ticket can offer the local model as a provider-chain option without
 * redesigning the mapping.
 *
 * Pure logic: no Electron imports — the runtime's engine is injected, so
 * vitest exercises the mapping with a fake engine (t53 precedent).
 *
 * Mapping notes:
 * - Schema requests go through `runtime.inferJson` (grammar + client
 *   validation + bounded repair retry), so `mode: 'json_schema'` is honest:
 *   `parsed` is schema-valid or the request failed.
 * - Plain-text requests use `runtime.infer` (queue + timeout semantics).
 * - `providerIndex: -1` marks the local model as outside the cloud chain's
 *   provider list; failures carry the local provider id so ai-log records
 *   the attempt like any other provider.
 */
import type { ChatRequest, ChatResult } from '../main/provider'
import type { LocalModelInferRequest, LocalModelRuntime } from './localModelRuntime'
import type { ProviderConfig } from '../../shared/types'

export interface LocalModelProviderMeta {
  /** Provider identity shown in ai-log / trace (default 'local-model'). */
  id: string
  /** Model display name (the runtime's spec name). */
  name: string
}

/** Wrap a runtime as a ChatFn (the provider-chain contract). */
export function createLocalModelChatProvider(
  runtime: LocalModelRuntime,
  meta: LocalModelProviderMeta
): (req: ChatRequest) => Promise<ChatResult> {
  const provider: ProviderConfig = { id: meta.id, baseUrl: 'local://model', model: meta.name }
  return async (req: ChatRequest): Promise<ChatResult> => {
    const inferReq: LocalModelInferRequest = {
      messages: req.messages,
      schema: req.schema,
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {})
    }
    try {
      if (req.schema) {
        const parsed = await runtime.inferJson(inferReq)
        return { ok: true, content: JSON.stringify(parsed), parsed, provider, providerIndex: -1, mode: 'json_schema' }
      }
      const content = await runtime.infer(inferReq)
      return { ok: true, content, provider, providerIndex: -1 }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { ok: false, error, attempts: [{ providerId: meta.id, error }] }
    }
  }
}
