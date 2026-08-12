/**
 * Local model worker (t53) — the actual llama.cpp inference, running on a
 * node:worker_threads worker so the main process never blocks.
 *
 * NEVER imported from vitest: node-llama-cpp is a native addon and tests
 * exercise the queue semantics against a fake engine instead (the glue in
 * localModelWorkerEngine.ts spawns this file).
 *
 * Model packaging per spec 实现决策 11:
 * - Qwen3-0.6B GGUF Q8_0 (official repo), `/no_think` system instruction to
 *   explicitly disable the thinking phase (Qwen3 chat template honours it).
 * - Short context (2048), low max_tokens (128), low temperature (0.2).
 * - Strict JSON: when a schema is present, generation is constrained with a
 *   JSON-schema grammar (`createGrammarForJsonSchema`) in addition to the
 *   client-side validation + retry done by the runtime.
 * - `gpu: false`: the packaged build ships no CUDA/Vulkan variants (t32) and
 *   an explicit CPU target skips the slow Vulkan probe entirely.
 *
 * Message protocol (parent -> worker / worker -> parent):
 *   { type: 'load', modelPath, contextSize }         -> { type: 'load-result', ok, error? }
 *   { type: 'infer', id, history, temperature,
 *     maxTokens, schema? }                           -> { type: 'infer-result', id, ok, text?, error? }
 *   { type: 'dispose' }                              -> exits
 */
import { parentPort } from 'node:worker_threads'
import {
  getLlama,
  LlamaChat,
  LlamaLogLevel,
  type ChatHistoryItem,
  type GbnfJsonObjectSchema,
  type GbnfJsonSchema,
  type Llama,
  type LlamaContext,
  type LlamaGrammar,
  type LlamaModel,
  type LLamaChatLoadAndCompleteUserMessageOptions
} from 'node-llama-cpp'
import type { JsonSchemaObject } from '../main/provider'

interface InferMessage {
  type: 'infer'
  id: number
  history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature: number
  maxTokens: number
  schema?: JsonSchemaObject
}

interface LoadMessage {
  type: 'load'
  modelPath: string
  contextSize: number
}

let llama: Llama | null = null
let model: LlamaModel | null = null
let context: LlamaContext | null = null
let grammarCache = new Map<string, LlamaGrammar>()
/** Load request of the live worker (the worker also loads lazily on first infer). */
let loadState: { modelPath: string; contextSize: number } | null = null

const SYSTEM_PROMPT = '/no_think\nYou are a helpful assistant for the Trace app. Keep replies short and factual.'
const JSON_SYSTEM_PROMPT = '/no_think\nYou are a JSON-only assistant. Reply with a single JSON object matching the requested schema. No prose, no markdown.'

function toHistory(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, jsonMode: boolean): ChatHistoryItem[] {
  const history = messages.map((m): ChatHistoryItem => {
    if (m.role === 'assistant') return { type: 'model', response: [m.content] }
    if (m.role === 'system') return { type: 'system', text: m.content }
    return { type: 'user', text: m.content }
  })
  // /no_think must be in the system turn for Qwen3's chat template to skip the
  // thinking phase; our prompt always leads, caller messages follow verbatim.
  history.unshift({ type: 'system', text: jsonMode ? JSON_SYSTEM_PROMPT : SYSTEM_PROMPT })
  return history
}

async function ensureLoaded(): Promise<void> {
  if (llama && model && context) return
  if (!loadState) throw new Error('worker not loaded')
  llama = await getLlama({ gpu: false, logLevel: LlamaLogLevel.warn })
  model = await llama.loadModel({ modelPath: loadState.modelPath })
  context = await model.createContext({ contextSize: loadState.contextSize })
  grammarCache = new Map()
}

function grammarSchemaFor(schema: JsonSchemaObject): GbnfJsonObjectSchema<string, Record<string, never>> {
  // Our JsonSchemaObject subset maps 1:1 onto the grammar schema shape; the
  // concrete object type (not the union) keeps the generic inference happy.
  return {
    type: 'object',
    properties: schema.properties as unknown as Record<string, GbnfJsonSchema<Record<string, never>>>,
    required: schema.required
  }
}

async function grammarFor(schema: JsonSchemaObject): Promise<LlamaGrammar> {
  const key = JSON.stringify(schema)
  const cached = grammarCache.get(key)
  if (cached) return cached
  if (!llama) throw new Error('llama not loaded')
  const grammar = await llama.createGrammarForJsonSchema(grammarSchemaFor(schema))
  grammarCache.set(key, grammar)
  return grammar
}

async function handleInfer(msg: InferMessage): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    await ensureLoaded()
    // Every infer gets a fresh chat session (fresh context sequence) so
    // one-shot requests never contaminate each other's context window; the
    // sequence slot is released afterwards.
    const session = new LlamaChat({ contextSequence: context!.getSequence(), chatWrapper: 'auto' })
    try {
      const options: LLamaChatLoadAndCompleteUserMessageOptions = {
        temperature: msg.temperature,
        maxTokens: msg.maxTokens
      }
      if (msg.schema) options.grammar = await grammarFor(msg.schema)
      const response = await session.loadChatAndCompleteUserMessage(toHistory(msg.history, msg.schema !== undefined), options)
      return { ok: true, text: response.completion }
    } finally {
      session.dispose({ disposeSequence: true })
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function handleLoad(msg: LoadMessage): Promise<{ ok: true } | { ok: false; error: string }> {
  loadState = { modelPath: msg.modelPath, contextSize: msg.contextSize }
  try {
    await ensureLoaded()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function disposeAll(): Promise<void> {
  try {
    if (context) await context.dispose()
    if (model) await model.dispose()
    if (llama) await llama.dispose()
  } finally {
    context = null
    model = null
    llama = null
    loadState = null
    grammarCache = new Map()
  }
}

if (parentPort) {
  parentPort.on('message', (msg: LoadMessage | InferMessage | { type: 'dispose' }) => {
    if (msg.type === 'load') {
      void handleLoad(msg).then((result) => parentPort!.postMessage({ type: 'load-result', ...result }))
    } else if (msg.type === 'infer') {
      void handleInfer(msg).then((result) => parentPort!.postMessage({ type: 'infer-result', id: msg.id, ...result }))
    } else if (msg.type === 'dispose') {
      void disposeAll().then(() => process.exit(0))
    }
  })
}
