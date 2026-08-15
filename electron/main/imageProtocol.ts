import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { nativeImage } from 'electron'
import { APP_CONFIG } from './config'

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  pjpeg: 'image/jpeg',
  pjp: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff'
}

/** Thumbnail edge length — matches the card UI, keeps renderer decode cheap. */
const THUMB_SIZE = 240

/** Bounded LRU of generated thumbnails, keyed by absolute file path. */
const THUMB_CACHE_MAX = 100
const thumbCache = new Map<string, { bytes: Buffer; contentType: string }>()

export interface StoredImage {
  filePath: string
  contentType: string
}

/** URL for a bounded thumbnail of a staged clipboard image. */
export function thumbnailUrlForStoredImage(imageId: string): string {
  return `${APP_CONFIG.imageProtocol}://thumb/${imageId}`
}

/** URL for a bounded thumbnail of an external image file. */
export function thumbnailUrlForFile(filePath: string): string {
  return `${APP_CONFIG.imageProtocol}://thumb/file/${encodeURIComponent(filePath.replace(/\\/g, '/'))}`
}

/**
 * Resolve an tracelocal image id to the staged file without allowing the id to
 * select paths or arbitrary file types. Clipboard captures are PNG, while
 * dropped/copied image files retain their original extension.
 */
export function resolveStoredImage(imagesDir: string, imageId: string): StoredImage | null {
  if (!/^[a-z0-9-]+$/i.test(imageId)) return null

  const baseDir = resolve(imagesDir)
  let entries: string[]
  try {
    entries = readdirSync(baseDir)
  } catch {
    return null
  }

  const fileName = entries.find((entry) => {
    const extension = extname(entry).slice(1).toLowerCase()
    return basename(entry, extname(entry)) === imageId && extension in IMAGE_MIME_TYPES
  })
  if (!fileName) return null

  const filePath = resolve(join(baseDir, fileName))
  if (dirname(filePath) !== baseDir) return null

  const extension = extname(fileName).slice(1).toLowerCase()
  return { filePath, contentType: IMAGE_MIME_TYPES[extension] }
}

/**
 * Produce a display-sized thumbnail for an image file: PNG via nativeImage
 * resize, or the raw bytes (SVG and formats nativeImage cannot decode) with
 * their real MIME type.
 */
export function resolveThumbnail(filePath: string): { bytes: Buffer; contentType: string } | null {
  const cached = thumbCache.get(filePath)
  if (cached) {
    thumbCache.delete(filePath)
    thumbCache.set(filePath, cached)
    return cached
  }

  let result: { bytes: Buffer; contentType: string } | null = null
  try {
    const img = nativeImage.createFromPath(filePath)
    if (!img.isEmpty()) {
      const size = img.getSize()
      const thumb = size.width > THUMB_SIZE || size.height > THUMB_SIZE
        ? img.resize({ width: THUMB_SIZE, quality: 'good' })
        : img
      result = { bytes: thumb.toPNG(), contentType: 'image/png' }
    } else {
      const buf = readFileSync(filePath)
      result = { bytes: buf, contentType: detectImageMime(buf) }
    }
  } catch {
    return null
  }

  if (thumbCache.size >= THUMB_CACHE_MAX) {
    thumbCache.delete(thumbCache.keys().next().value!)
  }
  thumbCache.set(filePath, result)
  return result
}

/** tracelocal://thumb/<imageId> — thumbnail of a staged clipboard image. */
export function thumbUrl(imageId: string): string {
  return `tracelocal://thumb/${imageId}`
}

/** tracelocal://thumb/<encodedPath> — thumbnail of an arbitrary image file. */
export function thumbUrlForPath(p: string): string {
  return `tracelocal://thumb/${encodeURIComponent(p)}`
}

/** Detect exact MIME type from image magic bytes. */
function detectImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp'
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon'
  if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) || (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A))) return 'image/tiff'
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'image/avif'
  const head = buf.subarray(0, 1024).toString('utf8').trim()
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg')) return 'image/svg+xml'
  return 'image/png'
}
