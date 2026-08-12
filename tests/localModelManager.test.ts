import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalModelError, LocalModelManager, type ModelSpec } from '../electron/store/localModelManager'

/**
 * Downloader tests (t53) — everything runs against a fake fetch + a tiny
 * fake spec; only the SHA-256 hasher is real (node:crypto) so the checksum
 * gate is exercised end to end. No real model is ever downloaded.
 */

const CONTENT = Buffer.from('abc123'.repeat(50)) // exactly 300 bytes
const CHUNK_1 = CONTENT.subarray(0, 100)
const CHUNK_2 = CONTENT.subarray(100, 200)
const CHUNK_3 = CONTENT.subarray(200, 300)
const CONTENT_SHA = createHash('sha256').update(CONTENT).digest('hex')

const SPEC: ModelSpec = {
  id: 'fake-qwen',
  name: 'Fake Qwen',
  fileName: 'fake-qwen.gguf',
  url: 'https://model.example.test/fake-qwen.gguf',
  sizeBytes: CONTENT.length,
  sha256: CONTENT_SHA,
  contextSize: 512,
  maxTokens: 16,
  temperature: 0.2
}

function streamResponse(chunks: Uint8Array[], status = 200, headers: Record<string, string> = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      }
    }),
    { status, headers }
  )
}

/** A body that delivers `first` bytes and then fails on the next read (network drop). */
function failingStream(first: Uint8Array): Response {
  let pulls = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first)
      },
      pull(controller) {
        pulls++
        if (pulls > 1) controller.error(new Error('network dropped'))
      }
    }),
    { status: 200 }
  )
}

const tempDirs: string[] = []

function newManagerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trace-model-'))
  tempDirs.push(dir)
  return dir
}

function manager(fetchImpl: typeof fetch, baseDir?: string, spec: ModelSpec = SPEC): LocalModelManager {
  return new LocalModelManager({ baseDir: baseDir ?? newManagerDir(), spec, fetchImpl })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('local model manager: auto download', () => {
  it('downloads with progress callbacks and lands a verified file', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([CHUNK_1, CHUNK_2, CHUNK_3]))
    const m = manager(fetchImpl as unknown as typeof fetch)
    const progress: number[] = []
    await m.startDownload((p) => progress.push(p.percent))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(progress).toEqual([1 / 3, 2 / 3, 1])
    expect(readFileSync(m.modelFilePath())).toEqual(CONTENT)
    expect(existsSync(`${m.modelFilePath()}.part`)).toBe(false)
    expect(m.status()).toMatchObject({ state: 'ready', source: null, error: null, modelFilePath: m.modelFilePath() })
    expect(m.status().progress?.percent).toBe(1)
    expect(m.specOf()).toBe(SPEC)
  })

  it('rejects a checksum mismatch and deletes the partial', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([CONTENT]))
    const m = manager(fetchImpl as unknown as typeof fetch, undefined, { ...SPEC, sha256: '0'.repeat(64) })

    await expect(m.startDownload()).rejects.toBeInstanceOf(LocalModelError)
    await expect(m.startDownload()).rejects.toMatchObject({ code: 'checksum_mismatch' })
    expect(existsSync(m.modelFilePath())).toBe(false)
    expect(existsSync(`${m.modelFilePath()}.part`)).toBe(false)
    expect(m.status().state).toBe('error')
    expect(m.status().error).toContain(CONTENT_SHA)
  })

  it('keeps the partial on network failure and resumes via Range on the next attempt', async () => {
    const half = CONTENT.subarray(0, 100)
    const rest = CONTENT.subarray(100)
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++
      if (calls === 1) return failingStream(half)
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers['Range']).toBe('bytes=100-')
      return streamResponse([rest], 206, { 'content-range': `bytes 100-${CONTENT.length - 1}/${CONTENT.length}` })
    })
    const m = manager(fetchImpl as unknown as typeof fetch)

    await expect(m.startDownload()).rejects.toMatchObject({ code: 'download_failed' })
    expect(existsSync(`${m.modelFilePath()}.part`)).toBe(true)
    expect(readFileSync(`${m.modelFilePath()}.part`).length).toBe(100)

    const progress: number[] = []
    await m.startDownload((p) => progress.push(p.percent))
    expect(readFileSync(m.modelFilePath())).toEqual(CONTENT)
    // The whole remaining body arrives in one chunk; cumulative progress is
    // resumeBytes + written (the Range assertion above proves the resume).
    expect(progress).toEqual([1])
    expect(m.status().progress?.receivedBytes).toBe(CONTENT.length)
    expect(m.status().state).toBe('ready')
  })

  it('removeModel during a download aborts it, cleans up, and does not throw', async () => {
    let calls = 0
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls++
      if (calls === 1) {
        // First attempt: deliver one chunk, then stall forever; honor the
        // caller's abort signal so a mid-read removal wakes the pump.
        init?.signal?.addEventListener('abort', () => streamController?.error(new Error('aborted')))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              streamController = c
              c.enqueue(CHUNK_1)
            },
            pull() {
              /* stall: never enqueue again */
            }
          })
        )
      }
      return streamResponse([CHUNK_1, CHUNK_2, CHUNK_3])
    }) as unknown as typeof fetch
    const m = manager(fetchImpl)

    const dl = m.startDownload()
    await new Promise((r) => setTimeout(r, 5)) // let the first chunk land
    await m.removeModel() // must not throw even though the .part stream is open
    await expect(dl).rejects.toMatchObject({ code: 'aborted' })
    expect(existsSync(`${m.modelFilePath()}.part`)).toBe(false)
    expect(existsSync(m.modelFilePath())).toBe(false)
    expect(m.status()).toMatchObject({ state: 'none', progress: null })

    // A fresh download after removal works normally.
    await m.startDownload()
    expect(readFileSync(m.modelFilePath())).toEqual(CONTENT)
    expect(m.status().state).toBe('ready')
  })

  it('re-verifies an existing file and re-downloads a corrupt one', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([CONTENT]))
    const m = manager(fetchImpl as unknown as typeof fetch)
    writeFileSync(m.modelFilePath(), Buffer.from('garbage, not the model'))

    await m.startDownload()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(readFileSync(m.modelFilePath())).toEqual(CONTENT)
    expect(m.status().state).toBe('ready')
  })

  it('treats an already-verified file as ready without downloading', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch must not be called')
    })
    const m = manager(fetchImpl as unknown as typeof fetch)
    writeFileSync(m.modelFilePath(), CONTENT)

    await m.startDownload()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(m.status().state).toBe('ready')
  })

  it('is idempotent while a download is in flight', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([CHUNK_1, CHUNK_2, CHUNK_3]))
    const m = manager(fetchImpl as unknown as typeof fetch)
    const p1 = m.startDownload()
    const p2 = m.startDownload()
    expect(p1).toBe(p2)
    await p1
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses auto download while a manual path is selected', async () => {
    const m = manager(vi.fn() as unknown as typeof fetch)
    m.selectSource('manual')
    m.setManualPath(m.modelFilePath())
    await expect(m.startDownload()).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('removeModel deletes the file and resets to none', async () => {
    const m = manager(vi.fn(async () => streamResponse([CONTENT])) as unknown as typeof fetch)
    m.selectSource('auto')
    await m.startDownload()
    await m.removeModel()
    expect(existsSync(m.modelFilePath())).toBe(false)
    expect(m.status()).toMatchObject({ state: 'none', modelFilePath: null, progress: null })
  })
})

describe('local model manager: manual path', () => {
  it('accepts an existing file and refuses a missing one', () => {
    const m = manager(vi.fn() as unknown as typeof fetch)
    const real = join(newManagerDir(), 'user.gguf')
    writeFileSync(real, CONTENT)

    m.selectSource('manual')
    m.setManualPath(real)
    expect(m.status()).toMatchObject({ state: 'ready', source: 'manual', modelFilePath: real })

    m.setManualPath(join(newManagerDir(), 'missing.gguf'))
    expect(m.status().state).toBe('error')
    expect(m.status().error).toContain('not found')
    expect(m.status().modelFilePath).toBeNull()
  })

  it('switching back to auto uses the downloaded file when present', async () => {
    const m = manager(vi.fn(async () => streamResponse([CONTENT])) as unknown as typeof fetch)
    await m.startDownload()
    const manual = join(newManagerDir(), 'manual.gguf')
    writeFileSync(manual, CONTENT)

    m.selectSource('manual')
    m.setManualPath(manual)
    expect(m.status().modelFilePath).toBe(manual)

    m.selectSource('auto')
    expect(m.status()).toMatchObject({ state: 'ready', source: 'auto', modelFilePath: m.modelFilePath() })
  })
})
