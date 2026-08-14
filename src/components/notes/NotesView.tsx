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
import { Bold, Italic, Strikethrough, Code, Link, Quote, List, ListOrdered, ListChecks } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { NoteDto } from '../../../shared/types'
import { PinIcon, PinFillIcon, TrashIcon, PlusIcon, ChevronLeftIcon, ExpandIcon, ContractIcon, BundleIcon, CloseIcon, PenLineIcon, EyeIcon } from '../icons'
import { playButtonClickSound } from '../../lib/soundEffects'
import { MarkdownPreview } from './markdown'
import { continueOnEnter } from './editorInput'

/** How long a keystroke sits locally before the main-process update. */
const SAVE_DEBOUNCE_MS = 180

/** Markdown toolbar commands — the full NotchNotes set (bold / italic /
 * strikethrough / inline code / link / quote / bulleted / numbered / todo). */
type MdCommand = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'quote' | 'ul' | 'ol' | 'todo'

const CMD_TOOLS: Array<{ id: MdCommand; Icon: LucideIcon; i18n: string }> = [
  { id: 'bold', Icon: Bold, i18n: 'notes.bold' },
  { id: 'italic', Icon: Italic, i18n: 'notes.italic' },
  { id: 'strike', Icon: Strikethrough, i18n: 'notes.strike' },
  { id: 'code', Icon: Code, i18n: 'notes.code' },
  { id: 'link', Icon: Link, i18n: 'notes.link' },
  { id: 'quote', Icon: Quote, i18n: 'notes.quote' },
  { id: 'ul', Icon: List, i18n: 'notes.list' },
  { id: 'ol', Icon: ListOrdered, i18n: 'notes.orderedList' },
  { id: 'todo', Icon: ListChecks, i18n: 'notes.todo' }
]

/** Replace [start,end) with the given text, keeping the cursor after it. */
function splice(value: string, start: number, end: number, next: string): string {
  return value.slice(0, start) + next + value.slice(end)
}

/** Apply a Markdown command to the textarea's selection (or current line).
 * Selection behavior mirrors NotchNotes: wrap commands select the inner
 * content (placeholder when nothing was selected), link selects the URL
 * when wrapping a label, and line commands select the whole block. */
function applyCommand(ta: HTMLTextAreaElement, cmd: MdCommand): void {
  const value = ta.value
  const start = ta.selectionStart ?? 0
  const end = ta.selectionEnd ?? 0
  const selected = value.slice(start, end)
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const lineEnd = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end)

  if (cmd === 'quote' || cmd === 'ul' || cmd === 'ol' || cmd === 'todo') {
    // Prefix every selected line (empty selection → the current line).
    const block = value.slice(lineStart, lineEnd)
    const prefix = cmd === 'quote' ? '> ' : cmd === 'ul' ? '- ' : cmd === 'todo' ? '- [ ] ' : ''
    const prefixed = block
      .split('\n')
      .map((line, i) => {
        if (cmd === 'ol') {
          // Renumber: strip any existing number prefix instead of stacking.
          return `${i + 1}. ${line.replace(/^\d+\.\s+/, '')}`
        }
        return line.startsWith(prefix) ? line.slice(prefix.length) : `${prefix}${line}`
      })
      .join('\n')
    ta.value = splice(value, lineStart, lineEnd, prefixed)
    ta.setSelectionRange(lineStart, lineStart + prefixed.length)
  } else {
    const wrap: Record<'bold' | 'italic' | 'strike' | 'code' | 'link', [string, string, string]> = {
      bold: ['**', '**', 'bold'],
      italic: ['*', '*', 'italic'],
      strike: ['~~', '~~', 'strikethrough'],
      code: ['`', '`', 'code'],
      link: ['[', '](url)', 'text']
    }
    const [pre, post, placeholder] = wrap[cmd]
    const inner = selected || placeholder
    ta.value = splice(value, start, end, `${pre}${inner}${post}`)
    if (cmd === 'link') {
      // Empty selection → select the label; wrapped label → select the URL.
      const selStart = selected ? start + inner.length + 3 : start + 1
      ta.setSelectionRange(selStart, selStart + (selected ? 3 : inner.length))
    } else {
      ta.setSelectionRange(start + pre.length, start + pre.length + inner.length)
    }
  }

  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Full-height editor with a compact Markdown toolbar. Live-saved main-side.
 *
 * variant 'list' (management mode): back / title / pin / delete.
 * variant 'single' (single-note mode): title / open-all-notes modal / new —
 * pin & delete live inside the modal list instead. */
function NoteEditor({
  note,
  onBack,
  variant = 'list',
  onOpenModal,
  onNew
}: {
  note: NoteDto
  onBack?: () => void
  variant?: 'list' | 'single'
  onOpenModal?: () => void
  onNew?: () => void
}) {
  const { t } = useTranslation()
  const updateNote = useStore((s) => s.updateNote)
  const deleteNote = useStore((s) => s.deleteNote)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const pendingValue = useRef(note.content)
  const initialContent = useRef(note.content)
  const saveTimer = useRef<number | null>(null)
  // edit = plain textarea, preview = rendered Markdown (see MarkdownPreview).
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')

  const schedulePush = (value: string) => {
    pendingValue.current = value
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void updateNote(note.id, { content: pendingValue.current })
    }, SAVE_DEBOUNCE_MS)
  }

  /** Push any pending edit now (mode switches, unmount). */
  const flush = () => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    if (pendingValue.current !== initialContent.current) {
      void updateNote(note.id, { content: pendingValue.current })
      initialContent.current = pendingValue.current
    }
  }

  // Flush the debounced edit when leaving the editor (back / delete / view switch).
  useEffect(() => {
    return () => {
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id])

  // Switching notes / creating a note lands straight in the editor, ready to
  // type; the panel re-opening after a collapse does the same (see NotesView).
  useEffect(() => {
    if (mode !== 'edit') return
    const raf = requestAnimationFrame(() => taRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [mode, note.id])

  const handleDelete = async () => {
    // Await the deletion so the list is already consistent when we return to
    // it — otherwise the deleted note flashes back for one frame.
    await deleteNote(note.id)
    onBack?.()
  }

  const switchMode = (next: 'edit' | 'preview') => {
    if (next === mode) return
    playButtonClickSound()
    flush()
    setMode(next)
  }

  /** Programmatic edit on the (uncontrolled) textarea + schedule the save. */
  const applyEdit = (next: string, caret: number) => {
    const ta = taRef.current
    if (!ta) return
    ta.value = next
    ta.setSelectionRange(caret, caret)
    schedulePush(next)
  }

  // Enter continuation, mirroring NotchNotes' input behavior (see
  // continueOnEnter): list / quote markers carry to the next line, an empty
  // item drops its marker, and an opening ``` fence auto-closes.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    const ta = taRef.current
    if (!ta) return
    const { selectionStart, selectionEnd, value } = ta
    if (selectionStart !== selectionEnd) return
    const edit = continueOnEnter(value, selectionStart)
    if (edit) {
      e.preventDefault()
      applyEdit(edit.next, edit.caret)
    }
  }

  return (
    <div className="notes-editor">
      <div className="notes-editor-bar">
        {variant === 'single' ? (
          <>
            <span className="notes-editor-title">{note.title || t('notes.untitled')}</span>
            <button
              type="button"
              className={`notes-bar-btn${mode === 'edit' ? ' active' : ''}`}
              title={t('notes.editMode')}
              onClick={() => switchMode('edit')}
            >
              <PenLineIcon width={13} height={13} />
            </button>
            <button
              type="button"
              className={`notes-bar-btn${mode === 'preview' ? ' active' : ''}`}
              title={t('notes.previewMode')}
              onClick={() => switchMode('preview')}
            >
              <EyeIcon width={13} height={13} />
            </button>
            <button
              type="button"
              className="notes-bar-btn"
              title={t('notes.allNotes')}
              onClick={() => {
                playButtonClickSound()
                onOpenModal?.()
              }}
            >
              <BundleIcon width={13} height={13} />
            </button>
            <button
              type="button"
              className="notes-bar-btn"
              title={t('notes.new')}
              onClick={() => {
                playButtonClickSound()
                onNew?.()
              }}
            >
              <PlusIcon width={13} height={13} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="notes-bar-btn"
              title={t('notes.back')}
              onClick={() => {
                playButtonClickSound()
                onBack?.()
              }}
            >
              <ChevronLeftIcon width={14} height={14} />
            </button>
            <span className="notes-editor-title">{note.title || t('notes.untitled')}</span>
            <button
              type="button"
              className={`notes-bar-btn${mode === 'edit' ? ' active' : ''}`}
              title={t('notes.editMode')}
              onClick={() => switchMode('edit')}
            >
              <PenLineIcon width={13} height={13} />
            </button>
            <button
              type="button"
              className={`notes-bar-btn${mode === 'preview' ? ' active' : ''}`}
              title={t('notes.previewMode')}
              onClick={() => switchMode('preview')}
            >
              <EyeIcon width={13} height={13} />
            </button>
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
          </>
        )}
      </div>

      {mode === 'edit' ? (
        <textarea
          ref={taRef}
          className="notes-textarea"
          defaultValue={note.content}
          placeholder={t('notes.placeholder')}
          spellCheck={false}
          onChange={(e) => schedulePush(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <div className="notes-preview">
          <MarkdownPreview text={note.content} />
        </div>
      )}

      <div className="notes-toolbar">
        {CMD_TOOLS.map(({ id, Icon, i18n }) => (
          <button
            key={id}
            type="button"
            className="notes-toolbar-btn"
            title={t(i18n)}
            onClick={() => {
              const ta = taRef.current
              if (!ta) return
              applyCommand(ta, id)
              schedulePush(ta.value)
              ta.focus()
            }}
          >
            <Icon size={14} strokeWidth={2} />
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
    const joined = rest.join('\n')
    // Cut to 220 chars at a line boundary so no markdown block is left
    // half-open (a lone '**' or '```' renders as stray text).
    if (joined.length <= 220) return joined
    const cut = joined.slice(0, 220)
    const breakAt = cut.lastIndexOf('\n')
    return breakAt > 0 ? cut.slice(0, breakAt) : cut
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
      {!note.folded && preview.length > 0 && (
        <div className="notes-card-preview">
          <MarkdownPreview text={preview} />
        </div>
      )}
    </motion.div>
  )
})

/** All-notes modal for single-note mode: search + card list (pin / fold /
 * delete live on the cards). Picking a card switches the editor behind it. */
function NotesModal({
  open,
  notes,
  onClose,
  onSelect
}: {
  open: boolean
  notes: NoteDto[]
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    if (!q.trim()) return notes
    const s = q.trim().toLowerCase()
    return notes.filter((n) => n.title.toLowerCase().includes(s) || n.content.toLowerCase().includes(s))
  }, [notes, q])

  if (!open) return null

  return (
    <div className="notes-modal-backdrop" onClick={onClose}>
      <div className="notes-modal" onClick={(e) => e.stopPropagation()}>
        <div className="notes-modal-head">
          <span className="notes-modal-title">{t('notes.allNotes')}</span>
          <button type="button" className="notes-bar-btn" title={t('notes.back')} onClick={onClose}>
            <CloseIcon width={13} height={13} />
          </button>
        </div>
        <input
          className="notes-modal-search"
          value={q}
          placeholder={t('notes.search')}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="notes-modal-scroll">
          <AnimatePresence initial={false} mode="popLayout">
            {filtered.map((note) => (
              <NoteCard key={note.id} note={note} onEdit={() => onSelect(note.id)} />
            ))}
          </AnimatePresence>
          {filtered.length === 0 && (
            <div className="notes-empty">
              <p>{notes.length === 0 ? t('notes.empty') : t('notes.noMatches')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function NotesView() {
  const { t } = useTranslation()
  const notes = useStore((s) => s.notes)
  const query = useStore((s) => s.query)
  const open = useStore((s) => s.open)
  const createNote = useStore((s) => s.createNote)
  const pushToast = useStore((s) => s.pushToast)
  const noteViewMode = useStore((s) => s.settings.noteViewMode ?? 'single')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const filtered = useMemo(() => {
    if (!query.trim()) return notes
    const q = query.trim().toLowerCase()
    return notes.filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
  }, [notes, query])

  const editing = editingId !== null ? notes.find((n) => n.id === editingId) : undefined
  const current = currentId !== null ? notes.find((n) => n.id === currentId) : undefined
  // When the open note is deleted the editor must not flash a blank frame:
  // render the next note immediately and let the effect below sync currentId.
  const effectiveCurrent = current ?? (notes.length > 0 ? notes[0] : undefined)

  // Single-note mode: keep currentId pointing at a live note. An empty shelf
  // shows the empty state — deleting the last note never fabricates a new one.
  useEffect(() => {
    if (noteViewMode !== 'single') return
    if (currentId !== null && notes.some((n) => n.id === currentId)) return
    if (notes.length > 0) setCurrentId(notes[0].id)
    else setCurrentId(null)
  }, [noteViewMode, notes, currentId])

  // Single-note mode: typing while the editor is open calls up the all-notes
  // modal (the management list lives there) instead of the clipboard search.
  useEffect(() => {
    if (noteViewMode !== 'single') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Process' || e.isComposing) return
      if (e.key.length !== 1 || e.key === ' ') return
      const el = document.activeElement
      if (el instanceof HTMLElement && el.matches('input, textarea, [contenteditable]')) return
      e.preventDefault()
      setModalOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [noteViewMode])

  // Panel re-opening after a collapse lands straight back in the editor.
  useEffect(() => {
    if (noteViewMode !== 'single' || !open || !effectiveCurrent) return
    const ta = document.querySelector<HTMLTextAreaElement>('.notes-editor textarea')
    if (ta) {
      const raf = requestAnimationFrame(() => ta.focus())
      return () => cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, noteViewMode])

  const handleNew = () => {
    playButtonClickSound()
    // main returns the created id — the note may sort below pinned notes,
    // so index 0 is not a safe assumption
    void createNote('').then((id) => {
      setEditingId(id)
      pushToast({ id: crypto.randomUUID(), message: t('notes.created'), tone: 'info' })
    })
  }

  const handleNewSingle = () => {
    playButtonClickSound()
    void createNote('').then((id) => {
      setCurrentId(id)
      pushToast({ id: crypto.randomUUID(), message: t('notes.created'), tone: 'info' })
    })
  }

  if (noteViewMode === 'single') {
    return (
      <div className="notes-single">
        {effectiveCurrent ? (
          <NoteEditor
            key={effectiveCurrent.id}
            note={effectiveCurrent}
            variant="single"
            onOpenModal={() => setModalOpen(true)}
            onNew={handleNewSingle}
          />
        ) : (
          <div className="notes-single-empty">
            <p>{t('notes.empty')}</p>
            <button type="button" className="notes-new-btn" onClick={handleNewSingle}>
              <PlusIcon width={12} height={12} />
              <span>{t('notes.new')}</span>
            </button>
          </div>
        )}
        <NotesModal
          open={modalOpen}
          notes={notes}
          onClose={() => setModalOpen(false)}
          onSelect={(id) => {
            setCurrentId(id)
            setModalOpen(false)
          }}
        />
      </div>
    )
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
          </div>
        )}
      </div>
    </div>
  )
}
