/**
 * Content-file naming/bytes helpers (ticket #9 / T7).
 *
 * Pins the staged-file rules for non-file drag-in content: MIME -> extension
 * mapping (with the `bin` fallback), batch-safe file names, and the BOM-prefixed
 * UTF-8 text bytes that match the drag.ts drag-out convention.
 */
import { describe, expect, it } from 'vitest'
import { contentFileName, extensionForMime, textContentBytes } from '../electron/store/contentFile'

describe('extensionForMime', () => {
  it('maps known image MIMEs to extensions', () => {
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/gif')).toBe('gif')
    expect(extensionForMime('image/webp')).toBe('webp')
    expect(extensionForMime('image/bmp')).toBe('bmp')
    expect(extensionForMime('image/svg+xml')).toBe('svg')
    expect(extensionForMime('image/avif')).toBe('avif')
    expect(extensionForMime('image/x-icon')).toBe('ico')
  })

  it('is case-insensitive', () => {
    expect(extensionForMime('IMAGE/PNG')).toBe('png')
    expect(extensionForMime('Image/WebP')).toBe('webp')
  })

  it('falls back to bin for unknown MIMEs', () => {
    expect(extensionForMime('application/octet-stream')).toBe('bin')
    expect(extensionForMime('')).toBe('bin')
    expect(extensionForMime('text/plain')).toBe('bin')
  })
})

describe('contentFileName', () => {
  // Local-time constructor: the stamp renders in local time by design.
  const now = new Date(2026, 7, 14, 12, 5, 0).getTime()

  it('names text files text-<stamp>.txt', () => {
    expect(contentFileName('text', '', now, 1)).toBe('text-20260814120500.txt')
  })

  it('names image files with the MIME extension', () => {
    expect(contentFileName('image', 'image/png', now, 1)).toBe('image-20260814120500.png')
    expect(contentFileName('image', 'image/jpeg', now, 1)).toBe('image-20260814120500.jpg')
  })

  it('appends an index suffix within a batch, omitted for the first file', () => {
    expect(contentFileName('image', 'image/png', now, 2)).toBe('image-20260814120500-2.png')
    expect(contentFileName('image', 'image/png', now, 3)).toBe('image-20260814120500-3.png')
  })

  it('uses the bin extension for unknown image MIMEs', () => {
    expect(contentFileName('image', 'application/x-weird', now, 1)).toBe('image-20260814120500.bin')
  })
})

describe('textContentBytes', () => {
  it('prefixes UTF-8 with the BOM so Notepad/Word detect the encoding', () => {
    const bytes = textContentBytes('hello')
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(bytes.subarray(3).toString('utf8')).toBe('hello')
  })

  it('handles non-ASCII text', () => {
    const bytes = textContentBytes('你好，世界中转站')
    expect(bytes.subarray(3).toString('utf8')).toBe('你好，世界中转站')
  })

  it('handles empty text', () => {
    expect(textContentBytes('').byteLength).toBe(3)
  })
})
