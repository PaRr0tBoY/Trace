/**
 * ItemStore regression tests (main-process store, electron mocked).
 *
 * Covers two release-review findings:
 *  - pruneExpired must remove the disk payload of expired large-text items
 *    (sibling contract of trim/delete/deleteBatch/clearUnpinned).
 *  - Dedup signature must be content-hash based, not preview based: after a
 *    restart, re-copying a large text dedupes (hitCount bump) instead of
 *    duplicating, a short text equal to another item's preview is its own
 *    item, and legacy items get their hash backfilled from the payload file.
 */
import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Both the electron mock and the test body need the SAME userData path, so it
 * is derived from a stable formula (no shared top-level const — the mock
 * factory runs while the module's top-level bindings are still in TDZ).
 */
const userData = (): string => join(tmpdir(), 'trace-itemstore-test', String(process.pid))

vi.mock('electron', () => {
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return {
    app: { getPath: () => join(tmpdir(), 'trace-itemstore-test', String(process.pid)) },
    safeStorage: { isEncryptionAvailable: () => false },
    nativeImage: {}
  }
})

import { ItemStore } from '../electron/store/ItemStore'
import { hashText } from '../electron/store/textHash'

const payloadsDir = (): string => join(userData(), 'payloads')
const indexFile = (): string => join(userData(), 'items.json')

function writeLegacyIndex(items: unknown[]): void {
  mkdirSync(payloadsDir(), { recursive: true })
  writeFileSync(indexFile(), JSON.stringify({ items }))
}

const LONG_TEXT = 'release-regression-' + 'x'.repeat(400)

describe('ItemStore disk payload + dedup signature', () => {
  beforeEach(() => {
    rmSync(userData(), { recursive: true, force: true })
    mkdirSync(payloadsDir(), { recursive: true })
  })

  afterAll(() => {
    rmSync(userData(), { recursive: true, force: true })
  })

  it('pruneExpired removes the disk payload of expired large-text items', () => {
    const payloadPath = join(payloadsDir(), 't1.txt')
    writeLegacyIndex([
      {
        id: 't1',
        data: { kind: 'text', text: 'preview', isUrl: false, hasFullPayload: true, previewText: 'preview' },
        capturedAt: Date.now() - 2 * 3600 * 1000,
        hitCount: 1,
        pinned: false
      }
    ])
    writeFileSync(payloadPath, LONG_TEXT)

    const store = new ItemStore()
    store.load()
    expect(existsSync(payloadPath)).toBe(true)

    expect(store.pruneExpired(1)).toBe(true)
    expect(existsSync(payloadPath)).toBe(false)
  })

  it('re-copying a large text after a restart dedupes (hitCount bump, no duplicate)', () => {
    const first = new ItemStore()
    first.add({ kind: 'text', text: LONG_TEXT, isUrl: false }, 50)
    first.persistSync()
    expect(first.list()).toHaveLength(1)

    const second = new ItemStore()
    second.load()
    second.add({ kind: 'text', text: LONG_TEXT, isUrl: false }, 50)

    const items = second.list()
    expect(items).toHaveLength(1)
    expect(items[0].hitCount).toBe(2)
  })

  it('a short text equal to another item\'s preview is captured as its own item after a restart', () => {
    const first = new ItemStore()
    first.add({ kind: 'text', text: LONG_TEXT, isUrl: false }, 50)
    first.persistSync()

    const second = new ItemStore()
    second.load()
    const short = LONG_TEXT.slice(0, 300)
    second.add({ kind: 'text', text: short, isUrl: false }, 50)

    const items = second.list()
    expect(items).toHaveLength(2)
    const newest = items[0].data
    expect(newest.kind === 'text' && newest.text).toBe(short)
  })

  it('legacy items without a hash get it backfilled from the payload and dedupe afterwards', () => {
    writeLegacyIndex([
      {
        id: 'legacy',
        data: { kind: 'text', text: LONG_TEXT.slice(0, 300), isUrl: false, hasFullPayload: true, previewText: LONG_TEXT.slice(0, 300) },
        capturedAt: Date.now() - 60_000,
        hitCount: 1,
        pinned: false
      }
    ])
    writeFileSync(join(payloadsDir(), 'legacy.txt'), LONG_TEXT)

    const store = new ItemStore()
    store.load()
    const loaded = store.list()[0].data
    expect(loaded.kind === 'text' && loaded.contentHash).toBe(hashText(LONG_TEXT))

    // The exact same full text re-captured must bump the legacy item, not clone it.
    store.add({ kind: 'text', text: LONG_TEXT, isUrl: false }, 50)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].hitCount).toBe(2)
  })
})
