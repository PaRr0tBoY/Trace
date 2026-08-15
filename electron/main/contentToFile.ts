/**
 * Stage non-file drag-in content (T7) as real files, then enter them into the
 * station through the regular path.
 *
 * Text/image data dropped onto the panel has no disk path, so it is written
 * under the station content dir (PATHS.stationContentDir) and handed to
 * addFiles() — the same entry point OS file drops use (route = 拖入). The
 * naming/bytes rules live in electron/store/contentFile.ts (pure, vitest).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { net } from 'electron'
import type { StationContentInput, StationEntryDto } from '../../shared/station'
import { contentFileName, textContentBytes } from '../store/contentFile'
import { PATHS } from '../store/paths'
import { addFiles, getStationStore } from './state'

/**
 * Oversized image payloads are rejected per-item: transferring tens of MB
 * through IPC stalls the main-process serializer and balloons heap usage.
 * 50 MB is well above any real web-image drag-in, far below the danger zone.
 */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

function stageFile(name: string, bytes: Buffer): string | null {
  try {
    const dir = PATHS.stationContentDir()
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, name)
    writeFileSync(dest, bytes)
    return dest
  } catch (err) {
    // Disk failure on one item must not abort the rest of the batch; the
    // skipped item simply does not enter the station.
    console.error('[Station] content stage failed:', err)
    return null
  }
}

/**
 * Download a remote web image into the station content dir. Runs in main
 * because net.fetch is CORS-free (the sandboxed preload's fetch is not).
 * Failures degrade to a skipped item, never abort the batch.
 */
async function stageImageUrl(url: string, now: number, index: number): Promise<string | null> {
  try {
    const res = await net.fetch(url, { redirect: 'follow' })
    if (!res.ok) return null
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_IMAGE_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
    return stageFile(contentFileName('image', mime, now, index), buf)
  } catch {
    return null
  }
}

/** Stage the content (if any valid parts) and enter the station. */
export async function enterContentToStation(input: StationContentInput): Promise<StationEntryDto[]> {
  const paths: string[] = []
  const now = Date.now()

  if (typeof input?.text === 'string' && input.text.length > 0) {
    const textPath = stageFile(contentFileName('text', '', now, 1), textContentBytes(input.text))
    if (textPath) paths.push(textPath)
  }

  const images = Array.isArray(input?.images) ? input.images : []
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    if (!img || !(img.data instanceof Uint8Array) || img.data.byteLength === 0) continue
    if (img.data.byteLength > MAX_IMAGE_BYTES) {
      console.error(`[Station] skipping oversized content image (${img.data.byteLength} bytes)`)
      continue
    }
    const name = contentFileName('image', img.mime ?? '', now, i + 1)
    const staged = stageFile(name, Buffer.from(img.data))
    if (staged) paths.push(staged)
  }

  if (typeof input?.imageUrl === 'string' && input.imageUrl.length > 0) {
    const staged = await stageImageUrl(input.imageUrl, now, images.length + 1)
    if (staged) paths.push(staged)
  }

  if (paths.length === 0) return getStationStore().toDto()
  addFiles(paths)
  return getStationStore().toDto()
}
