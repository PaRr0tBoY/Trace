/**
 * MarkdownEditor — the note editor backed by CodeMirror 6, reproducing the
 * NotchNotes editing experience: one live view where markdown renders
 * inline (markers hidden, content styled — WYSIWYG) instead of a plain
 * textarea + preview toggle.
 *
 * - markdown + GFM parsing (@codemirror/lang-markdown)
 * - decorations style the syntax tree: bold/italic/strike/code/link/heading
 *   content; block markers (`#`, `>`, `-`) and inline markers (`**`, `*`,
 *   `~~`, backticks, `[`/`](url)`) are replaced by rendered widgets; fenced
 *   code and blockquote line backgrounds
 * - task lists render as clickable checkboxes (Joplin's approach: replace
 *   the `- [x]` marker with a widget) — clicking flips the checkbox state
 *   in the source text
 * - Enter continues list/quote markers and auto-closes fences (continueOnEnter)
 * - IME composition is handled natively by CodeMirror
 */
import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { SyntaxNode } from '@lezer/common'
import { EditorState } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as cmPlaceholder
} from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { continueOnEnter, flipTaskLine } from './editorInput'

export type MdCommand = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'quote' | 'ul' | 'ol' | 'todo'

/* ── Markdown decoration ─────────────────────────────────────────── */

const mark = (from: number, to: number, cls: string): Range<Decoration> =>
  Decoration.mark({ from, to, attributes: { class: cls } }).range(from, to)
const lineCls = (from: number, cls: string): Range<Decoration> =>
  Decoration.line({ attributes: { class: cls } }).range(from)

/** Node names whose whole range is a "marker". Block markers (headings,
 * quotes, lists) and inline markers (emphasis, strike, code, link) are
 * replaced by rendered widgets while the caret is away; the caret on the
 * line / at the marker edge reveals the raw syntax so it stays editable
 * (Obsidian-style live preview). An unmatched marker never parses, so raw
 * characters stay visible while typing. */
const MARKER_NODES: Record<string, true> = {
  HeaderMark: true,
  EmphasisMark: true,
  StrikethroughMark: true,
  CodeMark: true,
  CodeInfo: true,
  LinkMark: true,
  URL: true,
  ListMark: true,
  QuoteMark: true
}

/** Zero-width widget that hides a block marker (`#`, `>`) from view. */
class HiddenMarkerWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    return document.createElement('span')
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** Renders a list marker: `•` for bullets, the original number for ordered
 * items — the source `-`/`1.` is replaced by what the preview shows.
 * Backspace at line start still deletes the whole marker (the widget is
 * one replacement range), turning the line into plain text. */
class ListMarkerWidget extends WidgetType {
  constructor(private readonly text: string) {
    super()
  }
  eq(other: ListMarkerWidget): boolean {
    return other.text === this.text
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-listmark'
    span.textContent = /^[-*•]/.test(this.text) ? '•' : this.text
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** Task checkbox widget: replaces `- [x]` with a clickable box. The widget
 * carries its source line's start position, so toggling never depends on
 * guessing the position back from the DOM. */
class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly lineFrom: number
  ) {
    super()
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.lineFrom === this.lineFrom
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span')
    box.className = 'cm-task-box'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(this.checked))
    box.textContent = this.checked ? '✓' : ''
    // Keep the click from moving the editor caret onto the widget.
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      toggleTaskAt(view, this.lineFrom)
    })
    return box
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** Flip the `- [x]` / `- [ ]` marker on the line containing `pos`. */
function toggleTaskAt(view: EditorView, pos: number): void {
  const line = view.state.doc.lineAt(pos)
  const flipped = flipTaskLine(line.text)
  if (flipped === null) return
  view.dispatch({ changes: { from: line.from, to: line.to, insert: flipped } })
}

export function buildDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = []
  const tree = syntaxTree(view.state)
  const { from: selFrom, to: selTo } = view.state.selection.main
  const selSpan = selFrom !== selTo

  tree.iterate({
    enter: (node) => {
      const { name, from, to } = node
      const line = view.state.doc.lineAt(from)
      const caretOnLine = selFrom >= line.from && selFrom <= line.to
      if (MARKER_NODES[name]) {
        // Block markers (`#`, `>`, list markers): the caret on the line
        // reveals the raw marker so it can be edited (Obsidian behavior);
        // otherwise a bare marker (no space yet) stays visible as raw text
        // and an active one renders as its widget.
        if (name === 'HeaderMark' || name === 'QuoteMark' || name === 'ListMark') {
          if (caretOnLine) {
            decos.push(mark(from, to, 'cm-md-marker'))
            return
          }
          const active = view.state.doc.sliceString(to, to + 1) === ' '
          if (active && name === 'ListMark') {
            // Task lines show no bullet — the checkbox is the marker.
            const isTask = node.node.parent?.getChild('TaskMarker') !== null
            decos.push(
              isTask
                ? Decoration.replace({ widget: new HiddenMarkerWidget() }).range(from, to)
                : Decoration.replace({
                    widget: new ListMarkerWidget(view.state.doc.sliceString(from, to))
                  }).range(from, to)
            )
          } else {
            decos.push(
              active
                ? Decoration.replace({ widget: new HiddenMarkerWidget() }).range(from, to)
                : mark(from, to, 'cm-md-marker')
            )
          }
          return
        }
        // Inline markers (`**`, `*`, `~~`, backticks, `[`/`](url)`):
        // revealed (raw text) while the caret is anywhere inside the
        // marked content (both opening and closing markers come back, so
        // editing mid-content shows where the syntax is), at the marker
        // edge on the same line, inside the marker itself, or when the
        // selection spans it. A caret on another line is never "at the
        // edge" — pressing Enter past a trailing marker must not reveal
        // half of it. Once the caret leaves the construct it renders
        // hidden again.
        const parent = node.node.parent
        const inContent = parent !== null && selFrom >= parent.from && selFrom <= parent.to
        const near =
          inContent ||
          (caretOnLine &&
            ((selFrom >= from - 1 && selFrom <= to + 1) || (selTo >= from - 1 && selTo <= to + 1))) ||
          (selSpan && selFrom <= to && selTo >= from)
        decos.push(
          near ? mark(from, to, 'cm-md-marker') : Decoration.replace({ widget: new HiddenMarkerWidget() }).range(from, to)
        )
        return
      }

      switch (name) {        case 'StrongEmphasis':
          decos.push(mark(from, to, 'cm-md-strong'))
          break
        case 'Emphasis':
          decos.push(mark(from, to, 'cm-md-italic'))
          break
        case 'Strikethrough':
          decos.push(mark(from, to, 'cm-md-strike'))
          break
        case 'InlineCode':
          decos.push(mark(from, to, 'cm-md-inline-code'))
          break
        case 'Link':
          decos.push(mark(from, to, 'cm-md-link'))
          break
        case 'CodeText':
          decos.push(mark(from, to, 'cm-md-code-text'))
          break
        case 'FencedCode':
          for (let l = line.number; l <= view.state.doc.lineAt(to).number; l++) {
            decos.push(lineCls(view.state.doc.line(l).from, 'cm-md-code-block'))
          }
          break
        case 'Blockquote':
          // Only apply the quote visual when the `>` is followed by a
          // space — `>text` has not taken effect yet (matches the marker
          // rule above).
          if (!view.state.doc.lineAt(from).text.startsWith('> ')) break
          for (let l = line.number; l <= view.state.doc.lineAt(to).number; l++) {
            decos.push(lineCls(view.state.doc.line(l).from, 'cm-md-quote-line'))
          }
          break
        case 'TaskMarker': {
          // The caret on the line reveals the raw `[ ]` so it can be
          // edited; elsewhere the clickable checkbox widget takes over.
          if (caretOnLine) break
          const listItem = node.node.parent
          const listMark = listItem?.getChild('ListMark')
          const replaceFrom = listMark ? listMark.from : from
          const checked = view.state.doc.sliceString(from, to).toLowerCase().includes('x')
          decos.push(Decoration.replace({ widget: new TaskCheckboxWidget(checked, line.from) }).range(replaceFrom, to))
          break
        }
        default: {
          // ATXHeading1..6 — sized headings. Only when the `#` marker is
          // followed by a space (`#title` has not taken effect).
          const m = /^ATXHeading(\d)$/.exec(name)
          if (m) {
            const headerMark = node.node.getChild('HeaderMark')
            const active = headerMark !== null && view.state.doc.sliceString(headerMark.to, headerMark.to + 1) === ' '
            if (active) decos.push(mark(from, to, `cm-md-h${m[1]}`))
          }
        }
      }
    }
  })

  // sort=true: tree.iterate emits parent-first depth-first order, which is
  // not sorted by `from` (a multi-line FencedCode/Blockquote pushes several
  // line decorations before inner nodes on earlier lines). RangeSet.of
  // without sorting throws "Ranges must be added sorted".
  return Decoration.set(decos, true)
}

const markdownDeco = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

/** Click-to-open rendered links: a click on the link label opens the URL in
 * the system browser (window.open → main's setWindowOpenHandler). Clicks on
 * the URL itself (visible when the caret reveals the marker) stay in the
 * editor so the link can be edited. */
const linkClick = EditorView.domEventHandlers({
  click: (event, view) => {
    const pos = view.posAtCoords(event)
    if (pos == null) return
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos).node
    while (node && node.name !== 'Link') node = node.parent
    if (!node) return
    const urlNode = node.getChild('URL')
    if (!urlNode || (pos >= urlNode.from && pos <= urlNode.to)) return
    const href = view.state.doc.sliceString(urlNode.from, urlNode.to)
    window.open(/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`, '_blank')
  }
})

const enterContinuation = keymap.of([
  {
    key: 'Enter',
    run: (view) => {
      const { state } = view
      const sel = state.selection.main
      // IME candidate confirmation: Enter is handled by the composition.
      if (view.composing || sel.from !== sel.to) return false
      const edit = continueOnEnter(state.doc.toString(), sel.from)
      if (!edit) return false
      view.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        selection: { anchor: edit.caret }
      })
      return true
    }
  }
])

/* ── Theme — mirrors the old .notes-textarea look ────────────────── */

const notesTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'transparent',
    color: 'var(--text-primary)'
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.6',
    overflow: 'auto',
    scrollbarWidth: 'none' /* Firefox */
  },
  '.cm-scroller::-webkit-scrollbar': {
    display: 'none' /* Chrome/Safari — invisible scrollbar like the panel */
  },
  '.cm-content': {
    padding: '8px 10px',
    caretColor: 'var(--text-primary)'
  },
  '&.cm-focused': {
    outline: 'none'
  },
  '.cm-line': {
    padding: '0'
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(255, 255, 255, 0.14) !important'
  },
  '& ::selection': {
    backgroundColor: 'rgba(255, 255, 255, 0.14)'
  },
  '.cm-placeholder': {
    color: 'var(--text-tertiary)'
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--text-primary)'
  }
})

/* ── Toolbar commands (applied to the current selection / line) ──── */

/** Apply a Markdown command to the editor's selection (or current line).
 * The caret lands right after the inserted content and nothing is selected,
 * so the next keystroke keeps typing. Line commands prefix every selected
 * line (empty selection → the current line); wrap commands replace the
 * selection with `**content**` (placeholder when nothing was selected). */
export function applyCommandToView(view: EditorView, cmd: MdCommand): void {
  const { state } = view
  const sel = state.selection.main
  const start = Math.min(sel.from, sel.to)
  const end = Math.max(sel.from, sel.to)
  const value = state.doc.toString()
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
    view.dispatch({
      changes: { from: lineStart, to: lineEnd, insert: prefixed },
      selection: { anchor: lineStart + prefixed.length }
    })
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
    const insert = `${pre}${inner}${post}`
    view.dispatch({
      changes: { from: start, to: end, insert },
      selection: { anchor: start + insert.length }
    })
  }
}

/* ── Component ───────────────────────────────────────────────────── */

export function MarkdownEditor({
  value,
  placeholder,
  onDocChange,
  onCaretChange,
  initialCaret,
  editorRef
}: {
  value: string
  placeholder?: string
  onDocChange: (doc: string) => void
  onCaretChange: (pos: number) => void
  initialCaret?: number
  editorRef?: MutableRefObject<EditorView | null>
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          // markdownLanguage carries the GFM extensions (strikethrough,
          // task lists) — bare markdown() only parses CommonMark, which
          // would silently drop the ~~strike~~ and - [x] decorations.
          // addKeymap: false keeps the built-in Enter/Backspace bindings
          // (insertNewlineContinueMarkup/deleteMarkupBackward, registered
          // with Prec.high) from pre-empting enterContinuation below —
          // they only continue non-empty items and drop empty list
          // markers on Enter, which is not the behavior we want.
          markdown({ base: markdownLanguage, addKeymap: false }),
          history(),
          notesTheme,
          markdownDeco,
          linkClick,
          enterContinuation,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          cmPlaceholder(placeholder ?? ''),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onDocChange(u.state.doc.toString())
            if (u.selectionSet || u.docChanged) onCaretChange(u.state.selection.main.head)
          })
        ]
      }),
      parent: host
    })
    if (editorRef) editorRef.current = view
    // Restore the remembered caret and land straight in the editor. With
    // no remembered position (first edit / fresh session) the caret goes
    // to the end of the content so typing continues where it left off.
    const target = initialCaret != null && initialCaret <= view.state.doc.length ? initialCaret : view.state.doc.length
    view.dispatch({ selection: { anchor: target } })
    view.focus()
    return () => {
      view.destroy()
      if (editorRef) editorRef.current = null
    }
    // Mount once per note (parent keys the component by note id); `value`
    // is the initial document only — later content flows in through remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={hostRef} className="notes-cm-host" />
}
