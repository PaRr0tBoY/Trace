/**
 * NotesView — the notes layer (side-shelf notes).
 *
 * Two states, switched by a local editing id:
 *   - list: note cards (pin / fold / delete + tap to edit), filtered by the
 *     shared search query against title + content
 *   - editor: full-height textarea with a compact Markdown toolbar. Edits are
 *     saved live main-side through a 180 ms debounce and flushed on exit, so
 *     the renderer never owns the source of truth.
 *
 * The list order is decided main-side (pinned first, newest first) — this
 * component only renders what the store holds.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { NoteDto } from '../../../shared/types'
import { PinIcon, PinFillIcon, TrashIcon, PlusIcon, ChevronLeftIcon, ExpandIcon, ContractIcon } from '../icons'
import { playButtonClickSound } from '../../lib/soundEffects'

/** How long a keystroke sits locally before the main-process update. */
const SAVE_DEBOUNCE_MS = 180

/** Markdown toolbar commands (Same set NotchNotes ships). */
type MdCommand = 'bold' | 'italic' | 'code' | 'link' | 'quote' | 'ul' | 'todo'

const CMD_LABELS: Array<{ id: MdCommand; label: string; i18n: string }> = [
  { id: 'bold', label: 'B', i18n: 'notes.bold' },
  { id: 'italic', label: 'I', i18n: 'notes.italic' },
  { id: 'code', label: '`', i18n: 'notes.code' },
  { id: 'link', label: '🔗', i18n: 'notes.link' },
  { id: 'quote', label: '❝', i18n: 'notes.quote' },
  { id: 'ul', label: '•', i18n: 'notes.list' },
  { id: 'todo', label: '☑', i18n: 'notes.todo' }
]

/** Replace [start,end) with the given text, keeping the cursor after it. */
function splice(value: string, start: number, end: number, next: string): string {
  return value.slice(0, start) + next + value.slice(end)
}

/** Apply a Markdown command to the textarea's selection (or current line). */
function applyCommand(ta: HTMLTextAreaElement, cmd: MdCommand): void {
  const value = ta.value
  const start = ta.selectionStart ?? 0
  const end = ta.selectionEnd ?? 0
  const selected = value.slice(start, end)
  let next: string
  let caret = start

  if (cmd === 'quote' || cmd === 'ul' || cmd === 'todo') {
    // Prefix every selected line (empty selection → the current line).
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const lineEnd = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end)
    const block = value.slice(lineStart, lineEnd)
    const prefix = cmd === 'quote' ? '> ' : cmd === 'ul' ? '- ' : '- [ ] '
    const prefixed = block
      .split('\n')
      .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : `${prefix}${l}`))
      .join('\n')
    next = splice(value, lineStart, lineEnd, prefixed)
    caret = lineStart + prefixed.length
  } else {
    const wrap: Record<Exclude<MdCommand, 'quote' | 'ul' | 'todo'>, [string, string, string]> = {
      bold: ['**', '**', 'bold'],
      italic: ['*', '*', 'italic'],
      code: ['`', '`', 'code'],
      link: ['[', '](url)', 'text']
    }
    const [pre, post, placeholder] = wrap[cmd]
    const inner = selected || placeholder
    next = splice(value, start, end, `${pre}${inner}${post}`)
    caret = start + pre.length + inner.length + post.length
  }

  ta.value = next
  ta.setSelectionRange(caret, caret)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Full-height editor with a compact Markdown toolbar. Live-saved main-side. */
function NoteEditor({ note, onBack }: { note: NoteDto; onBack: () => void }) {
  const { t } = useTranslation()
  const updateNote = useStore((s) => s.updateNote)
  const deleteNote = useStore((s) => s.deleteNote)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const pendingValue = useRef(note.content)
  const initialContent = useRef(note.content)
  const saveTimer = useRef<number | null>(null)

  const schedulePush = (value: string) => {
    pendingValue.current = value
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void updateNote(note.id, { content: pendingValue.current })
    }, SAVE_DEBOUNCE_MS)
  }

  // Flush the debounced edit when leaving the editor (back / delete / view switch).
  useEffect(() => {
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
      if (pendingValue.current !== initialContent.current) {
        void updateNote(note.id, { content: pendingValue.current })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id])

  const handleDelete = () => {
    void deleteNote(note.id)
    onBack()
  }

  return (
    <div className="notes-editor">
      <div className="notes-editor-bar">
        <button
          type="button"
          className="notes-bar-btn"
          title={t('notes.back')}
          onClick={() => {
            playButtonClickSound()
            onBack()
          }}
        >
          <ChevronLeftIcon width={14} height={14} />
        </button>
        <span className="notes-editor-title">{note.title || t('notes.untitled')}</span>
        <button
          type="button"
          className="notes-bar-btn"
          title={note.pinned ? t('notes.unpin') : t('notes.pin')}
          onClick={() => {
            playButtonClickSound()
            void updateNote(note.id, { pinned: !note.pinned })
          }}
        >
          {note.pinned ? <PinFillIcon width={13} height={13} /> : <PinIcon width={13} height={13} />}
        </button>
        <button type="button" className="notes-bar-btn danger" title={t('notes.delete')} onClick={handleDelete}>
          <TrashIcon width={13} height={13} />
        </button>
      </div>

      <textarea
        ref={taRef}
        className="notes-textarea"
        defaultValue={note.content}
        placeholder={t('notes.placeholder')}
        spellCheck={false}
        onChange={(e) => schedulePush(e.target.value)}
      />

      <div className="notes-toolbar">
        {CMD_LABELS.map((cmd) => (
          <button
            key={cmd.id}
            type="button"
            className="notes-toolbar-btn"
            title={t(cmd.i18n)}
            onClick={() => {
              const ta = taRef.current
              if (!ta) return
              applyCommand(ta, cmd.id)
              schedulePush(ta.value)
              ta.focus()
            }}
          >
            {cmd.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** One note card in the list: title row + (unless folded) a two-line preview. */
const NoteCard = forwardRef<HTMLDivElement, { note: NoteDto; onEdit: () => void }>(function NoteCard(
  { note, onEdit },
  ref
) {
  const { t } = useTranslation()
  const updateNote = useStore((s) => s.updateNote)
  const deleteNote = useStore((s) => s.deleteNote)

  const preview = useMemo(() => {
    const lines = note.content.split('\n').filter((l) => l.trim().length > 0)
    // The first meaningful line is the title; preview shows what follows.
    const rest = lines.length > 1 ? lines.slice(1) : lines
    return rest.join('\n').slice(0, 220)
  }, [note.content])

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className={`notes-card${note.pinned ? ' pinned' : ''}`}
      onClick={onEdit}
    >
      <div className="notes-card-row">
        <button
          type="button"
          className="notes-card-btn"
          title={note.pinned ? t('notes.unpin') : t('notes.pin')}
          onClick={(e) => {
            e.stopPropagation()
            playButtonClickSound()
            void updateNote(note.id, { pinned: !note.pinned })
          }}
        >
          {note.pinned ? <PinFillIcon width={12} height={12} /> : <PinIcon width={12} height={12} />}
        </button>
        <button type="button" className="notes-card-title" title={t('notes.edit')} onClick={onEdit}>
          {note.title || t('notes.untitled')}
        </button>
        <button
          type="button"
          className="notes-card-btn"
          title={note.folded ? t('notes.expand') : t('notes.fold')}
          onClick={(e) => {
            e.stopPropagation()
            playButtonClickSound()
            void updateNote(note.id, { folded: !note.folded })
          }}
        >
          {note.folded ? <ExpandIcon width={12} height={12} /> : <ContractIcon width={12} height={12} />}
        </button>
        <button
          type="button"
          className="notes-card-btn danger"
          title={t('notes.delete')}
          onClick={(e) => {
            e.stopPropagation()
            void deleteNote(note.id)
          }}
        >
          <TrashIcon width={12} height={12} />
        </button>
      </div>
      {!note.folded && preview.length > 0 && <div className="notes-card-preview">{preview}</div>}
    </motion.div>
  )
})

export function NotesView() {
  const { t } = useTranslation()
  const notes = useStore((s) => s.notes)
  const query = useStore((s) => s.query)
  const createNote = useStore((s) => s.createNote)
  const [editingId, setEditingId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    if (!query.trim()) return notes
    const q = query.trim().toLowerCase()
    return notes.filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
  }, [notes, query])

  const editing = editingId !== null ? notes.find((n) => n.id === editingId) : undefined

  const handleNew = () => {
    playButtonClickSound()
    // main returns the created id — the note may sort below pinned notes,
    // so index 0 is not a safe assumption
    void createNote('').then((id) => setEditingId(id))
  }

  if (editing) {
    // key remounts the editor per note so draft state never leaks across notes
    return <NoteEditor key={editing.id} note={editing} onBack={() => setEditingId(null)} />
  }

  return (
    <div className="notes-list">
      <div className="notes-list-bar">
        <button type="button" className="notes-new-btn" onClick={handleNew}>
          <PlusIcon width={12} height={12} />
          <span>{t('notes.new')}</span>
        </button>
        <span className="notes-count">
          {notes.length} {notes.length === 1 ? t('notes.note') : t('notes.notes')}
        </span>
      </div>

      <div className="notes-scroll">
        <AnimatePresence initial={false} mode="popLayout">
          {filtered.map((note) => (
            <NoteCard key={note.id} note={note} onEdit={() => setEditingId(note.id)} />
          ))}
        </AnimatePresence>

        {filtered.length === 0 && (
          <div className="notes-empty">
            <p>{notes.length === 0 ? t('notes.empty') : t('notes.noMatches')}</p>
            {notes.length === 0 && (
              <button type="button" className="notes-new-btn" onClick={handleNew}>
                <PlusIcon width={12} height={12} />
                <span>{t('notes.new')}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
