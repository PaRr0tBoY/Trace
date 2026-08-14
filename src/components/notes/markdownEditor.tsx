/**
 * MarkdownEditor — the note editor backed by CodeMirror 6, reproducing the
 * NotchNotes editing experience: one live view where markdown renders
 * inline (markers stay visible but dimmed, content gets styled) instead of
 * a plain textarea + preview toggle.
 *
 * - markdown + GFM parsing (@codemirror/lang-markdown)
 * - decorations style the syntax tree: bold/italic/strike/code/link/heading
 *   content, dimmed markers (like NotchNotes' headingMarker), fenced code
 *   and blockquote line backgrounds
 * - task lists render as clickable checkboxes (Joplin's approach: replace
 *   the `- [x]` marker with a widget) — clicking flips the checkbox state
 *   in the source text; the current line reveals its raw marker
 * - Enter continues list/quote markers and auto-closes fences (continueOnEnter)
 * - IME composition is handled natively by CodeMirror
 */
import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
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
import { continueOnEnter } from './editorInput'

export type MdCommand = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'quote' | 'ul' | 'ol' | 'todo'

/* ── Markdown decoration ─────────────────────────────────────────── */

const mark = (from: number, to: number, cls: string): Range<Decoration> =>
  Decoration.mark({ from, to, attributes: { class: cls } }).range(from, to)
const lineCls = (from: number, cls: string): Range<Decoration> =>
  Decoration.line({ attributes: { class: cls } }).range(from)

/** Node names whose whole range is a "dimmed marker" (kept visible, like
 * NotchNotes' headingMarker color). The class resets inherited emphasis so
 * markers never render bold/italic/struck themselves. */
const MARKER_NODES = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'CodeInfo',
  'LinkMark',
  'URL',
  'ListMark',
  'QuoteMark'
])

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
  const m = /^(\s*[-*•]\s+)\[([ xX])\](.*)$/.exec(line.text)
  if (!m) return
  const [, prefix, markText, rest] = m
  const insert = `${prefix}[${markText.toLowerCase() === 'x' ? ' ' : 'x'}${rest}`
  view.dispatch({ changes: { from: line.from, to: line.to, insert } })
}

function buildDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = []
  const tree = syntaxTree(view.state)
  const { from: selFrom, to: selTo } = view.state.selection.main

  tree.iterate({
    enter: (node) => {
      const { name, from, to } = node
      if (MARKER_NODES.has(name)) {
        decos.push(mark(from, to, 'cm-md-marker'))
        return
      }
      const line = view.state.doc.lineAt(from)
      const onSelLine = (selFrom >= line.from && selFrom <= line.to) || (selTo >= line.from && selTo <= line.to)

      switch (name) {
        case 'StrongEmphasis':
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
          for (let l = line.number; l <= view.state.doc.lineAt(to).number; l++) {
            decos.push(lineCls(view.state.doc.line(l).from, 'cm-md-quote-line'))
          }
          break
        case 'TaskMarker': {
          if (onSelLine) break
          const listItem = node.node.parent
          const listMark = listItem?.getChild('ListMark')
          const replaceFrom = listMark ? listMark.from : from
          const checked = view.state.doc.sliceString(from, to).toLowerCase().includes('x')
          decos.push(Decoration.replace({ widget: new TaskCheckboxWidget(checked, line.from) }).range(replaceFrom, to))
          break
        }
        default: {
          // ATXHeading1..6 — sized headings; the HeaderMark was already
          // dimmed above.
          const m = /^ATXHeading(\d)$/.exec(name)
          if (m) decos.push(mark(from, to, `cm-md-h${m[1]}`))
        }
      }
    }
  })

  return Decoration.set(decos)
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
        changes: { from: sel.from, insert: edit.next.slice(sel.from) },
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
    overflow: 'auto'
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
 * Selection behavior mirrors NotchNotes: wrap commands select the inner
 * content (placeholder when nothing was selected), link selects the URL
 * when wrapping a label, and line commands select the whole block. */
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
      selection: { anchor: lineStart, head: lineStart + prefixed.length }
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
      selection:
        cmd === 'link'
          ? // Empty selection → select the label; wrapped label → select the URL.
            { anchor: selected ? start + inner.length + 3 : start + 1, head: start + 1 + (selected ? 3 : inner.length) }
          : { anchor: start + pre.length, head: start + pre.length + inner.length }
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
          markdown({ base: markdownLanguage }),
          history(),
          notesTheme,
          markdownDeco,
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
    // Restore the remembered caret and land straight in the editor.
    if (initialCaret != null && initialCaret <= view.state.doc.length) {
      view.dispatch({ selection: { anchor: initialCaret } })
    }
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
