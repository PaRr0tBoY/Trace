/**
 * AI provider layer — pure logic, zero Electron imports (vitest-friendly).
 *
 * Wire protocol: OpenAI-compatible POST /v1/chat/completions, shared by
 * LM Studio / DeepSeek / Qwen endpoints alike. A provider is just a
 * `baseUrl + apiKey? + model` triple (see ProviderConfig in shared/types).
 *
 * Structured output degrades in two steps:
 *   1. `response_format: {type:'json_schema', json_schema:{schema, strict:true}}`
 *      — used when the provider advertises supportsSchemaOutput (default).
 *   2. `response_format: {type:'json_object'}` + the schema embedded into the
 *      last message — for DeepSeek-style endpoints without a schema contract.
 * The client ALWAYS parses and validates the reply against the schema and
 * retries a bounded number of times: even strict mode produces malformed JSON
 * when max_tokens truncates the payload (Murphy's law).
 *
 * Failover: providers are tried in configured (array) order; any provider that
 * fails — network, HTTP error, or validation-exhaustion — is skipped for this
 * call. When the whole chain fails the caller gets an explicit `ok:false` and
 * decides (t19: silent degradation).
 *
 * Logging follows the project convention: `[AI]` tag, one line per state
 * change (failover), no per-request noise.
 */
import type { ProviderConfig } from '../../shared/types'
import type { ProviderTestResult } from '../../shared/ipc'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * JSON Schema subset used for both the request (`response_format`) and the
 * client-side validation. Single source of truth for the wire contract.
 */
export type JsonSchemaProp =
  | { type: 'string'; enum?: string[] }
  | { type: 'number' }
  | { type: 'integer' }
  | { type: 'boolean' }
  | { type: 'array'; items: JsonSchemaProp }
  | { type: 'object'; properties: Record<string, JsonSchemaProp>; required?: string[] }

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, JsonSchemaProp>
  required: string[]
}

export interface ChatRequest {
  messages: ChatMessage[]
  /** When present the reply must be JSON conforming to this schema. */
  schema?: JsonSchemaObject
  maxTokens?: number
  timeoutMs?: number
}

/** Which structured-output mode produced the reply (absent for plain text). */
export type ChatMode = 'json_schema' | 'json_object'

export type ChatResult =
  | {
    ok: true
    content: string
    /** Schema mode: the validated parsed JSON; plain text: undefined. */
    parsed?: unknown
    provider: ProviderConfig
    providerIndex: number
    mode?: ChatMode
  }
  | { ok: false; error: string; attempts: Array<{ providerId: string; error: string }> }

export interface ProviderChainOptions {
  getProviders: () => ProviderConfig[]
  fetchImpl?: typeof fetch
  /**
   * Observability sink (ai-log.jsonl in prod). Receives one entry per chat
   * call: the request material and the final outcome. Optional, never throws.
   */
  log?: (entry: Record<string, unknown>) => void
}

const DEFAULT_CHAT_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 8_000
/** Bounded client-side retries per provider when the reply fails validation. */
const RETRY_LIMIT = 2

/** Append /chat/completions unless the baseUrl already carries it. */
export function normalizeChatUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
}

/**
 * Build the OpenAI-compatible request body. In json_object mode the schema is
 * embedded into a trailing system message (DeepSeek-style endpoints require
 * the prompt to mention JSON; the schema example is the strongest nudge).
 */
/**
 * Extra per-attempt knobs for the adaptive retry loop (callProvider):
 * `thinking` disables the model's reasoning phase for short structured
 * tasks (DeepSeek-style thinking models burn the output budget on
 * reasoning_content otherwise); `scale` multiplies the requested output
 * budget when a model still needs more room.
 */
export interface ChatExtra {
  thinking?: boolean
  scale?: number
}

export function buildChatBody(provider: ProviderConfig, req: ChatRequest, mode: ChatMode | 'none', extra?: ChatExtra): Record<string, unknown> {
  const messages = req.messages.map((m) => ({ ...m }))
  if (mode === 'json_object' && req.schema) {
    messages.push({
      role: 'system',
      content: `Respond with JSON only, matching this schema exactly:\n${JSON.stringify(req.schema)}`
    })
  }
  const body: Record<string, unknown> = { model: provider.model, messages }
  if (extra?.thinking) body.thinking = { type: 'disabled' }
  if (req.maxTokens !== undefined) {
    body.max_tokens = extra?.scale && extra.scale !== 1 ? req.maxTokens * extra.scale : req.maxTokens
  }
  if (req.schema) {
    if (mode === 'json_schema') {
      body.response_format = { type: 'json_schema', json_schema: { name: 'trace_response', schema: req.schema, strict: true } }
    } else if (mode === 'json_object') {
      body.response_format = { type: 'json_object' }
    }
  }
  return body
}

/** Validate a parsed value against the schema; returns a human error or null. */
export function validateJsonSchema(value: unknown, schema: JsonSchemaObject): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '$: expected object'
  }
  const obj = value as Record<string, unknown>
  for (const key of schema.required) {
    if (!(key in obj)) return `$.${key}: missing required field`
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key in obj) {
      const err = validateProp(obj[key], prop, `$.${key}`)
      if (err) return err
    }
  }
  return null
}

function validateProp(value: unknown, prop: JsonSchemaProp, path: string): string | null {
  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') return `${path}: expected string`
      if (prop.enum && !prop.enum.includes(value)) return `${path}: must be one of ${prop.enum.join(', ')}`
      return null
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path}: expected number`
    case 'integer':
      return Number.isInteger(value) ? null : `${path}: expected integer`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: expected boolean`
    case 'array': {
      if (!Array.isArray(value)) return `${path}: expected array`
      for (let i = 0; i < value.length; i++) {
        const err = validateProp(value[i], prop.items, `${path}[${i}]`)
        if (err) return err
      }
      return null
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path}: expected object`
      const obj = value as Record<string, unknown>
      for (const key of prop.required ?? []) {
        if (!(key in obj)) return `${path}.${key}: missing required field`
      }
      for (const [key, sub] of Object.entries(prop.properties)) {
        if (key in obj) {
          const err = validateProp(obj[key], sub, `${path}.${key}`)
          if (err) return err
        }
      }
      return null
    }
  }
}

/**
 * Connection test: one small chat completion, latency included. Success is
 * HTTP-level (like before), but the probe also flags thinking models — a
 * reasoning model spends the output budget on reasoning_content, which is
 * why a plain "HTTP 200" test can still produce empty completions in real
 * calls. The adaptive chain handles those automatically; the flag is for
 * the settings UI hint.
 */
export async function testProvider(
  config: ProviderConfig,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  timeoutMs = TEST_TIMEOUT_MS
): Promise<ProviderTestResult> {
  const started = Date.now()
  try {
    const res = await fetchImpl(normalizeChatUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 32
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      return { ok: false, latencyMs, status: res.status, error: await extractApiError(res) }
    }
    let thinkingModel = false
    try {
      const data = (await res.json()) as { choices?: Array<{ message?: { reasoning_content?: unknown } }> }
      const reasoning = data?.choices?.[0]?.message?.reasoning_content
      thinkingModel = typeof reasoning === 'string' && reasoning.length > 0
    } catch {
      // response body unreadable — still a reachable endpoint
    }
    return { ok: true, latencyMs, model: config.model, thinkingModel }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Hard cap on adaptive retry attempts per provider (escalations included). */
const MAX_ATTEMPTS = 6

/** Provider chain: configured order = priority, auto-failover within the list. */
export class ProviderChain {
  private readonly getProviders: () => ProviderConfig[]
  private readonly fetchImpl: typeof fetch
  private readonly log: (entry: Record<string, unknown>) => void

  constructor(options: ProviderChainOptions) {
    this.getProviders = options.getProviders
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.log = options.log ?? (() => {})
  }

  async callChat(req: ChatRequest): Promise<ChatResult> {
    const providers = this.getProviders()
    if (providers.length === 0) {
      this.log({ kind: 'provider.request', providers: [], messages: req.messages })
      return { ok: false, error: 'no providers configured', attempts: [] }
    }
    const started = Date.now()
    this.log({
      kind: 'provider.request',
      providers: providers.map((p) => ({ id: p.id, model: p.model, baseUrl: p.baseUrl })),
      messages: req.messages,
      maxTokens: req.maxTokens
    })
    const attempts: Array<{ providerId: string; error: string }> = []
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]
      const outcome = await this.callProvider(provider, req)
      if (outcome.ok) {
        this.log({
          kind: 'provider.result',
          ok: true,
          providerId: provider.id,
          latencyMs: Date.now() - started,
          mode: outcome.mode,
          content: outcome.content,
          parsed: outcome.parsed
        })
        return { ...outcome, provider, providerIndex: i }
      }
      attempts.push({ providerId: provider.id, error: outcome.error })
      if (i < providers.length - 1) {
        console.log(`[AI] provider failover: ${provider.id} -> ${providers[i + 1].id} (${outcome.error})`)
      }
    }
    const failure = { ok: false as const, error: 'all providers failed', attempts }
    this.log({
      kind: 'provider.result',
      ok: false,
      latencyMs: Date.now() - started,
      error: failure.error,
      attempts
    })
    console.log(`[AI] all providers failed: ${attempts.map((a) => `${a.providerId} (${a.error})`).join('; ')}`)
    return failure
  }

  /**
   * Adaptive structured-output retry per provider. Escalations, in order:
   *   1. Endpoint rejects json_schema (HTTP 400) -> json_object + embedded schema.
   *   2. Empty completion (a thinking model burned the output budget on
   *      reasoning_content) -> retry with thinking disabled and a 4x budget.
   *   3. Empty again or the thinking param itself is rejected (HTTP 400) ->
   *      drop thinking, retry with an 8x budget.
   * Validation failures keep their own bounded retry budget (RETRY_LIMIT).
   */
  private async callProvider(
    provider: ProviderConfig,
    req: ChatRequest
  ): Promise<{ ok: true; content: string; parsed?: unknown; mode?: ChatMode } | { ok: false; error: string }> {
    if (!req.schema) {
      const posted = await this.postChat(provider, req, 'none', {})
      return posted.ok ? { ok: true, content: posted.content } : { ok: false, error: posted.error }
    }

    // Structured output: schema contract when the endpoint supports it, else
    // json_object + embedded schema.
    let mode: ChatMode = provider.supportsSchemaOutput !== false ? 'json_schema' : 'json_object'
    let thinking = false
    let scale = 1
    let validationRetries = 0
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const posted = await this.postChat(provider, req, mode, { thinking, scale })
      if (!posted.ok) {
        if (posted.error === 'empty completion') {
          if (!thinking) {
            thinking = true
            scale = 4
            continue
          }
          if (scale < 8) {
            scale = 8
            continue
          }
          return { ok: false, error: 'empty completion' }
        }
        if (thinking) {
          // The current mode was accepted before (an earlier 200 proves it),
          // so this 400 is the thinking param — drop it, rely on the budget.
          thinking = false
          scale = 4
          continue
        }
        if (mode === 'json_schema' && posted.status === 400) {
          // "This response_format type is unavailable now" — degrade mode.
          mode = 'json_object'
          continue
        }
        return { ok: false, error: posted.error }
      }
      try {
        const parsed = JSON.parse(posted.content) as unknown
        if (validateJsonSchema(parsed, req.schema) === null) {
          return { ok: true, content: posted.content, parsed, mode }
        }
      } catch {
        // not JSON at all (e.g. max_tokens truncated mid-object) — retry
      }
      if (validationRetries >= RETRY_LIMIT) {
        return { ok: false, error: `invalid JSON after ${RETRY_LIMIT + 1} attempts` }
      }
      validationRetries++
    }
    return { ok: false, error: 'provider attempts exhausted' }
  }

  private async postChat(
    provider: ProviderConfig,
    req: ChatRequest,
    mode: ChatMode | 'none',
    extra: ChatExtra
  ): Promise<{ ok: true; content: string } | { ok: false; error: string; status?: number }> {
    try {
      const res = await this.fetchImpl(normalizeChatUrl(provider.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
        },
        body: JSON.stringify(buildChatBody(provider, req, mode, extra)),
        signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS)
      })
      if (!res.ok) {
        return { ok: false, status: res.status, error: await extractApiError(res) }
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
      const content = data?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.length === 0) {
        return { ok: false, error: 'empty completion' }
      }
      return { ok: true, content }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

/** Best-effort extraction of the API's error message (OpenAI shape or plain body). */
async function extractApiError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: unknown } | string }
    const msg = typeof data.error === 'string' ? data.error : data.error?.message
    if (typeof msg === 'string' && msg) return `HTTP ${res.status}: ${msg}`
  } catch {
    /* body not JSON — fall through to status-only */
  }
  return `HTTP ${res.status}`
}
