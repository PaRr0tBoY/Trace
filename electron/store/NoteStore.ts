/**
 * NoteStore — in-memory + on-disk store for the notes domain.
 *
 * Responsibilities:
 *   - Keep an ordered note list: pinned first, then by creation time (newest
 *     first). Ordering is stable — editing a note never moves it.
 *   - Derive the display title from the first meaningful line of Markdown
 *     content (same rule NotchNotes uses), so the list stays cheap to render.
 *   - Debounce disk writes (180 ms, matching NotchNotes) and flush on quit.
 *
 * The store is pure; the main process wires the disk adapter (DPAPI envelope
 * like tasks.json) and pushes `state:notes` after every mutation.
 */
import { createId } from './ids'
import type { Note, NoteDto, NotePatch } from '../../shared/types'

export interface NoteIndex {
  version: number
  notes: Note[]
}

export interface NoteStoreDeps {
  load: () => NoteIndex | null
  save: (index: NoteIndex) => void
}

export const NOTE_STORAGE_VERSION = 1
/** Title truncation length, matching NotchNotes. */
const TITLE_MAX_LENGTH = 42
/** Debounce window for disk writes. */
const SAVE_DELAY_MS = 180

/** Markdown line prefixes stripped from the derived title. */
const MARKDOWN_PREFIXES = ['# ', '## ', '### ', '- [ ] ', '- [x] ', '- [X] ', '- ', '* ', '> ']

/** First non-empty line of the note, trimmed. */
function firstMeaningfulLine(text: string): string | null {
  let lineStart = 0
  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart)
    const line = text
      .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      .trim()
    if (line.length > 0) return line
    if (lineEnd === -1) break
    lineStart = lineEnd + 1
  }
  return null
}

/** Derive the display title from Markdown content ('' for blank notes). */
export function deriveTitle(content: string): string {
  const first = firstMeaningfulLine(content)
  if (first === null) return ''
  let title = first
  for (const prefix of MARKDOWN_PREFIXES) {
    if (title.startsWith(prefix)) {
      title = title.slice(prefix.length)
      break
    }
  }
  title = title.trim()
  return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…` : title
}

/** Validate one persisted note; structurally broken notes are dropped. */
function sanitizeNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  if (typeof n.id !== 'string' || n.id.length === 0) return null
  if (typeof n.content !== 'string') return null
  const createdAt =
    typeof n.createdAt === 'number' && Number.isFinite(n.createdAt) ? n.createdAt : Date.now()
  const updatedAt =
    typeof n.updatedAt === 'number' && Number.isFinite(n.updatedAt) ? n.updatedAt : createdAt
  const content = n.content
  return {
    id: n.id,
    // Re-derive so titles stay consistent even if an older version stored
    // a stale one.
    title: deriveTitle(content),
    content,
    createdAt,
    updatedAt,
    pinned: n.pinned === true,
    folded: n.folded === true
  }
}

/** Salvage a persisted index: drop broken notes, re-derive titles. */
function sanitizeIndex(index: NoteIndex | null): Note[] {
  const rawNotes = Array.isArray(index?.notes) ? index.notes : []
  const notes = rawNotes
    .map(sanitizeNote)
    .filter((n): n is Note => n !== null)
  notes.sort(compareNotes)
  return notes
}

/** Stable list order: pinned first, then newest created first. */
function compareNotes(a: Note, b: Note): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return b.createdAt - a.createdAt
}

export class NoteStore {
  private readonly deps: NoteStoreDeps
  private notes: Note[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: NoteStoreDeps) {
    this.deps = deps
  }

  /** Load persisted state from disk. Called once at startup. */
  load(): void {
    this.notes = sanitizeIndex(this.deps.load())
  }

  /** Notes in display order (pinned first, newest first). */
  toDto(): NoteDto[] {
    return this.notes.map((n) => ({ ...n }))
  }

  /** Create a note, optionally seeded with Markdown text. Returns its id. */
  create(content = ''): string {
    const now = Date.now()
    const note: Note = {
      id: createId(),
      title: deriveTitle(content),
      content,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      folded: false
    }
    this.notes.push(note)
    this.notes.sort(compareNotes)
    this.scheduleSave()
    return note.id
  }

  /**
   * Edit a note. Content edits re-derive the title; pin toggles re-sort.
   * Unknown ids are ignored (a deleted note can race an in-flight edit).
   */
  update(id: string, patch: NotePatch): void {
    const index = this.notes.findIndex((n) => n.id === id)
    if (index === -1) return
    const note = this.notes[index]
    const next: Note = { ...note, ...patch }
    if (patch.content !== undefined) {
      next.title = deriveTitle(next.content)
    }
    next.updatedAt = Date.now()
    this.notes[index] = next
    if (patch.pinned !== undefined) {
      this.notes.sort(compareNotes)
    }
    this.scheduleSave()
  }

  /** Hard-delete a note. */
  delete(id: string): void {
    const index = this.notes.findIndex((n) => n.id === id)
    if (index === -1) return
    this.notes.splice(index, 1)
    this.scheduleSave()
  }

  /** Cancel any pending debounce and write immediately (app quit). */
  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.deps.save({ version: NOTE_STORAGE_VERSION, notes: this.notes })
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.deps.save({ version: NOTE_STORAGE_VERSION, notes: this.notes })
    }, SAVE_DELAY_MS)
  }
}
