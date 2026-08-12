/**
 * Local model manager (t53, spec 实现决策 11) — registry / download / checksum /
 * path / availability / lifecycle.
 *
 * Pure logic: no Electron imports (hard constraint). The model file lives
 * under the userData `models` dir (glue passes PATHS.modelsDir()); nothing is
 * bundled into the repo or installer. The downloader and the SHA-256 hasher
 * are injectable so vitest can exercise progress / resume / checksum-reject
 * without ever touching a real 640MB model.
 *
 * Integrity contract: a *downloaded* file must match the spec's SHA-256 —
 * `startDownload()` re-verifies an existing file and re-downloads corrupt
 * ones, and `verifyDownloaded()` is the load gate (a mismatching file is
 * refused). A *manual* .gguf path is the user's own file and is trusted after
 * an existence check (no checksum requirement).
 *
 * State machine (status().state): none -> downloading -> ready | error.
 * A failed download keeps the `.part` file so the next attempt resumes from
 * the last byte (Range request); a checksum mismatch deletes the partial and
 * starts over.
 */
import { createHash, type Hash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  type WriteStream
} from 'node:fs'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { DownloadProgress, LocalModelSource, LocalModelState, LocalModelStatus } from '../../shared/types'

/* ------------------------------------------------------------------ */
/* Error                                                               */
/* ------------------------------------------------------------------ */

export type LocalModelErrorCode =
  | 'checksum_mismatch'
  | 'download_failed'
  | 'invalid_state'
  | 'manual_path_invalid'
  | 'model_missing'
  | 'engine_load_failed'
  | 'engine_infer_failed'
  | 'timeout'
  | 'invalid_json'
  | 'invalid_request'
  | 'model_not_loaded'
  | 'disposed'
  | 'aborted'

/** Typed error shared by the manager and the runtime. */
export class LocalModelError extends Error {
  readonly code: LocalModelErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: LocalModelErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'LocalModelError'
    this.code = code
    this.details = details
  }
}

/* ------------------------------------------------------------------ */
/* Model spec                                                          */
/* ------------------------------------------------------------------ */

/**
 * Pure readiness gate for loading the runtime (t54): a load is worth
 * attempting only when the enhancement is enabled and the manager reports a
 * model file on disk (state 'ready' implies `modelFilePath` resolves).
 * Returns false in every other case, so the lazy optimizer degrades to the
 * pure algorithm path — enabling the toggle without a model file can never
 * error the suggestion pipeline (不变量 H).
 */
export function shouldLoadLocalModel(enabled: boolean, status: LocalModelStatus): boolean {
  return enabled && status.state === 'ready' && status.modelFilePath !== null
}

export interface ModelSpec {
  id: string
  name: string
  /** File name inside the models dir. */
  fileName: string
  /** HTTPS download URL (official HF repo, download=true). */
  url: string
  /** Expected byte size of the final file. */
  sizeBytes: number
  /** Expected SHA-256 of the final file; downloads failing this are rejected. */
  sha256: string
  /** Short context window (tokens) — edge assistant, not a RAG engine. */
  contextSize: number
  /** Low output budget: short structured answers only. */
  maxTokens: number
  /** Low temperature: deterministic structured output. */
  temperature: number
}

/**
 * Qwen3-0.6B GGUF Q8_0 from the official Qwen repository (spec 实现决策 11:
 * /no_think explicit off, short context, low max_tokens, strict JSON, low
 * temperature). Size and SHA-256 captured from the HF resolve endpoint
 * (x-linked-etag) and cross-checked against the ModelScope mirror API
 * (2026-08-13).
 */
export const LOCAL_MODEL_SPEC: ModelSpec = {
  id: 'qwen3-0.6b-q8_0',
  name: 'Qwen3-0.6B (Q8_0)',
  fileName: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf?download=true',
  sizeBytes: 639_446_688,
  sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
  contextSize: 2048,
  maxTokens: 128,
  temperature: 0.2
}

/* ------------------------------------------------------------------ */
/* Injectable hasher                                                  */
/* ------------------------------------------------------------------ */

/** Incremental stream hasher (default: node:crypto SHA-256). */
export interface StreamHasher {
  update(chunk: Uint8Array): void
  digest(): string
}

export type HasherFactory = () => StreamHasher

const sha256Factory: HasherFactory = () => {
  const hash: Hash = createHash('sha256')
  return {
    update: (chunk) => hash.update(chunk),
    digest: () => hash.digest('hex')
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

export interface LocalModelManagerOptions {
  /** Directory holding the model file and its `.part` resume file. */
  baseDir: string
  /** Injectable model spec (tests use a tiny fake spec). */
  spec?: ModelSpec
  /** Injectable HTTP client (defaults to global fetch). */
  fetchImpl?: typeof fetch
  /** Injectable SHA-256 stream hasher (defaults to node:crypto). */
  hasherFactory?: HasherFactory
}

export class LocalModelManager {
  private readonly baseDir: string
  private readonly spec: ModelSpec
  private readonly fetchImpl: typeof fetch
  private readonly hasherFactory: HasherFactory

  private source: LocalModelSource | null = null
  private manualPath: string | null = null
  private state: LocalModelState = 'none'
  private progress: DownloadProgress | null = null
  private error: string | null = null
  private downloadPromise: Promise<void> | null = null
  /** Set by removeModel(): the pump observes it and stops writing promptly. */
  private downloadAbort = false
  private downloadController: AbortController | null = null

  constructor(options: LocalModelManagerOptions) {
    this.baseDir = options.baseDir
    this.spec = options.spec ?? LOCAL_MODEL_SPEC
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.hasherFactory = options.hasherFactory ?? sha256Factory
  }

  specOf(): ModelSpec {
    return this.spec
  }

  /** Path the auto-downloaded file lands at. */
  modelFilePath(): string {
    return join(this.baseDir, this.spec.fileName)
  }

  status(): LocalModelStatus {
    return {
      state: this.state,
      source: this.source,
      progress: this.progress,
      error: this.error,
      modelFilePath: this.resolveModelFilePath()
    }
  }

  /** Switch between auto-download and a user-picked .gguf file. */
  selectSource(source: LocalModelSource): void {
    this.source = source
    if (source === 'auto') {
      this.error = null
      this.state = existsSync(this.modelFilePath()) ? 'ready' : 'none'
    } else {
      this.refreshManualState()
    }
  }

  /**
   * Record the user-picked .gguf path. Validates existence; a missing file
   * puts the manager into 'error' (when manual is the active source) without
   * touching the auto-downloaded file.
   */
  setManualPath(path: string | null): void {
    this.manualPath = path
    if (this.source === 'manual') this.refreshManualState()
  }

  private refreshManualState(): void {
    if (!this.manualPath) {
      this.state = 'error'
      this.error = 'no manual model path set'
      return
    }
    if (existsSync(this.manualPath) && statSync(this.manualPath).isFile()) {
      this.state = 'ready'
      this.error = null
    } else {
      this.state = 'error'
      this.error = `manual model file not found: ${this.manualPath}`
    }
  }

  /**
   * Download (or resume) the model file with progress callbacks. Idempotent:
   * a call while a download is running returns the in-flight promise. An
   * existing file is re-verified first — corrupt files are replaced, not
   * loaded. Throws LocalModelError on network failure (`.part` kept for the
   * next resume) or checksum mismatch (`.part` deleted).
   */
  startDownload(onProgress?: (progress: DownloadProgress) => void): Promise<void> {
    if (this.downloadPromise) return this.downloadPromise
    if (this.source === 'manual') {
      return Promise.reject(new LocalModelError('invalid_state', 'auto download is disabled while a manual model path is selected'))
    }
    // The stored promise is the finally-wrapped chain: it stays the stable
    // re-entrancy handle and clears itself on settle (finally passes the
    // rejection through — callers own the rejection handling, nothing is
    // discarded unhandled).
    this.downloadPromise = this.downloadFresh(onProgress).finally(() => {
      this.downloadPromise = null
    })
    return this.downloadPromise
  }

  private async downloadFresh(onProgress?: (progress: DownloadProgress) => void): Promise<void> {
    // Re-verify an existing file: a corrupt download is refused and replaced.
    if (existsSync(this.modelFilePath())) {
      if (await this.verifyDownloaded()) {
        this.state = 'ready'
        this.error = null
        return
      }
      rmSync(this.modelFilePath(), { force: true })
    }

    this.state = 'downloading'
    this.error = null
    this.progress = { receivedBytes: 0, totalBytes: this.spec.sizeBytes, percent: 0 }
    const partPath = join(this.baseDir, `${this.spec.fileName}.part`)
    const resumeBytes = existsSync(partPath) ? statSync(partPath).size : 0
    // A fresh run clears any earlier removeModel() abort request.
    this.downloadAbort = false
    this.downloadController = new AbortController()
    try {
      mkdirSync(this.baseDir, { recursive: true })
      const headers: Record<string, string> = {}
      if (resumeBytes > 0) headers['Range'] = `bytes=${resumeBytes}-`
      const res = await this.fetchImpl(this.spec.url, { headers, signal: this.downloadController.signal })
      if (!res.ok) {
        throw new LocalModelError('download_failed', `HTTP ${res.status} ${res.statusText} downloading ${this.spec.fileName}`)
      }
      if (!res.body) {
        throw new LocalModelError('download_failed', 'empty response body from model host')
      }
      // 206 = the server honored our Range header (resume); 200 = it ignored
      // it, so the partial is truncated and the download restarts.
      const append = res.status === 206 && resumeBytes > 0
      const hasher = this.hasherFactory()
      const { digest } = await this.pump(res.body, partPath, { append, base: append ? resumeBytes : 0 }, hasher, onProgress)
      if (digest !== this.spec.sha256) {
        rmSync(partPath, { force: true })
        this.state = 'error'
        const message = `checksum mismatch for ${this.spec.fileName}: expected ${this.spec.sha256}, got ${digest}`
        this.error = message
        throw new LocalModelError('checksum_mismatch', message, { expected: this.spec.sha256, actual: digest })
      }
      renameSync(partPath, this.modelFilePath())
      this.state = 'ready'
      this.progress = { receivedBytes: this.spec.sizeBytes, totalBytes: this.spec.sizeBytes, percent: 1 }
    } catch (e) {
      if (this.downloadAbort) {
        // removeModel() asked us to stop: the partial is deleted by the caller.
        throw new LocalModelError('aborted', 'model download aborted by removeModel')
      }
      if (!(e instanceof LocalModelError)) {
        // Network/stream failure: keep the partial for the next resume.
        this.state = 'error'
        this.error = String(e instanceof Error ? e.message : e)
        throw new LocalModelError('download_failed', `download of ${this.spec.fileName} failed: ${this.error}`, { cause: this.error })
      }
      throw e
    }
  }

  /** Stream `body` into `partPath`, feeding the hasher and progress callbacks. */
  private async pump(
    body: ReadableStream<Uint8Array>,
    partPath: string,
    start: { append: boolean; base: number },
    hasher: StreamHasher,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<{ digest: string; received: number }> {
    const stream: WriteStream = createWriteStream(partPath, { flags: start.append ? 'a' : 'w' })
    // createWriteStream opens the fd asynchronously; a fast-failing body would
    // destroy the stream before the file exists, losing the resume partial.
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    })
    let written = 0
    try {
      // On resume the partial already on disk is part of the final file: feed
      // it through the hasher so the digest covers the whole file, not just
      // the tail streamed in this attempt.
      if (start.append) {
        const rs = createReadStream(partPath)
        for await (const chunk of rs) hasher.update(chunk as Buffer)
      }
      const reader = body.getReader()
      for (;;) {
        if (this.downloadAbort) {
          // removeModel() mid-download: stop writing immediately; the caller
          // deletes the partial. Cancel the reader so the connection closes.
          await reader.cancel().catch(() => {})
          stream.destroy()
          throw new LocalModelError('aborted', 'model download aborted by removeModel')
        }
        const { done, value } = await reader.read()
        if (done) break
        hasher.update(value)
        await new Promise<void>((resolve, reject) => {
          stream.write(value, (err) => (err ? reject(err) : resolve()))
        })
        written += value.byteLength
        const received = start.base + written
        const totalBytes = this.spec.sizeBytes
        const progress: DownloadProgress = {
          receivedBytes: received,
          totalBytes,
          percent: totalBytes > 0 ? Math.min(1, received / totalBytes) : 1
        }
        this.progress = progress
        onProgress?.(progress)
      }
      reader.releaseLock()
      stream.end()
      await finished(stream)
      return { digest: hasher.digest(), received: start.base + written }
    } catch (e) {
      stream.destroy()
      throw e
    }
  }

  /**
   * SHA-256 gate: does the downloaded file match the spec checksum? This is
   * the load gate — a mismatching file must not be loaded (spec 实现决策 11).
   * Manual paths are exempt (user's own file, existence already checked).
   */
  async verifyDownloaded(): Promise<boolean> {
    const file = this.modelFilePath()
    if (!existsSync(file)) return false
    const hasher = this.hasherFactory()
    try {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(file)
        rs.on('data', (chunk: string | Buffer) => hasher.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
        rs.on('error', reject)
        rs.on('end', () => resolve())
      })
    } catch {
      return false
    }
    return hasher.digest() === this.spec.sha256
  }

  /**
   * Delete the auto-downloaded file (and any partial); manual paths are
   * untouched. Safe mid-download: an in-flight download is aborted and the
   * stream closed first, so Windows never sees a delete on an open file.
   */
  async removeModel(): Promise<void> {
    this.downloadAbort = true
    this.downloadController?.abort()
    if (this.downloadPromise) {
      // Wait for the aborted download to settle (its write stream closes
      // before the promise resolves/rejects).
      await this.downloadPromise.catch(() => {})
    }
    rmSync(this.modelFilePath(), { force: true })
    rmSync(join(this.baseDir, `${this.spec.fileName}.part`), { force: true })
    this.progress = null
    if (this.source === 'manual') {
      this.refreshManualState()
    } else {
      this.state = 'none'
      this.error = null
    }
  }

  private resolveModelFilePath(): string | null {
    if (this.source === 'manual') {
      return this.manualPath && existsSync(this.manualPath) ? this.manualPath : null
    }
    return existsSync(this.modelFilePath()) ? this.modelFilePath() : null
  }
}
