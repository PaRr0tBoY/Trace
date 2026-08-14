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

  it('continues a marker with content', () => {
    expect(enter('- foo', 5)).toEqual({ next: '- foo\n- ', caret: 8 })
    expect(enter('> quote', 7)).toEqual({ next: '> quote\n> ', caret: 10 })
  })

  it('continues an empty marker (bullet, ordered, quote behave the same)', () => {
    expect(enter('- ', 2)).toEqual({ next: '- \n- ', caret: 5 })
    expect(enter('1. ', 3)).toEqual({ next: '1. \n2. ', caret: 7 })
    expect(enter('> ', 2)).toEqual({ next: '> \n> ', caret: 5 })
  })

  it('continues a bare marker with no space yet', () => {
    expect(enter('-', 1)).toEqual({ next: '-\n- ', caret: 4 })
    expect(enter('1.', 2)).toEqual({ next: '1.\n2. ', caret: 6 })
    expect(enter('>', 1)).toEqual({ next: '>\n> ', caret: 4 })
  })

  it('exits on a second consecutive empty marker line', () => {
    expect(enter('- \n- ', 5)).toEqual({ next: '- \n', caret: 3 })
    expect(enter('1. \n2. ', 7)).toEqual({ next: '1. \n', caret: 4 })
    expect(enter('> \n> ', 5)).toEqual({ next: '> \n', caret: 3 })
  })

  it('continues an empty marker after a content line', () => {
    expect(enter('- foo\n- ', 8)).toEqual({ next: '- foo\n- \n- ', caret: 11 })
  })

  it('keeps indentation on continuation and exit', () => {
    expect(enter('  - ', 4)).toEqual({ next: '  - \n  - ', caret: 9 })
    expect(enter('  - \n  - ', 9)).toEqual({ next: '  - \n', caret: 5 })
  })

  it('does not treat different marker kinds as consecutive empties', () => {
    expect(enter('- \n> ', 5)).toEqual({ next: '- \n> \n> ', caret: 8 })
  })

  it('continues empty task markers and exits on a consecutive pair', () => {
    expect(enter('- [ ] ', 6)).toEqual({ next: '- [ ] \n- [ ] ', caret: 13 })
    expect(enter('- [ ] \n- [ ] ', 13)).toEqual({ next: '- [ ] \n', caret: 7 })
  })

  it('returns null for non-marker lines, glued content, and code blocks', () => {
    expect(enter('plain text', 5)).toBeNull()
    expect(enter('-foo', 4)).toBeNull()
    expect(enter('```\ncode', 8)).toBeNull()
  })
})

describe('markdown decoration builder', () => {
  const decorate = (doc: string) =>
    buildDecorations({
      state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] })
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
})
