/**
 * MarkdownPreview — minimal Markdown → React renderer for note-card previews.
 *
 * Block level: headings, quotes, bullet / numbered / todo lists, fenced code,
 * paragraphs. Inline: **bold**, *italic*, ~~strike~~, `code`, [label](url).
 *
 * Output is plain React elements — note content is never injected as HTML.
 * Links render without href so a click inside a preview opens the editor
 * instead of navigating the panel. Intentional gaps vs full CommonMark:
 * no images, tables, nesting, or escape sequences.
 */
import { useMemo } from 'react'
import type { JSX, ReactNode } from 'react'

type InlinePart =
  | { kind: 'text' | 'bold' | 'italic' | 'strike' | 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const index = m.index
    if (index > last) parts.push({ kind: 'text', text: text.slice(last, index) })
    const token = m[0]
    if (token.startsWith('**')) parts.push({ kind: 'bold', text: token.slice(2, -2) })
    else if (token.startsWith('~~')) parts.push({ kind: 'strike', text: token.slice(2, -2) })
    else if (token.startsWith('*')) parts.push({ kind: 'italic', text: token.slice(1, -1) })
    else if (token.startsWith('`')) parts.push({ kind: 'code', text: token.slice(1, -1) })
    else {
      const close = token.indexOf('](')
      parts.push({ kind: 'link', text: token.slice(1, close), href: token.slice(close + 2, -1) })
    }
    last = index + token.length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return parseInline(text).map((part, i) => {
    const key = `${keyPrefix}-${i}`
    switch (part.kind) {
      case 'bold':
        return <strong key={key}>{part.text}</strong>
      case 'italic':
        return <em key={key}>{part.text}</em>
      case 'strike':
        return <s key={key}>{part.text}</s>
      case 'code':
        return <code key={key}>{part.text}</code>
      case 'link':
        return (
          <a key={key} className="md-link">
            {part.text}
          </a>
        )
      default:
        return part.text
    }
  })
}

/** Collect consecutive lines matching `re`, returning the match per line. */
function collectList(start: number, lines: string[], re: RegExp): RegExpExecArray[] {
  const items: RegExpExecArray[] = []
  for (let i = start; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (!m) break
    items.push(m)
  }
  return items
}

/** Block-starting prefixes — a paragraph ends where a new block begins. */
const BLOCK_START = /^(```|#{1,6}\s|>\s?|[-*]\s|\d+\.\s)/

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let blockIndex = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block.
    if (/^```/.test(line.trimStart())) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trimStart())) {
        buf.push(lines[i])
        i++
      }
      i++ // skip the closing fence
      blocks.push(
        <pre key={blockIndex++} className="md-code">
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const Tag = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'][heading[1].length - 1] as keyof JSX.IntrinsicElements
      blocks.push(
        <Tag key={blockIndex++} className="md-heading">
          {renderInline(heading[2], `h${blockIndex}`)}
        </Tag>
      )
      i++
      continue
    }

    // Quote — consecutive quoted lines merge into one blockquote.
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={blockIndex++} className="md-quote">
          {renderInline(buf.join(' '), `q${blockIndex}`)}
        </blockquote>
      )
      continue
    }

    // Bullet / todo list — a todo marker anywhere in the block makes it a
    // todo list (checked items render with a checkbox glyph).
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      const items = collectList(i, lines, /^[-*]\s+(.+)$/)
      const todos = items.map((m) => /^\[([ xX])\]\s+(.+)$/.exec(m[1]))
      const isTodo = todos.some((t) => t !== null)
      blocks.push(
        <ul key={blockIndex++} className={isTodo ? 'md-todo' : 'md-bullets'}>
          {items.map((m, j) => {
            const t = todos[j]
            if (t) {
              const done = t[1].toLowerCase() === 'x'
              return (
                <li key={j} className={done ? 'md-todo-done' : undefined}>
                  <span className="md-todo-box">{done ? '✓' : ''}</span>
                  {renderInline(t[2], `t${blockIndex}-${j}`)}
                </li>
              )
            }
            return <li key={j}>{renderInline(m[1], `u${blockIndex}-${j}`)}</li>
          })}
        </ul>
      )
      i += items.length
      continue
    }

    // Numbered list.
    if (/^\d+\.\s+/.test(line)) {
      const items = collectList(i, lines, /^\d+\.\s+(.+)$/)
      blocks.push(
        <ol key={blockIndex++} className="md-bullets">
          {items.map((m, j) => (
            <li key={j}>{renderInline(m[1], `o${blockIndex}-${j}`)}</li>
          ))}
        </ol>
      )
      i += items.length
      continue
    }

    // Blank line: paragraph separator.
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph — accumulate plain lines until a blank or a new block.
    const buf = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !BLOCK_START.test(lines[i])) {
      buf.push(lines[i])
      i++
    }
    blocks.push(
      <p key={blockIndex++} className="md-para">
        {renderInline(buf.join(' '), `p${blockIndex}`)}
      </p>
    )
  }

  return blocks
}

export function MarkdownPreview({ text }: { text: string }) {
  const blocks = useMemo(() => renderBlocks(text), [text])
  return <>{blocks}</>
}
