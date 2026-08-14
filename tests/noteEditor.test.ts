/**
 * Note editor pure logic: task-line flipping (shared by the live editor's
 * checkbox widget and the preview toggle) and the markdown decoration
 * builder (must produce a sortable set for any input — RangeSet.of throws
 * when ranges arrive unsorted, e.g. multi-line blockquotes/fences).
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { EditorView } from '@codemirror/view'
import { continueOnEnter, flipTaskLine } from '../src/components/notes/editorInput'
import { buildDecorations } from '../src/components/notes/markdownEditor'

describe('flipTaskLine', () => {
  it('flips an unchecked task to checked, keeping the closing bracket', () => {
    expect(flipTaskLine('- [ ] buy milk')).toBe('- [x] buy milk')
  })

  it('flips a checked task to unchecked', () => {
    expect(flipTaskLine('- [x] done')).toBe('- [ ] done')
  })

  it('keeps indentation and bullet style', () => {
    expect(flipTaskLine('  * [x] indented')).toBe('  * [ ] indented')
    expect(flipTaskLine('• [ ] bullet')).toBe('• [x] bullet')
  })

  it('handles an empty task with no trailing text', () => {
    expect(flipTaskLine('- [x]')).toBe('- [ ]')
    expect(flipTaskLine('- [ ]')).toBe('- [x]')
  })

  it('returns null for non-task lines', () => {
    expect(flipTaskLine('- plain bullet')).toBeNull()
    expect(flipTaskLine('- [x broken bracket')).toBeNull()
    expect(flipTaskLine('> quote')).toBeNull()
    expect(flipTaskLine('')).toBeNull()
  })
})

describe('continueOnEnter', () => {
  const enter = (doc: string, caret: number) => continueOnEnter(doc, caret)

  /** Apply the returned change exactly like enterContinuation's dispatch. */
  const apply = (doc: string, e: NonNullable<ReturnType<typeof continueOnEnter>>) =>
    doc.slice(0, e.from) + e.insert + doc.slice(e.to)

  it('continues a marker with content', () => {
    expect(enter('- foo', 5)).toEqual({ from: 5, to: 5, insert: '\n- ', caret: 8 })
    expect(enter('> quote', 7)).toEqual({ from: 7, to: 7, insert: '\n> ', caret: 10 })
    // Two-digit ordered markers increment without dropping the width.
    expect(enter('9. ninth', 8)).toEqual({ from: 8, to: 8, insert: '\n10. ', caret: 13 })
  })

  it('continues mid-line (marker stays, the line splits)', () => {
    expect(enter('- split', 3)).toEqual({ from: 3, to: 3, insert: '\n- ', caret: 6 })
  })

  it('auto-closes an opening fence at end of line', () => {
    expect(enter('```ts', 5)).toEqual({ from: 5, to: 5, insert: '\n\n```', caret: 8 })
  })

  it('continues an empty marker (bullet, ordered, quote behave the same)', () => {
    expect(enter('- ', 2)).toEqual({ from: 2, to: 2, insert: '\n- ', caret: 5 })
    expect(enter('1. ', 3)).toEqual({ from: 3, to: 3, insert: '\n2. ', caret: 7 })
    expect(enter('> ', 2)).toEqual({ from: 2, to: 2, insert: '\n> ', caret: 5 })
  })

  it('continues a bare marker with no space yet', () => {
    expect(enter('-', 1)).toEqual({ from: 1, to: 1, insert: '\n- ', caret: 4 })
    expect(enter('1.', 2)).toEqual({ from: 2, to: 2, insert: '\n2. ', caret: 6 })
    expect(enter('>', 1)).toEqual({ from: 1, to: 1, insert: '\n> ', caret: 4 })
  })

  it('exits on a second consecutive empty marker line — the change deletes the line', () => {
    expect(enter('- \n- ', 5)).toEqual({ from: 3, to: 5, insert: '', caret: 3 })
    expect(enter('1. \n2. ', 7)).toEqual({ from: 4, to: 7, insert: '', caret: 4 })
    expect(enter('> \n> ', 5)).toEqual({ from: 3, to: 5, insert: '', caret: 3 })
  })

  it('exit change applied to the document really removes the second marker line', () => {
    const doc = '- [ ] \n- [ ] '
    const edit = enter(doc, doc.length)!
    expect(apply(doc, edit)).toBe('- [ ] \n')
    expect(edit.caret).toBe('- [ ] \n'.length)
  })

  it('continues an empty marker after a content line', () => {
    expect(enter('- foo\n- ', 8)).toEqual({ from: 8, to: 8, insert: '\n- ', caret: 11 })
  })

  it('keeps indentation on continuation and exit', () => {
    expect(enter('  - ', 4)).toEqual({ from: 4, to: 4, insert: '\n  - ', caret: 9 })
    expect(enter('  - \n  - ', 9)).toEqual({ from: 5, to: 9, insert: '', caret: 5 })
  })

  it('does not treat different marker kinds as consecutive empties', () => {
    expect(enter('- \n> ', 5)).toEqual({ from: 5, to: 5, insert: '\n> ', caret: 8 })
  })

  it('continues empty task markers and exits on a consecutive pair', () => {
    expect(enter('- [ ] ', 6)).toEqual({ from: 6, to: 6, insert: '\n- [ ] ', caret: 13 })
    expect(enter('- [ ] \n- [ ] ', 13)).toEqual({ from: 7, to: 13, insert: '', caret: 7 })
  })

  it('returns null for non-marker lines, glued content, and code blocks', () => {
    expect(enter('plain text', 5)).toBeNull()
    expect(enter('-foo', 4)).toBeNull()
    expect(enter('```\ncode', 8)).toBeNull()
  })
})

describe('markdown decoration builder', () => {
  const decorate = (doc: string, anchor = 0, head?: number) =>
    buildDecorations({
      state: EditorState.create({
        doc,
        selection: { anchor, head: head ?? anchor },
        extensions: [markdown({ base: markdownLanguage })]
      })
    } as unknown as EditorView)

  it('builds decorations for a multi-line blockquote without throwing', () => {
    const set = decorate('> first\n> second\n\nplain')
    expect(set.size).toBeGreaterThan(0)
  })

  it('builds decorations for a fenced code block with trailing content', () => {
    const set = decorate('```\ncode\n```\n\n- [x] done')
    expect(set.size).toBeGreaterThan(0)
  })

  it('builds decorations for malformed task text (missing closing bracket)', () => {
    const set = decorate('- [x  123')
    expect(set.size).toBeGreaterThan(0)
  })

  it('renders block markers as widgets while the caret is away, reveals on the caret line', () => {
    const replaceCount = (doc: string, anchor = 0) => {
      let n = 0
      decorate(doc, anchor).between(0, doc.length, (_f, _t, value) => {
        if (value.spec.widget) n++
      })
      return n
    }
    // Caret on a different line → the marker renders as a widget.
    expect(replaceCount('plain\n# title')).toBe(1)
    expect(replaceCount('plain\n> quote')).toBe(1)
    expect(replaceCount('plain\n- item')).toBe(1)
    // Task lines render the checkbox but no bullet (2 widgets: hidden
    // ListMark + checkbox).
    expect(replaceCount('plain\n- [ ] task')).toBe(2)
    // Caret on the marker line → raw marker revealed, no widgets.
    expect(replaceCount('# title', 3)).toBe(0)
    expect(replaceCount('> quote', 3)).toBe(0)
    expect(replaceCount('- item', 3)).toBe(0)
    expect(replaceCount('- [ ] task', 3)).toBe(0)
    // Bare markers (no space yet) never render, wherever the caret is.
    expect(replaceCount('plain\n#title')).toBe(0)
    expect(replaceCount('plain\n>quote')).toBe(0)
    expect(replaceCount('plain\n-')).toBe(0)
  })

  it('hides inline markers when the caret is away, reveals them while editing the construct', () => {
    const replaceCount = (doc: string, anchor = 0, head?: number) => {
      let n = 0
      decorate(doc, anchor, head).between(0, doc.length, (_f, _t, value) => {
        if (value.spec.widget) n++
      })
      return n
    }
    // Caret inside the marked content → both markers revealed.
    expect(replaceCount('**bold**', 4)).toBe(0)
    expect(replaceCount('*italic*', 4)).toBe(0)
    expect(replaceCount('~~strike~~', 4)).toBe(0)
    expect(replaceCount('`code`', 3)).toBe(0)
    expect(replaceCount('[label](url)', 4)).toBe(0)
    // Caret at a marker edge / inside the marker → revealed.
    expect(replaceCount('**bold**', 0)).toBe(0)
    expect(replaceCount('**bold**', 2)).toBe(0)
    // A selection spanning the marker reveals it too.
    expect(replaceCount('**bold**', 0, 4)).toBe(0)
    // Caret outside the construct → rendered hidden again.
    expect(replaceCount('**bold**\n\nplain', 11)).toBe(2)
    expect(replaceCount('*italic*\n\nplain', 11)).toBe(2)
    expect(replaceCount('~~strike~~\n\nplain', 13)).toBe(2)
    expect(replaceCount('`code`\n\nplain', 9)).toBe(2)
    // `[label](url)` parses to 4 LinkMarks + URL.
    expect(replaceCount('[label](url)\n\nplain', 15)).toBe(5)
    // Unparsed / plain text stays visible.
    expect(replaceCount('*half-open', 4)).toBe(0)
    expect(replaceCount('plain', 4)).toBe(0)
  })
})
