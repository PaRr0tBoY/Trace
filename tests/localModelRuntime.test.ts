import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { ModelSpec } from '../electron/store/localModelManager'
import {
  extractJsonObject,
  LocalModelRuntime,
  type LocalModelEngine,
  type LocalModelEngineInferRequest
} from '../electron/store/localModelRuntime'

/**
 * Queue / timeout / failure-path tests (t53) — the engine is always a fake,
 * so no model is ever loaded. The runtime must serve the queue after a
 * timeout or a failure (失败不崩溃), enforce the concurrency limit, and retry
 * strict-JSON calls with a repair message.
 */

const SPEC: ModelSpec = {
  id: 'fake-qwen',
  name: 'Fake Qwen',
  fileName: 'fake-qwen.gguf',
  url: 'https://model.example.test/fake-qwen.gguf',
  sizeBytes: 100,
  sha256: '0'.repeat(64),
  contextSize: 2048,
  maxTokens: 128,
  temperature: 0.2
}

const user = (content: string) => ({ role: 'user' as const, content })

interface FakeEngine extends LocalModelEngine {
  load: Mock<() => Promise<void>>
  infer: Mock<(req: LocalModelEngineInferRequest, signal?: AbortSignal) => Promise<string>>
  dispose: Mock<() => Promise<void>>
}

function fakeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
  return {
    load: vi.fn(async () => {}),
    infer: vi.fn(async (_req: LocalModelEngineInferRequest) => '{}'),
    dispose: vi.fn(async () => {}),
    ...overrides
  }
}

/**
 * Microtask flush (deterministic, no wall clock): the runtime's queue
 * progresses through a few awaited hops between assertions.
 */
const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('local model runtime: queue', () => {
  it('enforces the concurrency limit and serves requests FIFO', async () => {
    const resolvers: Array<(value: string) => void> = []
    const engine = fakeEngine({
      infer: vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)))
    })
    const rt = new LocalModelRuntime({ engine, concurrency: 1 })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    const p1 = rt.infer({ messages: [user('a')] })
    const p2 = rt.infer({ messages: [user('b')] })
    const p3 = rt.infer({ messages: [user('c')] })
    await flush()

    expect(engine.infer).toHaveBeenCalledTimes(1)
    expect(rt.status().pending).toBe(3)
    expect(rt.status().inFlight).toBe(1)

    resolvers[0]('r1')
    await expect(p1).resolves.toBe('r1')
    await flush()
    expect(engine.infer).toHaveBeenCalledTimes(2)

    resolvers[1]('r2')
    await expect(p2).resolves.toBe('r2')
    await flush()
    expect(engine.infer).toHaveBeenCalledTimes(3)

    resolvers[2]('r3')
    await expect(p3).resolves.toBe('r3')
    expect(rt.status().pending).toBe(0)
  })

  it('applies spec defaults for temperature and maxTokens, overridable per call', async () => {
    const engine = fakeEngine()
    const rt = new LocalModelRuntime({ engine })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    await rt.infer({ messages: [user('hi')] })
    expect(engine.infer.mock.calls[0][0]).toMatchObject({ temperature: 0.2, maxTokens: 128 })

    await rt.infer({ messages: [user('hi')], temperature: 0.7, maxTokens: 32 })
    expect(engine.infer.mock.calls[1][0]).toMatchObject({ temperature: 0.7, maxTokens: 32 })
  })
})

describe('local model runtime: timeout', () => {
  it('abandons a timed-out inference, frees the slot and keeps serving', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const engine = fakeEngine({
      infer: vi.fn((_req: LocalModelEngineInferRequest, signal?: AbortSignal) => {
        signals.push(signal!)
        return new Promise<string>(() => {})
      })
    })
    const rt = new LocalModelRuntime({ engine, defaultTimeoutMs: 1000 })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    const slow = rt.infer({ messages: [user('slow')] })
    // Attach the rejection handler BEFORE advancing: the rejection fires inside
    // advanceTimersByTimeAsync's own async turns, and a handler attached after
    // the advance would surface as an unhandledRejection.
    const slowResult = expect(slow).rejects.toMatchObject({ code: 'timeout' })
    const next = rt.infer({ messages: [user('next')] })
    await vi.advanceTimersByTimeAsync(1000)
    await slowResult

    expect(signals[0].aborted).toBe(true)
    // The slot freed: the queued request started while the first was abandoned.
    expect(engine.infer).toHaveBeenCalledTimes(2)
    expect(rt.status().inFlight).toBe(1)
  })

  it('a timed-out runtime still completes a normal request afterwards', async () => {
    vi.useFakeTimers()
    const engine = fakeEngine({
      infer: vi
        .fn()
        .mockImplementationOnce(() => new Promise<string>(() => {}))
        .mockResolvedValueOnce('fast result')
    })
    const rt = new LocalModelRuntime({ engine, defaultTimeoutMs: 1000 })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    const slow = rt.infer({ messages: [user('slow')] })
    const slowResult = expect(slow).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(1000)
    await slowResult

    vi.useRealTimers()
    const fast = rt.infer({ messages: [user('fast')] })
    await expect(fast).resolves.toBe('fast result')
  })
})

describe('local model runtime: failure isolation', () => {
  it('a failed inference rejects only its own request', async () => {
    const engine = fakeEngine({
      infer: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok')
    })
    const rt = new LocalModelRuntime({ engine })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    await expect(rt.infer({ messages: [user('x')] })).rejects.toThrow('boom')
    await expect(rt.infer({ messages: [user('y')] })).resolves.toBe('ok')
  })

  it('a failed load rejects only that request and the next infer retries loading', async () => {
    const engine = fakeEngine({
      load: vi
        .fn()
        .mockRejectedValueOnce(new Error('bad model file'))
        .mockRejectedValueOnce(new Error('still bad'))
        .mockResolvedValueOnce(undefined)
    })
    const rt = new LocalModelRuntime({ engine })
    const loadOptions = { modelPath: 'm.gguf', spec: SPEC }

    await expect(rt.load(loadOptions)).rejects.toMatchObject({ code: 'engine_load_failed' })
    expect(rt.status().state).toBe('error')
    // The infer that triggers the reload also fails (load #2), isolating the failure.
    await expect(rt.infer({ messages: [user('x')] })).rejects.toMatchObject({ code: 'engine_load_failed' })
    expect(rt.status().state).toBe('error')
    // Lazy retry: the next infer reloads and succeeds.
    await expect(rt.infer({ messages: [user('y')] })).resolves.toBe('{}')
    expect(engine.load).toHaveBeenCalledTimes(3)
  })

  it('rejects inference before load with model_not_loaded', async () => {
    const rt = new LocalModelRuntime({ engine: fakeEngine() })
    await expect(rt.infer({ messages: [user('x')] })).rejects.toMatchObject({ code: 'model_not_loaded' })
  })

  it('load is idempotent: concurrent callers share one engine load', async () => {
    const engine = fakeEngine()
    const rt = new LocalModelRuntime({ engine })
    const opts = { modelPath: 'm.gguf', spec: SPEC }
    await Promise.all([rt.load(opts), rt.load(opts)])
    expect(engine.load).toHaveBeenCalledTimes(1)
  })

  it('dispose rejects queued work and releases the engine', async () => {
    const resolvers: Array<(value: string) => void> = []
    const engine = fakeEngine({
      infer: vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)))
    })
    const rt = new LocalModelRuntime({ engine, concurrency: 1 })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    const running = rt.infer({ messages: [user('r')] })
    const queued = rt.infer({ messages: [user('q')] })
    await flush()

    await rt.dispose()
    await expect(queued).rejects.toMatchObject({ code: 'disposed' })
    expect(engine.dispose).toHaveBeenCalledTimes(1)
    // In-flight work is left to settle on its own (engine-dependent).
    resolvers[0]('late')
    await expect(running).resolves.toBe('late')
  })
})

describe('local model runtime: strict JSON with retry', () => {
  const SCHEMA = {
    type: 'object' as const,
    properties: { title: { type: 'string' as const }, confidence: { type: 'number' as const } },
    required: ['title', 'confidence']
  }

  it('parses, validates and retries until the reply is schema-valid', async () => {
    const engine = fakeEngine({
      infer: vi
        .fn()
        .mockResolvedValueOnce('sure, here you go: {"title":"nope"}') // missing confidence
        .mockResolvedValueOnce('not json at all')
        .mockResolvedValueOnce('{"title":"ok","confidence":0.8}')
    })
    const rt = new LocalModelRuntime({ engine, jsonRetryLimit: 2 })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    await expect(rt.inferJson({ messages: [user('summarize')], schema: SCHEMA })).resolves.toEqual({
      title: 'ok',
      confidence: 0.8
    })
    expect(engine.infer).toHaveBeenCalledTimes(3)
    const repair = engine.infer.mock.calls[2][0].messages
    expect(repair[repair.length - 1].content).toContain('Your previous reply was rejected')
    expect(repair[repair.length - 1].content).toContain('reply contained no JSON object')
  })

  it('throws invalid_json after exhausting the retry budget', async () => {
    const engine = fakeEngine({
      infer: vi.fn().mockResolvedValue('garbage output')
    })
    const rt = new LocalModelRuntime({ engine, jsonRetryLimit: 2 })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    await expect(rt.inferJson({ messages: [user('x')], schema: SCHEMA })).rejects.toMatchObject({
      code: 'invalid_json',
      details: {
        attempts: ['reply contained no JSON object', 'reply contained no JSON object', 'reply contained no JSON object']
      }
    })
  })

  it('passes the schema to the engine for grammar-constrained generation', async () => {
    const engine = fakeEngine({
      infer: vi.fn().mockResolvedValue('{"title":"t","confidence":0.5}')
    })
    const rt = new LocalModelRuntime({ engine })
    await rt.load({ modelPath: 'm.gguf', spec: SPEC })

    await rt.inferJson({ messages: [user('x')], schema: SCHEMA })
    expect(engine.infer.mock.calls[0][0].schema).toEqual(SCHEMA)
  })

  it('requires a schema on inferJson', async () => {
    const rt = new LocalModelRuntime({ engine: fakeEngine() })
    await expect(rt.inferJson({ messages: [user('x')] })).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

describe('extractJsonObject', () => {
  it('parses exact JSON fast-path', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('extracts JSON wrapped in prose', () => {
    expect(extractJsonObject('Sure! Here is the JSON:\n{"a":1}\nHope it helps.')).toEqual({ a: 1 })
  })

  it('skips a leaked think block', () => {
    expect(extractJsonObject('<think>I should not think here.</think>\n{"a":1}')).toEqual({ a: 1 })
  })

  it('ignores braces inside strings', () => {
    expect(extractJsonObject('prefix {"a":"}"} trailing')).toEqual({ a: '}' })
  })

  it('extracts nested objects', () => {
    expect(extractJsonObject('x {"a":{"b":[1,2]}} y')).toEqual({ a: { b: [1, 2] } })
  })

  it('returns undefined when no JSON object is present', () => {
    expect(extractJsonObject('just prose')).toBeUndefined()
    expect(extractJsonObject('')).toBeUndefined()
    expect(extractJsonObject('{"a":1')).toBeUndefined()
  })
})
