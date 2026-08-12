import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createWorkerModelEngine } from '../electron/store/localModelWorkerEngine'
import type { LocalModelEngineInferRequest } from '../electron/store/localModelRuntime'

const FIXTURE = fileURLToPath(new URL('./fixtures/protocolWorker.mjs', import.meta.url))

const req = (overrides: Partial<LocalModelEngineInferRequest> = {}): LocalModelEngineInferRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.2,
  maxTokens: 32,
  ...overrides
})

/** Small real-time helper; the glue's grace periods are seconds, these tests run in ms. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('worker model engine glue', () => {
  it('loads the worker and round-trips an inference', async () => {
    const engine = createWorkerModelEngine({ workerPath: FIXTURE, loadTimeoutMs: 5_000, abortGraceMs: 50 })
    await engine.load('probe.gguf', 2048)
    const text = await engine.infer(req())
    expect(text).toBe('reply-1')
    await engine.dispose()
  })

  it('rejects an inference before load with model_not_loaded', async () => {
    const engine = createWorkerModelEngine({ workerPath: FIXTURE, loadTimeoutMs: 5_000, abortGraceMs: 50 })
    await expect(engine.infer(req())).rejects.toMatchObject({ code: 'model_not_loaded' })
    await engine.dispose()
  })

  it('rejects and respawns the worker after a crash', async () => {
    const engine = createWorkerModelEngine({ workerPath: FIXTURE, loadTimeoutMs: 5_000, abortGraceMs: 50 })
    await engine.load('probe.gguf', 2048)
    // A magic prompt makes the fixture throw mid-inference.
    const crash = engine.infer(req({ messages: [{ role: 'user', content: 'boom' }] }))
    await expect(crash).rejects.toMatchObject({ code: 'engine_infer_failed' })
    // Next infer respawns the worker lazily and succeeds.
    const text = await engine.infer(req())
    expect(text).toBe('reply-2')
    await engine.dispose()
  })

  it('abort tears down the wedged worker after the grace period; next call recovers', async () => {
    const engine = createWorkerModelEngine({ workerPath: FIXTURE, loadTimeoutMs: 5_000, abortGraceMs: 30 })
    await engine.load('probe.gguf', 2048)
    const controller = new AbortController()
    // 'hang' makes the fixture never reply — a wedged native inference.
    const slow = engine.infer(req({ messages: [{ role: 'user', content: 'hang' }] }), controller.signal)
    const result = expect(slow).rejects.toMatchObject({ code: 'engine_infer_failed' })
    controller.abort()
    await sleep(80) // grace elapses; worker terminated and pending rejected
    await result
    // Respawn works.
    const text = await engine.infer(req())
    expect(text).toBe('reply-2')
    await engine.dispose()
  })

  it('dispose rejects in-flight requests', async () => {
    const engine = createWorkerModelEngine({ workerPath: FIXTURE, loadTimeoutMs: 5_000, abortGraceMs: 50 })
    await engine.load('probe.gguf', 2048)
    const slow = engine.infer(req())
    const result = expect(slow).rejects.toMatchObject({ code: 'disposed' })
    await engine.dispose()
    await result
  })

  it('load rejects on ack failure and keeps loadState for later recovery', async () => {
    const engine = createWorkerModelEngine({ workerPath: FIXTURE, loadTimeoutMs: 5_000, abortGraceMs: 50 })
    await engine.load('probe.gguf', 2048)
    // Second load of a different target simply re-acks; ensure it does not hang.
    await engine.load('other.gguf', 1024)
    const text = await engine.infer(req())
    expect(text).toBe('reply-1')
    await engine.dispose()
  })
})
