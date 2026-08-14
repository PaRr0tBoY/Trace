/**
 * continueOnEnter — Enter-press continuation for the note editor: `1. `→`2. `,
 * `- `/`• `/`> `/todo markers carry to the next line — an empty marker still
 * continues (never drops on Enter), and an opening ``` fence at end of line
 * auto-closes with a blank line + fence.
 */
import { describe, expect, it } from 'vitest'
import { continueOnEnter } from '../src/components/notes/editorInput'

/** Simulate the continuation result for value with the caret at the end. */
const atEnd = (value: string) => continueOnEnter(value, value.length)

describe('continueOnEnter', () => {
  it('continues numbered lists with the next number', () => {
    expect(atEnd('1. first')).toEqual({ next: '1. first\n2. ', caret: 12 })
    expect(atEnd('9. ninth')).toEqual({ next: '9. ninth\n10. ', caret: 13 })
  })

  it('continues hyphen, bullet and quote markers unchanged', () => {
    expect(atEnd('- item')).toEqual({ next: '- item\n- ', caret: 9 })
    expect(atEnd('• item')).toEqual({ next: '• item\n• ', caret: 9 })
    expect(atEnd('> quote')).toEqual({ next: '> quote\n> ', caret: 10 })
  })

  it('carries todo markers', () => {
    expect(atEnd('- [ ] open')).toEqual({ next: '- [ ] open\n- [ ] ', caret: 17 })
    expect(atEnd('- [x] done')).toEqual({ next: '- [x] done\n- [x] ', caret: 17 })
  })

  it('continues an empty marker too (1. + Enter becomes 2., never vanishes)', () => {
    expect(atEnd('- ')).toEqual({ next: '- \n- ', caret: 5 })
    expect(atEnd('1. ')).toEqual({ next: '1. \n2. ', caret: 7 })
    expect(atEnd('> ')).toEqual({ next: '> \n> ', caret: 5 })
    expect(atEnd('before\n- ')).toEqual({ next: 'before\n- \n- ', caret: 12 })
    expect(atEnd('- [ ] ')).toEqual({ next: '- [ ] \n- [ ] ', caret: 13 })
  })

  it('auto-closes an opening fence at end of line', () => {
    expect(atEnd('```ts')).toEqual({ next: '```ts\n\n```', caret: 8 })
  })

  it('leaves Enter alone inside a code block', () => {
    expect(atEnd('```\ncode')).toBeNull()
  })

  it('leaves plain text alone but continues a marker even mid-line (whole-line check, like NotchNotes)', () => {
    expect(atEnd('plain text')).toBeNull()
    expect(continueOnEnter('- split', 3)).toEqual({ next: '- s\n- plit', caret: 6 })
  })
})
