/**
 * In-memory + on-disk store for clipboard history.
 *
 * Responsibilities:
 *   - Keep an ordered list (most recent first) of ClipboardItem.
 *   - Deduplicate by content signature so re-copies bump `hitCount` instead of
 *     adding a clone.
 *   - Enforce a size cap, evicting the oldest *unpinned* items.
 *   - Persist the index to JSON and image bytes to per-item PNG files.
 *   - Convert internal items to the serializable DTO form for the renderer.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import {
  type ClipboardItem,
  type ClipboardItemDto,
  type DragRequest,
  type ItemData,
  type SourceApp
} from '../../shared/types'
import { PATHS } from './paths'
import { createId } from './ids'
import { thumbUrl } from '../main/imageProtocol'

/** Stable, content-based key used for deduplication. */
function signature(data: ItemData): string {
  switch (data.kind) {
    case 'text':
      return `text|${data.text}`
    case 'image':
      return `image|${data.imageId}`
    case 'image-collection':
      return `image-collection|${data.images.map((i) => i.imageId).join(',')}`
    case 'files':
      // Legacy-transient only: a files item exists in the stack between
      // load() and the startup migration into the transfer station (T2);
      // it is never deduped or added post-init.
      return `files|${data.paths.join('\n')}`
  }
}

/** Maps a signature -> item id so dedup is O(1). */
interface Index {
  items: ClipboardItem[]
}

export class ItemStore {
  private items: ClipboardItem[] = []
  private sigToId = new Map<string, string>()
  /** Load persisted state from disk. Called once at startup. */
  load(): void {
    try {
      const file = PATHS.indexFile()
      if (!existsSync(file)) {
        this.items = []
        this.rebuildIndex()
        return
      }

      const rawBuffer = readFileSync(file)
      const rawStr = rawBuffer.toString('utf8').trim()
      let parsedIndex: Index | null = null
      let needsMigration = false

      let parsedJson: any = null
      try {
        parsedJson = JSON.parse(rawStr)
      } catch {
        /* Raw non-JSON payload */
      }

      if (parsedJson && parsedJson.encrypted === true && typeof parsedJson.payload === 'string') {
        // Encrypted DPAPI Envelope
        if (safeStorage.isEncryptionAvailable()) {
          try {
            const decryptedStr = safeStorage.decryptString(Buffer.from(parsedJson.payload, 'base64'))
            parsedIndex = JSON.parse(decryptedStr) as Index
          } catch (err) {
            console.error('[ItemStore] DPAPI decryption failed:', err)
          }
        } else {
          console.warn('[ItemStore] safeStorage unavailable to decrypt items.json')
        }
      } else if (parsedJson && Array.isArray(parsedJson.items)) {
        // Plain JSON (Legacy v0.1.1 format from active users)
        parsedIndex = parsedJson as Index
        needsMigration = true
      }

      if (parsedIndex && Array.isArray(parsedIndex.items)) {
        this.items = parsedIndex.items.filter((it) => it && it.data && typeof it.id === 'string')

        // Auto-migrate large text items to disk payload files
        let migratedAnyPayloads = false
        for (const it of this.items) {
          if (it.data.kind === 'text') {
            if (!it.data.hasFullPayload && it.data.text.length > 300) {
              this.writeTextPayload(it.id, it.data.text)
              it.data.hasFullPayload = true
              it.data.previewText = it.data.text.slice(0, 300)
              it.data.text = it.data.previewText
              migratedAnyPayloads = true
            }
          }
        }

        this.rebuildIndex()

        // Auto-migrate legacy plain JSON: create backup & upgrade to DPAPI encryption
        if (needsMigration || migratedAnyPayloads) {
          console.log('[ItemStore] Migrating items.json to DPAPI safeStorage encryption and disk payloads...')
          try {
            const backupFile = `${file}.v1.bak`
            if (!existsSync(backupFile)) {
              writeFileSync(backupFile, rawBuffer)
            }
            this.persist()
          } catch (err) {
            console.error('[ItemStore] Auto-migration backup/persist failed:', err)
          }
        }
      } else {
        console.warn('[ItemStore] Index file could not be parsed; preserving data without wiping')
        const backupFile = `${file}.corrupted.${Date.now()}`
        try { writeFileSync(backupFile, rawBuffer) } catch { /* ignore */ }
      }
    } catch (err) {
      console.error('[ItemStore] Failed to load index file:', err)
      this.items = []
      this.sigToId.clear()
    }
  }

  private rebuildIndex(): void {
    this.sigToId.clear()
    for (const it of this.items) this.sigToId.set(signature(it.data), it.id)
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null

  /** Persist the current index to disk. Debounced to prevent main thread blocking during UI transitions. */
  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistSync()
    }, 150)
  }

  /** Synchronous disk write (called by debounced timer or on app shutdown). */
  public persistSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      const indexObj: Index = { items: this.items }
      const jsonStr = JSON.stringify(indexObj)
      const file = PATHS.indexFile()

      if (safeStorage.isEncryptionAvailable()) {
        const encryptedBuf = safeStorage.encryptString(jsonStr)
        const envelope = {
          v: 2,
          encrypted: true,
          payload: encryptedBuf.toString('base64')
        }
        writeFileSync(file, JSON.stringify(envelope, null, 2), 'utf8')
      } else {
        writeFileSync(file, JSON.stringify(indexObj, null, 2), 'utf8')
      }
    } catch (err) {
      console.error('[ItemStore] Persistence failed:', err)
    }
  }

  /**
   * Enforce the size cap by evicting oldest *unpinned* items. Walks from the
   * tail (oldest) forward, skipping anything pinned so favorites survive.
   */
  private trim(limit: number): void {
    if (this.items.length <= limit) return
    const need = this.items.length - limit
    const survivors: ClipboardItem[] = []
    let stillNeed = need
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (stillNeed > 0 && !it.pinned) {
        this.sigToId.delete(signature(it.data))
        if (it.data.kind === 'image') this.removeImageFile(it.data.imageId)
        if (it.data.kind === 'image-collection') {
          it.data.images.forEach((img) => this.removeImageFile(img.imageId))
        }
        if (it.data.kind === 'text') this.removeTextPayload(it.id)
        stillNeed--
      } else {
        survivors.unshift(it)
      }
    }
    this.items = survivors
  }

  /**
   * Add or refresh a piece of content.
   * Returns true if the list actually changed (so callers can decide to push).
   * `sourceApp` is the foreground app at capture time (ADR-0001), gated by
   * the same privacy settings as t14 attribution — pass undefined when the
   * gate is off. A refreshed item keeps its existing attribution unless a new
   * one is provided (re-copies refresh it, matching capturedAt).
   */
  add(data: ItemData, limit: number, sourceApp?: SourceApp): boolean {
    if (data.kind === 'text' && data.text.length > 500000) {
      data = { ...data, text: data.text.slice(0, 500000) }
    }
    const sig = signature(data)
    const existingId = this.sigToId.get(sig)
    const now = Date.now()

    if (existingId) {
      const idx = this.items.findIndex((it) => it.id === existingId)
      if (idx >= 0) {
        const it = this.items[idx]
        // Bump count and move to front.
        const updated: ClipboardItem = {
          ...it,
          hitCount: it.hitCount + 1,
          capturedAt: now,
          ...(sourceApp ? { sourceApp } : {})
        }
        this.items.splice(idx, 1)
        this.items.unshift(updated)
        this.persist()
        return true
      }
    }

    const id = createId()
    let finalData = data
    if (data.kind === 'text' && data.text.length > 300) {
      this.writeTextPayload(id, data.text)
      finalData = {
        ...data,
        hasFullPayload: true,
        previewText: data.text.slice(0, 300),
        text: data.text.slice(0, 300)
      }
    }

    const item: ClipboardItem = { id, data: finalData, capturedAt: now, hitCount: 1, pinned: false, ...(sourceApp ? { sourceApp } : {}) }
    this.items.unshift(item)
    this.sigToId.set(sig, id)
    if (data.kind === 'image') this.writeImageFile(data.imageId)
    this.trim(limit)
    this.persist()
    return true
  }

  /**
   * Touch an item (e.g. on paste) to update its timestamp and hitCount,
   * moving unpinned items to the front of the Recent list.
   */
  touch(id: string): boolean {
    const idx = this.items.findIndex((it) => it.id === id)
    if (idx < 0) return false
    const it = this.items[idx]
    const now = Date.now()
    const updated: ClipboardItem = { ...it, hitCount: it.hitCount + 1, capturedAt: now }

    if (!it.pinned) {
      this.items.splice(idx, 1)
      this.items.unshift(updated)
    } else {
      this.items[idx] = updated
    }

    this.persist()
    return true
  }

  setPinned(id: string, pinned: boolean): void {
    const it = this.items.find((x) => x.id === id)
    if (!it) return
    it.pinned = pinned
    this.persist()
  }

  delete(id: string): void {
    const idx = this.items.findIndex((x) => x.id === id)
    if (idx < 0) return
    const [removed] = this.items.splice(idx, 1)
    this.sigToId.delete(signature(removed.data))
    if (removed.data.kind === 'image') this.removeImageFile(removed.data.imageId)
    if (removed.data.kind === 'image-collection') {
      removed.data.images.forEach((img) => this.removeImageFile(img.imageId))
    }
    if (removed.data.kind === 'text') this.removeTextPayload(removed.id)
    this.persistSync()
  }

  deleteBatch(ids: string[]): void {
    if (!ids || ids.length === 0) return
    const set = new Set(ids)
    const toRemove: ClipboardItem[] = []
    this.items = this.items.filter((it) => {
      if (set.has(it.id)) {
        toRemove.push(it)
        return false
      }
      return true
    })

    for (const removed of toRemove) {
      this.sigToId.delete(signature(removed.data))
      if (removed.data.kind === 'image') this.removeImageFile(removed.data.imageId)
      if (removed.data.kind === 'image-collection') {
        removed.data.images.forEach((img) => this.removeImageFile(img.imageId))
      }
      if (removed.data.kind === 'text') this.removeTextPayload(removed.id)
    }
    this.persistSync()
  }

  public removeSubitem(req: DragRequest): boolean {
    const sourceItem = this.get(req.id)
    if (!sourceItem) return false
    const sourceIndex = this.items.findIndex(i => i.id === req.id)
    if (sourceIndex === -1) return false

    if (sourceItem.data.kind === 'image-collection' && req.imageId) {
      const imgIdx = sourceItem.data.images.findIndex(i => i.imageId === req.imageId)
      if (imgIdx === -1) return false
      
      sourceItem.data.images.splice(imgIdx, 1)
      
      if (sourceItem.data.images.length === 1) {
        sourceItem.data = { kind: 'image', ...sourceItem.data.images[0] }
      } else if (sourceItem.data.images.length === 0) {
        this.items.splice(sourceIndex, 1)
      }
      this.rebuildIndex()
      this.persist()
      return true
    }

    return false
  }

  clearUnpinned(): void {
    const kept: ClipboardItem[] = []
    for (const it of this.items) {
      if (it.pinned) kept.push(it)
      else {
        this.sigToId.delete(signature(it.data))
        if (it.data.kind === 'image') this.removeImageFile(it.data.imageId)
        if (it.data.kind === 'image-collection') {
          it.data.images.forEach((img) => this.removeImageFile(img.imageId))
        }
        if (it.data.kind === 'text') this.removeTextPayload(it.id)
      }
    }
    this.items = kept
    this.persistSync()
  }

  pruneExpired(hours: number): boolean {
    if (!hours || hours <= 0) return false
    const cutoff = Date.now() - hours * 3600 * 1000
    const kept: ClipboardItem[] = []
    let removedAny = false
    for (const it of this.items) {
      if (it.pinned || it.capturedAt >= cutoff) {
        kept.push(it)
      } else {
        removedAny = true
        this.sigToId.delete(signature(it.data))
        if (it.data.kind === 'image') this.removeImageFile(it.data.imageId)
        if (it.data.kind === 'image-collection') {
          it.data.images.forEach((img) => this.removeImageFile(img.imageId))
        }
      }
    }
    if (removedAny) {
      this.items = kept
      this.persistSync()
    }
    return removedAny
  }

  get(id: string): ClipboardItem | undefined {
    return this.items.find((x) => x.id === id)
  }

  list(): readonly ClipboardItem[] {
    return this.items
  }

  /* ----------------------------- image files ----------------------------- */

  /**

   * Stage an image's bytes from a clipboard capture. The image was already
   * written to userData/images by the clipboard watcher (which has the raw
   * bytes); here we just no-op because the file already exists.
   * Kept for symmetry / future use.
   */
  private writeImageFile(_imageId: string): void {
    /* no-op: bytes already on disk from capture */
  }

  public getImagePath(imageId: string, ext?: string): string {
    return this.imagePath(imageId, ext)
  }

  private imagePath(imageId: string, ext?: string): string {
    if (ext) {
      const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext
      return join(PATHS.imagesDir(), `${imageId}.${cleanExt}`)
    }
    const dir = PATHS.imagesDir()
    if (existsSync(dir)) {
      try {
        const files = readdirSync(dir)
        for (const f of files) {
          if (f.startsWith(`${imageId}.`)) {
            return join(dir, f)
          }
        }
      } catch { /* ignore */ }
    }
    return join(PATHS.imagesDir(), `${imageId}.png`)
  }

  private removeImageFile(imageId: string): void {
    const dir = PATHS.imagesDir()
    if (!existsSync(dir)) return
    try {
      const files = readdirSync(dir)
      for (const f of files) {
        if (f.startsWith(`${imageId}.`)) {
          rmSync(join(dir, f), { force: true })
        }
      }
    } catch {
      /* ignore */
    }
  }

  private textPayloadPath(id: string): string {
    return join(PATHS.payloadsDir(), `${id}.txt`)
  }

  private writeTextPayload(id: string, text: string): void {
    try {
      writeFileSync(this.textPayloadPath(id), text, 'utf8')
    } catch { /* ignore */ }
  }

  private removeTextPayload(id: string): void {
    try {
      const p = this.textPayloadPath(id)
      if (existsSync(p)) rmSync(p, { force: true })
    } catch { /* ignore */ }
  }

  public getFullText(id: string): string {
    const item = this.items.find((x) => x.id === id)
    if (!item || item.data.kind !== 'text') return ''
    if (item.data.hasFullPayload) {
      try {
        const p = this.textPayloadPath(id)
        if (existsSync(p)) {
          return readFileSync(p, 'utf8')
        }
      } catch { /* ignore */ }
    }
    return item.data.text
  }

  /* ------------------------------- DTO ----------------------------------- */

  /** Snapshot the whole list as renderer-safe DTOs (images inlined). */
  toDto(): ClipboardItemDto[] {
    return this.items.map((it) => {
      if (it.data.kind === 'image') {
        const { kind, imageId, width, height, bytes, ext } = it.data
        return {
          ...it,
          data: { kind, imageId, width, height, bytes, ext, preview: thumbUrl(imageId) }
        }
      }
      if (it.data.kind === 'image-collection') {
        const imagesWithPreviews = it.data.images.map((img) => ({
          ...img,
          preview: thumbUrl(img.imageId)
        }))
        return {
          ...it,
          data: { kind: 'image-collection', images: imagesWithPreviews }
        }
      }

      return { ...it, data: it.data }
    })
  }

  /** Persist a brand-new image captured from the clipboard to its PNG file. */
  stageImageBytes(imageId: string, png: Buffer, ext = 'png'): void {
    try {
      writeFileSync(this.imagePath(imageId, ext), png)
    } catch {
      /* ignore */
    }
  }
}

