/**
 * NotesView — the notes layer (side-shelf notes).
 *
 * Two states, switched by a local editing id:
 *   - list: note cards (pin / fold / delete + tap to edit), filtered by the
 *     shared search query against title + content
 *   - editor: full-height CodeMirror editor (live markdown rendering) with a
 *     compact Markdown toolbar. Edits are saved live main-side through a
 *     180 ms debounce and flushed on exit, so the renderer never owns the
 *     source of truth.
 *
 * The list order is decided main-side (pinned first, newest first) — this
 * component only renders what the store holds.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { Bold, Italic, Strikethrough, Code, Link, Quote, List, ListOrdered, ListChecks, BookOpen, PenLine } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from '../../store/appStore'
import { useTranslation } from '../../i18n'
import type { NoteDto } from '../../../shared/types'
import { PinIcon, PinFillIcon, TrashIcon, PlusIcon, ChevronLeftIcon, ChevronUpIcon, ChevronDownIcon, ExpandIcon, ContractIcon, BundleIcon, CloseIcon } from '../icons'
import { playButtonClickSound } from '../../lib/soundEffects'
import { edge } from '../../lib/edge'
import { MarkdownPreview } from './markdown'
import { MarkdownEditor, applyCommandToView } from './markdownEditor'
import type { MdCommand } from './markdownEditor'
import type { EditorView } from '@codemirror/view'

/** How long a keystroke sits locally before the main-process update. */
const SAVE_DEBOUNCE_MS = 180

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
/** Full-height editor with a compact Markdown toolbar. Live-saved main-side.
 *
 * Both variants carry prev/next note steppers (shelf order: pinned first,
 * newest first). variant 'list' (management mode): back / title / pin /
 * delete. variant 'single' (single-note mode): title / open-all-notes modal /
 * new — pin & delete live inside the modal list instead. */
function NoteEditor({
  note,
  onBack,
  variant = 'list',
  onOpenModal,
  onNew,
  onPrevNote,
  onNextNote
}: {
  note: NoteDto
  onBack?: () => void
  variant?: 'list' | 'single'
  onOpenModal?: () => void
  onNew?: () => void
  /** Step to the previous / next note in the shelf order; null disables. */
  onPrevNote?: (() => void) | null
  onNextNote?: (() => void) | null
}) {
  const { t } = useTranslation()
  const updateNote = useStore((s) => s.updateNote)
  const deleteNote = useStore((s) => s.deleteNote)
  const noteCaret = useStore((s) => s.noteCaret)
  const setNoteCaret = useStore((s) => s.setNoteCaret)
  const viewRef = useRef<EditorView | null>(null)
  const pendingValue = useRef(note.content)
  const initialContent = useRef(note.content)
  const saveTimer = useRef<number | null>(null)
  // Reading mode (Obsidian-style): a pure render view where all markdown
  // markers stay hidden and the editor is readonly.
  const [reading, setReading] = useState(false)

  const schedulePush = (value: string) => {
    pendingValue.current = value
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void updateNote(note.id, { content: pendingValue.current })
    }, SAVE_DEBOUNCE_MS)
  }

  /** Push any pending edit now (leaving the editor, unmount). */
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

  const handleDelete = async () => {
    // Await the deletion so the list is already consistent when we return to
    // it — otherwise the deleted note flashes back for one frame.
    await deleteNote(note.id)
    onBack?.()
  }

  return (
    <div className="notes-editor">
      <div className="notes-editor-bar">
        {variant === 'single' ? (
          <>
            <span className="notes-editor-title">{note.title || t('notes.untitled')}</span>
            <button
              type="button"
              className="notes-bar-btn"
              title={t('notes.prevNote')}
              disabled={onPrevNote === null}
              onClick={() => {
                playButtonClickSound()
                onPrevNote?.()
              }}
            >
              <ChevronUpIcon width={13} height={13} />
            </button>
            <button
              type="button"
              className="notes-bar-btn"
              title={t('notes.nextNote')}
              disabled={onNextNote === null}
              onClick={() => {
                playButtonClickSound()
                onNextNote?.()
              }}
            >
              <ChevronDownIcon width={13} height={13} />
            </button>
            <button
              type="button"
              className={`notes-bar-btn${reading ? ' active' : ''}`}
              title={reading ? t('notes.editMode') : t('notes.readMode')}
              onClick={() => setReading((v) => !v)}
            >
              {reading ? <BookOpen size={13} strokeWidth={2} /> : <PenLine size={13} strokeWidth={2} />}
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
            <button
              type="button"
              className="notes-bar-btn"
              title={t('notes.prevNote')}
              disabled={onPrevNote === null}
              onClick={() => {
                playButtonClickSound()
                onPrevNote?.()
              }}
            >
              <ChevronUpIcon width={14} height={14} />
            </button>
            <button
              type="button"
              className="notes-bar-btn"
              title={t('notes.nextNote')}
              disabled={onNextNote === null}
              onClick={() => {
                playButtonClickSound()
                onNextNote?.()
              }}
            >
              <ChevronDownIcon width={14} height={14} />
            </button>
            <button
              type="button"
              className={`notes-bar-btn${reading ? ' active' : ''}`}
              title={reading ? t('notes.editMode') : t('notes.readMode')}
              onClick={() => setReading((v) => !v)}
            >
              {reading ? <BookOpen size={14} strokeWidth={2} /> : <PenLine size={14} strokeWidth={2} />}
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
          </>
        )}
      </div>

      <MarkdownEditor
        value={note.content}
        placeholder={t('notes.placeholder')}
        editorRef={viewRef}
        initialCaret={noteCaret[note.id]}
        onDocChange={schedulePush}
        onCaretChange={(pos) => setNoteCaret(note.id, pos)}
        reading={reading}
      />

      <div className="notes-toolbar">
        {CMD_TOOLS.map(({ id, Icon, i18n }) => (
          <button
            key={id}
            type="button"
            className="notes-toolbar-btn"
            title={t(i18n)}
            onClick={() => {
              const view = viewRef.current
              if (!view) return
              // The dispatch flows through the update listener, which
              // schedules the save — no separate push needed here.
              applyCommandToView(view, id)
              view.focus()
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
const NoteCard = forwardRef<HTMLDivElement, { note: NoteDto; onEdit: () => void; deleteDisabled?: boolean }>(
  function NoteCard({ note, onEdit, deleteDisabled }, ref) {
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
          disabled={deleteDisabled}
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
 * delete live on the cards). Picking a card switches the editor behind it.
 * `initialQuery` seeds the search box — a keystroke that called the modal up
 * should already be filtering when it appears. */
function NotesModal({
  open,
  notes,
  initialQuery,
  onClose,
  onSelect
}: {
  open: boolean
  notes: NoteDto[]
  initialQuery: string
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState(initialQuery)
  const searchRef = useRef<HTMLInputElement>(null)

  // Modal opens on a typed keystroke — focus the box so the search continues
  // with the next character (the window is already active: the key arrived).
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

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
          ref={searchRef}
          className="notes-modal-search"
          value={q}
          placeholder={t('notes.search')}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="notes-modal-scroll">
          <AnimatePresence initial={false} mode="popLayout">
            {filtered.map((note) => (
              <NoteCard key={note.id} note={note} onEdit={() => onSelect(note.id)} deleteDisabled={notes.length === 1} />
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

  // Prev/next note steppers operate on the full shelf order (pinned first,
  // newest first — main-side ordering), ignoring the search filter: stepping
  // keeps the surrounding notes reachable even when the list is filtered.
  const stepNote = (fromId: string, delta: number): string | null => {
    const idx = notes.findIndex((n) => n.id === fromId)
    if (idx === -1) return null
    const next = notes[idx + delta]
    return next ? next.id : null
  }

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
  // The pressed character rides along and lands in the modal's search box,
  // so the search starts immediately without a second click.
  const [modalQuery, setModalQuery] = useState('')
  useEffect(() => {
    if (noteViewMode !== 'single') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Process' || e.isComposing) return
      if (e.key.length !== 1 || e.key === ' ') return
      const el = document.activeElement
      if (el instanceof HTMLElement && el.matches('input, textarea, [contenteditable]')) return
      e.preventDefault()
      setModalQuery(e.key)
      setModalOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [noteViewMode])

  // Entering a note editor (either variant) keeps keyboard focus inside it.
  // The panel window is WS_EX_NOACTIVATE again after closing (focus.ts
  // restores it), and Chromium silently drops element.focus() on such a
  // window — so ask main to truly activate the window first, then focus
  // next frame. Re-runs when the open note changes (steppers / modal pick).
  useEffect(() => {
    const target = noteViewMode === 'single' ? effectiveCurrent : editing
    if (!open || !target) return
    edge.requestInputFocus()
    const raf = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.notes-editor .cm-content')?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open, noteViewMode, effectiveCurrent?.id, editing?.id])

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

  const prevNoteId = effectiveCurrent ? stepNote(effectiveCurrent.id, -1) : null
  const nextNoteId = effectiveCurrent ? stepNote(effectiveCurrent.id, 1) : null

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
            onPrevNote={prevNoteId !== null ? () => setCurrentId(prevNoteId) : null}
            onNextNote={nextNoteId !== null ? () => setCurrentId(nextNoteId) : null}
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
          initialQuery={modalQuery}
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
    const prevId = stepNote(editing.id, -1)
    const nextId = stepNote(editing.id, 1)
    return (
      <NoteEditor
        key={editing.id}
        note={editing}
        onBack={() => setEditingId(null)}
        onPrevNote={prevId !== null ? () => setEditingId(prevId) : null}
        onNextNote={nextId !== null ? () => setEditingId(nextId) : null}
      />
    )
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
