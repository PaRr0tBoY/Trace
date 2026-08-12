import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../shared/types'
import {
  ProviderChain,
  buildLocalProvider,
  buildChatBody,
  detectOllama,
  normalizeChatUrl,
  testProvider,
  validateJsonSchema,
  type JsonSchemaObject
} from '../electron/main/provider'

/** Minimal suggestion-shaped schema (t16 produces, t15 validates). */
const SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: { title: { type: 'string' }, confidence: { type: 'number' } },
  required: ['title', 'confidence']
}

const LOCAL: ProviderConfig = {
  id: 'local',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:8b',
  kind: 'local',
  supportsSchemaOutput: true
}

const CLOUD: ProviderConfig = {
  id: 'cloud',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  model: 'deepseek-v4-flash',
  kind: 'cloud',
  supportsSchemaOutput: false
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function chatResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] })
}

function makeChain(providers: ProviderConfig[], fetchImpl: typeof fetch): ProviderChain {
  return new ProviderChain({ getProviders: () => providers, fetchImpl })
}

function lastBody(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1][1] as RequestInit
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

describe('structured output: two-level degradation', () => {
  it('uses json_schema + strict response_format when the provider supports it', async () => {
    const fetchImpl = vi.fn(async () => chatResponse(JSON.stringify({ title: 't', confidence: 0.8 })))
    const res = await makeChain([LOCAL], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(lastBody(fetchImpl).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'trace_response', schema: SCHEMA, strict: true }
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.mode).toBe('json_schema')
      expect(res.parsed).toEqual({ title: 't', confidence: 0.8 })
    }
  })

  it('falls back to json_object and embeds the schema when unsupported', async () => {
    const fetchImpl = vi.fn(async () => chatResponse(JSON.stringify({ title: 'x', confidence: 0.5 })))
    const res = await makeChain([CLOUD], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    const body = lastBody(fetchImpl)
    expect(body.response_format).toEqual({ type: 'json_object' })
    const messages = body.messages as Array<{ role: string; content: string }>
    expect(messages[messages.length - 1].role).toBe('system')
    expect(messages[messages.length - 1].content).toContain('"type":"object"')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.mode).toBe('json_object')
  })

  it('plain text calls skip response_format entirely', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('hello'))
    const res = await makeChain([LOCAL], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(lastBody(fetchImpl).response_format).toBeUndefined()
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.content).toBe('hello')
  })

  it('passes max_tokens through and sends the api key header', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('ok'))
    await makeChain([CLOUD], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 128 })
    expect(lastBody(fetchImpl).max_tokens).toBe(128)
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })
})

describe('adaptive escalation (endpoint reality)', () => {
  it('degrades json_schema to json_object on HTTP 400 and succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'This response_format type is unavailable now' } }, 400))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 't', confidence: 0.8 })))
    const res = await makeChain([LOCAL], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.mode).toBe('json_object')
      expect(lastBody(fetchImpl).response_format).toEqual({ type: 'json_object' })
    }
  })

  it('retries with thinking disabled when a reasoning model burns the output budget', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse('')) // reasoning_content ate max_tokens
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 't', confidence: 0.7 })))
    const res = await makeChain([LOCAL], fetchImpl).callChat({
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      maxTokens: 200
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const first = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>
      const second = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body)) as Record<string, unknown>
      expect(first.thinking).toBeUndefined()
      expect(second.thinking).toEqual({ type: 'disabled' })
      expect(second.max_tokens).toBe(800) // 200 * scale 4
    }
  })

  it('drops the thinking param and scales the budget when the endpoint rejects it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(''))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'unknown parameter' } }, 400))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 't', confidence: 0.6 })))
    const res = await makeChain([LOCAL], fetchImpl).callChat({
      messages: [{ role: 'user', content: 'hi' }],
      schema: SCHEMA,
      maxTokens: 100
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const third = JSON.parse(String((fetchImpl.mock.calls[2][1] as RequestInit).body)) as Record<string, unknown>
      expect(third.thinking).toBeUndefined()
      expect(third.max_tokens).toBe(400) // 100 * scale 4
    }
  })

  it('keeps the bounded validation-retry budget for invalid JSON (no escalation)', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{"not": "json"}'))
    const res = await makeChain([LOCAL], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(res.ok).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(3) // 1 + RETRY_LIMIT
  })

  it('logs request and result entries through the log hook', async () => {
    const entries: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async () => chatResponse(JSON.stringify({ title: 't', confidence: 0.8 })))
    const chain = new ProviderChain({ getProviders: () => [LOCAL], fetchImpl, log: (e) => entries.push(e) })
    const res = await chain.callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(res.ok).toBe(true)
    expect(entries.map((e) => e.kind)).toEqual(['provider.request', 'provider.result'])
    expect(entries[1]).toMatchObject({ ok: true, providerId: 'local' })
  })
})

describe('client-side validation retry', () => {
  it('retries the same provider when the reply is truncated mid-JSON', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse('{"title": "trun')) // max_tokens cut
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'ok', confidence: 0.9 })))
    const res = await makeChain([LOCAL], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.parsed).toEqual({ title: 'ok', confidence: 0.9 })
  })

  it('retries when the JSON is valid but violates the schema', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'no-confidence' })))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'a', confidence: 0.1 })))
    const res = await makeChain([LOCAL], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(res.ok).toBe(true)
  })

  it('gives up on the provider after bounded retries and fails over', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{"not": "json"}')) // always invalid
    const res = await makeChain([LOCAL, CLOUD], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('all providers failed')
      expect(res.attempts.map((a) => a.providerId)).toEqual(['local', 'cloud'])
      // 3 attempts per provider (1 + RETRY_LIMIT)
      expect(fetchImpl).toHaveBeenCalledTimes(6)
    }
  })
})

describe('provider chain failover', () => {
  it('fails over to the backup when the primary is unreachable', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'b', confidence: 0.4 })))
    const res = await makeChain([LOCAL, CLOUD], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.provider.id).toBe('cloud')
      expect(res.providerIndex).toBe(1)
      expect(res.mode).toBe('json_object')
    }
  })

  it('fails over on non-2xx with the API error message surfaced', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'model not found' } }, 404))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 't', confidence: 0.2 })))
    const res = await makeChain([LOCAL, CLOUD], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.providerIndex).toBe(1)
  })

  it('reports a clear failure when the whole chain fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const res = await makeChain([LOCAL, CLOUD], fetchImpl).callChat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('all providers failed')
      expect(res.attempts.map((a) => a.providerId)).toEqual(['local', 'cloud'])
    }
  })

  it('fails fast when no providers are configured', async () => {
    const res = await makeChain([], vi.fn()).callChat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('no providers configured')
  })
})

describe('testProvider', () => {
  it('reports success with latency', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('ok'))
    const res = await testProvider(LOCAL, fetchImpl)
    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(res.model).toBe('qwen3:8b')
  })

  it('reports HTTP errors with the API message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401))
    const res = await testProvider(CLOUD, fetchImpl)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(401)
    expect(res.error).toContain('bad key')
  })

  it('reports network failures', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const res = await testProvider(LOCAL, fetchImpl)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/fetch failed/)
  })
})

describe('detectOllama', () => {
  it('finds a running instance and lists its models', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'qwen3:8b' }, { id: 'llama3.1:8b' }] }))
    const res = await detectOllama('http://127.0.0.1:11434', fetchImpl)
    expect(res.found).toBe(true)
    expect(res.models).toEqual(['qwen3:8b', 'llama3.1:8b'])
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('http://127.0.0.1:11434/v1/models')
  })

  it('reports not-found on 404 and on unreachable', async () => {
    const notFound = await detectOllama(undefined, vi.fn(async () => jsonResponse({}, 404)))
    expect(notFound.found).toBe(false)
    expect(notFound.error).toContain('404')

    const unreachable = await detectOllama(undefined, vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(unreachable.found).toBe(false)
    expect(unreachable.error).toMatch(/ECONNREFUSED/)
  })
})

describe('buildLocalProvider (onboarding prefill)', () => {
  it('prefers an installed qwen3 model', () => {
    const p = buildLocalProvider(['llama3.1:8b', 'qwen3:14b'])
    expect(p.model).toBe('qwen3:14b')
    expect(p.kind).toBe('local')
    expect(p.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(p.supportsSchemaOutput).toBe(true)
  })

  it('falls back to qwen3:8b without a model list', () => {
    expect(buildLocalProvider(undefined).model).toBe('qwen3:8b')
    expect(buildLocalProvider([]).model).toBe('qwen3:8b')
  })
})

describe('validateJsonSchema', () => {
  it('accepts conforming values', () => {
    expect(validateJsonSchema({ title: 'a', confidence: 0.5 }, SCHEMA)).toBeNull()
    expect(validateJsonSchema({ title: 'a', confidence: 0.5, extra: 1 }, SCHEMA)).toBeNull()
  })

  it('rejects missing required fields and wrong types', () => {
    expect(validateJsonSchema({ title: 'a' }, SCHEMA)).toContain('confidence')
    expect(validateJsonSchema({ title: 1, confidence: 0.5 }, SCHEMA)).toContain('title')
    expect(validateJsonSchema({ title: 'a', confidence: 'high' }, SCHEMA)).toContain('confidence')
  })

  it('rejects non-object roots', () => {
    expect(validateJsonSchema([1, 2], SCHEMA)).toContain('object')
    expect(validateJsonSchema(null, SCHEMA)).toContain('object')
    expect(validateJsonSchema('str', SCHEMA)).toContain('object')
  })

  it('validates nested objects and arrays', () => {
    const nested: JsonSchemaObject = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }
      },
      required: ['items']
    }
    expect(validateJsonSchema({ items: [{ n: 1 }, { n: 2 }] }, nested)).toBeNull()
    expect(validateJsonSchema({ items: [{ n: 1 }, {}] }, nested)).toContain('n')
    expect(validateJsonSchema({ items: 'nope' }, nested)).toContain('array')
  })
})

describe('request plumbing', () => {
  it('normalizes base urls to /chat/completions', () => {
    expect(normalizeChatUrl('http://x:11434/v1')).toBe('http://x:11434/v1/chat/completions')
    expect(normalizeChatUrl('http://x:11434/v1/')).toBe('http://x:11434/v1/chat/completions')
    expect(normalizeChatUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions')
    expect(normalizeChatUrl('http://x/v1/chat/completions')).toBe('http://x/v1/chat/completions')
  })

  it('buildChatBody embeds the schema only in json_object mode', () => {
    const schemaBody = buildChatBody(LOCAL, { messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA }, 'json_schema')
    expect((schemaBody.messages as unknown[]).length).toBe(1)
    const objBody = buildChatBody(CLOUD, { messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA }, 'json_object')
    expect((objBody.messages as unknown[]).length).toBe(2)
  })
})
