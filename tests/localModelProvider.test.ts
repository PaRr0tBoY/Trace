import { describe, expect, it, vi } from 'vitest'

import type { ModelSpec } from '../electron/store/localModelManager'
import { LocalModelRuntime, type LocalModelEngine } from '../electron/store/localModelRuntime'
import { createLocalModelChatProvider } from '../electron/store/localModelProvider'
import type { ChatRequest } from '../electron/main/provider'

/**
 * Chat adapter tests (t54) — the runtime always runs against a fake engine
 * (t53 precedent); the adapter's job is the ChatRequest → ChatResult mapping.
 */

const SPEC: ModelSpec = {
  id: 'fake-qwen',
  name: 'Fake Qwen',
  fileName: 'fake-qwen.gguf',
  url: 'https://model.example.test/fake-qwen.gguf',
  sizeBytes: 100,
  sha256: 'fake',
  contextSize: 512,
  maxTokens: 16,
  temperature: 0.2
}

function fakeEngine(reply: string, failWith?: Error): LocalModelEngine {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    infer: failWith ? vi.fn().mockRejectedValue(failWith) : vi.fn().mockResolvedValue(reply),
    dispose: vi.fn().mockResolvedValue(undefined)
  }
}

async function readyRuntime(engine: LocalModelEngine): Promise<LocalModelRuntime> {
  const runtime = new LocalModelRuntime({ engine })
  await runtime.load({ modelPath: 'C:/fake/qwen.gguf', spec: SPEC })
  return runtime
}

describe('createLocalModelChatProvider', () => {
  it('maps a plain chat request to runtime.infer and returns a ChatResult', async () => {
    const runtime = await readyRuntime(fakeEngine('hello from the local model'))
    const chat = createLocalModelChatProvider(runtime, { id: 'local-model', name: SPEC.name })
    const result = await chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toBe('hello from the local model')
      expect(result.parsed).toBeUndefined()
      expect(result.providerIndex).toBe(-1)
      expect(result.provider.model).toBe(SPEC.name)
    }
  })

  it('maps a schema request to runtime.inferJson with the validated parsed value', async () => {
    const runtime = await readyRuntime(fakeEngine('{"items": [{"index": 1, "title": "draft"}]}'))
    const chat = createLocalModelChatProvider(runtime, { id: 'local-model', name: SPEC.name })
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'rank' }],
      schema: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, title: { type: 'string' } }, required: ['index'] } } },
        required: ['items']
      }
    }
    const result = await chat(req)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mode).toBe('json_schema')
      expect(result.parsed).toEqual({ items: [{ index: 1, title: 'draft' }] })
    }
  })

  it('reports inference failures as ok:false with the local provider id', async () => {
    const runtime = await readyRuntime(fakeEngine('', new Error('engine crashed')))
    const chat = createLocalModelChatProvider(runtime, { id: 'local-model', name: SPEC.name })
    const result = await chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('engine crashed')
      expect(result.attempts).toEqual([{ providerId: 'local-model', error: result.error }])
    }
  })
})
