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

/** Stage the content (if any valid parts) and enter the station. */
export function enterContentToStation(input: StationContentInput): StationEntryDto[] {
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

  if (paths.length === 0) return getStationStore().toDto()
  addFiles(paths)
  return getStationStore().toDto()
}
