/**
 * MarkdownPreview scope contract — the renderer must match the NotchNotes
 * MarkdownEngine feature set exactly: no blockquotes, no ~~strike~~, no
 * tables, no images, no LaTeX; bold/italic/boldItalic, inline code, links,
 * wiki links, bare URLs, headings, fenced code, lists, todos, and `---` are
 * rendered. Links carry no href (a click opens the editor, not a browser).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownPreview } from '../src/components/notes/markdown'

const html = (md: string) => renderToStaticMarkup(createElement(MarkdownPreview, { text: md }))

describe('MarkdownPreview inline scope', () => {
  it('renders bold, italic and bold-italic', () => {
    expect(html('**b** *i* ***bi***')).toBe(
      '<p class="md-para"><strong>b</strong> <em>i</em> <strong><em>bi</em></strong></p>'
    )
  })

  it('renders inline code', () => {
    expect(html('run `npm test` now')).toContain('<code>npm test</code>')
  })

  it('renders links without href', () => {
    expect(html('[label](https://a.b)')).toContain('<a class="md-link">label</a>')
  })

  it('renders wiki links as links', () => {
    expect(html('[[Meeting notes]]')).toContain('<a class="md-link">Meeting notes</a>')
  })

  it('links bare URLs, leaving trailing punctuation as text', () => {
    expect(html('see https://a.b/c, ok')).toContain('<a class="md-link">https://a.b/c</a>, ok')
  })

  it('keeps strike-through as plain text (NotchNotes does not render it)', () => {
    expect(html('~~gone~~')).toBe('<p class="md-para">~~gone~~</p>')
  })
})

describe('MarkdownPreview block scope', () => {
  it('renders headings', () => {
    expect(html('## Two')).toContain('<h2 class="md-heading">Two</h2>')
  })

  it('renders fenced code blocks', () => {
    expect(html('```ts\nconst x = 1\n```')).toContain('<pre class="md-code">')
    expect(html('```ts\nconst x = 1\n```')).toContain('const x = 1')
  })

  it('renders hyphen and bullet markers as lists', () => {
    expect(html('- one\n- two')).toContain('<ul class="md-bullets">')
    expect(html('• one\n• two')).toContain('<ul class="md-bullets">')
  })

  it('renders ordered lists', () => {
    expect(html('1. one\n2. two')).toContain('<ol class="md-bullets">')
  })

  it('renders todos with a done strike-through', () => {
    expect(html('- [ ] open\n- [x] done')).toContain('<li class="md-todo-done">')
  })

  it('renders horizontal rules', () => {
    expect(html('---')).toContain('<hr class="md-hr"/>')
  })

  it('keeps blockquote markers as plain text (NotchNotes does not render them)', () => {
    expect(html('> quoted')).toBe('<p class="md-para">&gt; quoted</p>')
  })
})
