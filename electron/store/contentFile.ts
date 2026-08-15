/**
 * Content-file naming/bytes helpers (T7: non-file content drag-in).
 *
 * Pure functions, zero Electron imports — vitest drives them directly.
 * Content dropped as data (selected text, web-page images) has no original
 * path, so it is staged as a real file under the station content dir before
 * entering the station through the normal `station:enter` path (ADR-0008).
 * Naming mirrors the text drag-out convention in drag.ts (`text-<ts>.txt`,
 * UTF-8 BOM so Notepad/Word detect the encoding).
 */
import { Buffer } from 'node:buffer'

/** Known image MIME -> file extension (lowercase, no dot). */
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico'
}

/** Extension for an image MIME; unknown MIMEs fall back to `bin`. */
export function extensionForMime(mime: string): string {
  return IMAGE_EXT_BY_MIME[mime.toLowerCase()] ?? 'bin'
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * File name for staged content: `text-20260814120500.txt` /
 * `image-20260814120500.png`. The index disambiguates within one drop
 * batch (same timestamp); it starts at 1 and is omitted for the first file.
 * Local time — UTC stamps would read eight hours off on this machine.
 */
export function contentFileName(kind: 'text' | 'image', mime: string, now: number, index: number): string {
  const d = new Date(now)
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  const suffix = index > 1 ? `-${index}` : ''
  return kind === 'text'
    ? `text-${stamp}${suffix}.txt`
    : `image-${stamp}${suffix}.${extensionForMime(mime)}`
}

/** UTF-8 bytes with the BOM prefix (matches drag.ts text drag-out). */
export function textContentBytes(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
}
