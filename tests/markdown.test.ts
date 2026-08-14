/**
 * MarkdownPreview scope contract. Beyond NotchNotes' MarkdownEngine feature
 * set on purpose: blockquotes and ~~strike~~ ARE rendered (product request),
 * while tables/images/LaTeX stay absent; bold/italic/boldItalic, inline code,
 * links, wiki links, bare URLs, headings, fenced code, lists, todos, and
 * `---` are rendered. Links carry no href (a click opens the editor, not a
 * browser).
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

  it('renders links with an href', () => {
    expect(html('[label](https://a.b)')).toContain('<a class="md-link" href="https://a.b"')
  })

  it('renders wiki links as links', () => {
    expect(html('[[Meeting notes]]')).toContain('<a class="md-link">Meeting notes</a>')
  })

  it('links bare URLs, leaving trailing punctuation as text', () => {
    expect(html('see https://a.b/c, ok')).toContain('<a class="md-link" href="https://a.b/c" title="https://a.b/c">https://a.b/c</a>, ok')
  })

  it('renders strike-through as a deletion line', () => {
    expect(html('~~gone~~')).toBe('<p class="md-para"><s>gone</s></p>')
  })
  it('keeps consecutive paragraph lines on separate lines (<br/>)', () => {
    expect(html('line1\nline2')).toBe('<p class="md-para">line1<br/>line2</p>')
  })

  it('keeps a strike, a link and inline code on three lines separate', () => {
    const md = '~~gone~~\n[label](https://a.b)\n`code`'
    const out = html(md)
    expect(out).toContain('<s>gone</s>')
    expect(out).toContain('href="https://a.b"')
    expect(out).toContain('<code>code</code>')
    expect(out.match(/<br\/>/g)?.length).toBe(2)
  })

  it('renders multi-line backtick code as one code block', () => {
    expect(html('`line1\nline2`')).toBe('<p class="md-para"><code>line1\nline2</code></p>')
  })

  it('gives links an href and leaves wiki links inert', () => {
    expect(html('[label](https://a.b)')).toContain('href="https://a.b"')
    expect(html('[[wiki]]')).not.toContain('href=')
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

  it('renders blockquotes, merging consecutive lines into one block', () => {
    expect(html('> first\n> second')).toBe(
      '<blockquote class="md-quote"><p>first</p><p>second</p></blockquote>'
    )
  })

  it('renders an empty todo item with its checkbox', () => {
    expect(html('- [ ]\n- [x] done')).toContain('<ul class="md-todo">')
    expect(html('- [ ]\n- [x] done')).toContain('aria-checked="false"')
  })

  it('marks todo checkboxes as interactive toggles', () => {
    const done = html('- [x] done')
    expect(done).toContain('role="checkbox"')
    expect(done).toContain('aria-checked="true"')
    expect(html('- [ ] open')).toContain('aria-checked="false"')
  })
})
