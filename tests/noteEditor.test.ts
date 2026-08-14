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
import { flipTaskLine } from '../src/components/notes/editorInput'
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
