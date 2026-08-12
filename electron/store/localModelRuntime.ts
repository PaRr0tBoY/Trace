/**
 * Local model runtime (t53, spec 实现决策 11) — load / infer / queue / timeout.
 *
 * Pure logic: no Electron imports, no node-llama-cpp import (the real engine
 * is a worker thread, see localModelWorker.ts + localModelWorkerEngine.ts).
 * The `LocalModelEngine` interface is injected, so vitest exercises queue /
 * timeout / failure semantics against a fake engine — never a real model.
 *
 * Queue contract (accepted by ticket 53):
 * - Concurrency limit (default 1 — a single model context); FIFO order.
 * - Execution timeout per request: on expiry the request is abandoned with a
 *   LocalModelError('timeout') and the engine's AbortSignal is fired; the
 *   queue slot frees immediately and the queue keeps serving.
 * - Failure isolation: one failing or timed-out request never crashes the
 *   runtime; subsequent requests still run.
 * - Lazy load: the first infer triggers engine.load() when not loaded; a
 *   failed load rejects only that request and the next infer retries.
 * - Strict JSON: inferJson parses the reply, validates it against the schema
 *   (provider.ts validateJsonSchema) and retries with a repair message a
 *   bounded number of times.
 *
 * Model call packaging (spec): /no_think system prompt + low temperature +
 * low max_tokens live in the worker (systemPrompt built there) and the spec
 * defaults (temperature/maxTokens) are applied here.
 */
import { validateJsonSchema, type ChatMessage, type JsonSchemaObject } from '../main/provider'
import { LocalModelError, type ModelSpec } from './localModelManager'

/* ------------------------------------------------------------------ */
/* Engine interface (real impl = worker thread, tests = fake)          */
/* ------------------------------------------------------------------ */

export interface LocalModelEngineInferRequest {
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  /** When present the engine constrains generation to the schema (grammar). */
  schema?: JsonSchemaObject
}

/** What the runtime needs from an engine; the worker glue implements this. */
export interface LocalModelEngine {
  /** Load the model file into memory. Idempotent per engine lifecycle. */
  load(modelPath: string, contextSize: number): Promise<void>
  /** One chat completion; resolves with the raw reply text. */
  infer(request: LocalModelEngineInferRequest, signal?: AbortSignal): Promise<string>
  /** Release the model/context. */
  dispose(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface LocalModelInferRequest {
  messages: ChatMessage[]
  /** Present => strict JSON output (grammar + client validation + retry). */
  schema?: JsonSchemaObject
  temperature?: number
  maxTokens?: number
  /** Execution timeout for this call (defaults to defaultTimeoutMs). */
  timeoutMs?: number
}

export type LocalModelRuntimeState = 'idle' | 'loading' | 'ready' | 'error' | 'disposed'

export interface LocalModelRuntimeStatus {
  state: LocalModelRuntimeState
  /** Last engine load failure message (state 'error'). */
  loadError: string | null
  /** Queued + in-flight inference count. */
  pending: number
  inFlight: number
}

export interface LocalModelRuntimeOptions {
  engine: LocalModelEngine
  /** Max concurrent inferences (default 1 — a single model context). */
  concurrency?: number
  /** Execution timeout per inference (default 60s). */
  defaultTimeoutMs?: number
  /** JSON retry budget after parse/validation failures (default 2). */
  jsonRetryLimit?: number
  /** Injectable scheduler for deterministic timeout tests (defaults to setTimeout). */
  schedule?: (fn: () => void, ms: number) => { cancel(): void }
  onStatusChange?: (status: LocalModelRuntimeStatus) => void
}

const defaultSchedule = (fn: () => void, ms: number): { cancel(): void } => {
  const id = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(id) }
}

export const DEFAULT_RUNTIME_TIMEOUT_MS = 60_000

export class LocalModelRuntime {
  private readonly engine: LocalModelEngine
  private readonly concurrency: number
  private readonly defaultTimeoutMs: number
  private readonly jsonRetryLimit: number
  private readonly schedule: (fn: () => void, ms: number) => { cancel(): void }
  private readonly onStatusChange?: (status: LocalModelRuntimeStatus) => void

  private state: LocalModelRuntimeState = 'idle'
  private loadError: string | null = null
  private loadOptions: { modelPath: string; spec: ModelSpec } | null = null
  private loadingPromise: Promise<void> | null = null
  private queue: Array<{ run(): Promise<unknown>; resolve(v: unknown): void; reject(e: unknown): void }> = []
  private active = 0

  constructor(options: LocalModelRuntimeOptions) {
    this.engine = options.engine
    this.concurrency = options.concurrency ?? 1
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS
    this.jsonRetryLimit = options.jsonRetryLimit ?? 2
    this.schedule = options.schedule ?? defaultSchedule
    this.onStatusChange = options.onStatusChange
  }

  status(): LocalModelRuntimeStatus {
    return {
      state: this.state,
      loadError: this.loadError,
      pending: this.queue.length + this.active,
      inFlight: this.active
    }
  }

  /** Load the model file. Idempotent for the same target; a changed target (e.g. a new manual path) reloads. */
  async load(options: { modelPath: string; spec: ModelSpec }): Promise<void> {
    const sameTarget =
      this.loadOptions !== null && this.loadOptions.modelPath === options.modelPath && this.loadOptions.spec.id === options.spec.id
    this.loadOptions = options
    if (this.state === 'ready' && sameTarget) return
    if (this.loadingPromise) {
      // A load is already in flight: settle it first, then reload only when
      // the requested target differs (otherwise the first caller's load wins).
      const prior = this.loadingPromise
      await prior.catch(() => {})
      if (this.state === 'ready' && sameTarget) return
    }
    this.state = 'loading'
    this.loadError = null
    this.emitStatus()
    const attempt = this.engine
      .load(options.modelPath, options.spec.contextSize)
      .then(() => {
        this.state = 'ready'
        this.emitStatus()
      })
      .catch((e: unknown) => {
        this.state = 'error'
        this.loadError = e instanceof Error ? e.message : String(e)
        this.emitStatus()
        throw e instanceof LocalModelError ? e : new LocalModelError('engine_load_failed', `local model load failed: ${this.loadError}`)
      })
      .finally(() => {
        this.loadingPromise = null
      })
    this.loadingPromise = attempt
    return attempt
  }

  /** Plain text inference through the queue. */
  infer(request: LocalModelInferRequest): Promise<string> {
    return this.enqueue(() => this.runInfer(request))
  }

  /**
   * Strict JSON inference: grammar-constrained generation (when the engine
   * supports it), client-side parse + schema validation, bounded retry with a
   * repair message. Resolves with the validated parsed value.
   */
  inferJson(request: LocalModelInferRequest): Promise<unknown> {
    if (!request.schema) {
      return Promise.reject(new LocalModelError('invalid_request', 'inferJson requires request.schema'))
    }
    return this.enqueue(() => this.runJson(request, request.schema!))
  }

  /** Abandon queued work and release the engine. */
  async dispose(): Promise<void> {
    this.state = 'disposed'
    const queued = this.queue
    this.queue = []
    for (const task of queued) task.reject(new LocalModelError('disposed', 'local model runtime disposed'))
    this.emitStatus()
    try {
      await this.engine.dispose()
    } catch {
      /* best-effort release */
    }
  }

  /* ------------------------------ queue ------------------------------ */

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.state === 'disposed') {
      return Promise.reject(new LocalModelError('disposed', 'local model runtime disposed'))
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: () => run(), resolve: resolve as (v: unknown) => void, reject })
      this.emitStatus()
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0 && this.state !== 'disposed') {
      const task = this.queue.shift()!
      this.active++
      this.emitStatus()
      task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active--
          this.emitStatus()
          this.pump()
        })
    }
  }

  /* ----------------------------- inference ---------------------------- */

  private async ensureReady(): Promise<{ modelPath: string; spec: ModelSpec }> {
    if (!this.loadOptions) {
      throw new LocalModelError('model_not_loaded', 'local model runtime: call load() before infer()')
    }
    if (this.state === 'loading' && this.loadingPromise) {
      await this.loadingPromise
    } else if (this.state !== 'ready') {
      await this.load(this.loadOptions)
    }
    return this.loadOptions
  }

  private async runInfer(request: LocalModelInferRequest): Promise<string> {
    const { spec } = await this.ensureReady()
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
    return this.withTimeout((signal) =>
      this.engine.infer(
        {
          messages: request.messages,
          temperature: request.temperature ?? spec.temperature,
          maxTokens: request.maxTokens ?? spec.maxTokens,
          schema: request.schema
        },
        signal
      ),
      timeoutMs
    )
  }

  private async runJson(request: LocalModelInferRequest, schema: JsonSchemaObject): Promise<unknown> {
    const attempts: string[] = []
    for (let i = 0; i <= this.jsonRetryLimit; i++) {
      const messages = i === 0 ? request.messages : this.repairMessages(request.messages, attempts[attempts.length - 1])
      try {
        const text = await this.runInfer({ ...request, messages })
        const parsed = extractJsonObject(text)
        if (parsed === undefined) {
          attempts.push('reply contained no JSON object')
          continue
        }
        const err = validateJsonSchema(parsed, schema)
        if (err === null) return parsed
        attempts.push(err)
      } catch (e) {
        // Timeout means the engine is wedged; retrying cannot help.
        if (e instanceof LocalModelError && e.code === 'timeout') throw e
        attempts.push(e instanceof Error ? e.message : String(e))
      }
    }
    throw new LocalModelError('invalid_json', 'local model failed to produce schema-valid JSON', { attempts })
  }

  private repairMessages(base: ChatMessage[], lastError: string): ChatMessage[] {
    return [
      ...base,
      { role: 'user' as const, content: `Your previous reply was rejected (${lastError}). Reply again with a single JSON object matching the requested schema. No prose, no markdown.` }
    ]
  }

  /**
   * Run `fn` under an execution deadline: on expiry the signal is aborted and
   * the promise rejects with LocalModelError('timeout'); the slot frees
   * immediately even if the engine keeps grinding (the worker glue recycles
   * a wedged worker).
   */
  private withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ctrl = new AbortController()
      const timer = this.schedule(() => {
        ctrl.abort()
        reject(new LocalModelError('timeout', `local model inference timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      fn(ctrl.signal).then(
        (value) => {
          timer.cancel()
          resolve(value)
        },
        (e: unknown) => {
          timer.cancel()
          reject(e)
        }
      )
    })
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.status())
  }
}

/* ------------------------------------------------------------------ */
/* Tolerant JSON extraction                                            */
/* ------------------------------------------------------------------ */

/**
 * Extract a single JSON object from model output. The fast path parses the
 * trimmed text directly; otherwise a brace-balanced scan finds the first
 * top-level `{...}` (skipping braces inside strings) — this survives the
 * model wrapping JSON in prose or a leaked `<think>` block.
 * Returns undefined when no valid object is found.
 */
export function extractJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      /* fall through to the scan */
    }
  }
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}
