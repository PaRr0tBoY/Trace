/**
 * continueOnEnter — Enter-press continuation for the note editor. Returns a
 * change to apply (from/to/insert + resulting caret), or null when Enter
 * keeps its default behavior (inside a code block, or not on a list / quote
 * / fence line).
 *
 * - `1. ` → `2. `, `- `/`• `/`> `/todo markers carry to the next line
 * - a bare marker (`-`, `1.`, `>` alone at end of line) also continues —
 *   the marker is never dropped by Enter, so starting a list is one keystroke
 * - an EMPTY marker continues too (`- ` + Enter → `- `) — a list only ends
 *   when a second consecutive empty marker line gets Enter (same behavior
 *   for quotes and numbered lists, so `- ` and `> ` behave identically)
 * - an opening ``` fence at end of line auto-closes with a blank line + fence
 */

/** Flip a task-line marker (`- [x] …` ↔ `- [ ] …`). Returns the flipped line,
 * or null when the line is not a task. Shared by the live editor's checkbox
 * widget and the preview-mode toggle, so both always produce the same well-
 * formed `[ ]` / `[x]` bracket pair. */
export function flipTaskLine(line: string): string | null {
  const m = /^(\s*[-*•]\s+)\[([ xX])\](.*)$/.exec(line)
  if (!m) return null
  const [, prefix, mark, rest] = m
  return `${prefix}[${mark.toLowerCase() === 'x' ? ' ' : 'x'}]${rest}`
}

/** `-`/`•`/`*` → 'ul', `1.` → 'ol', `>` → 'quote'. */
function markerKind(marker: string): 'ul' | 'ol' | 'quote' {
  if (/^\d+\.$/.test(marker)) return 'ol'
  if (marker === '>') return 'quote'
  return 'ul'
}

/** Marker line grammar shared by the continuation and exit checks. */
const MARKER_LINE = /^(\s*)((?:\d+)\.|[-•]|>)(\s+\[[ xX]\])?(\s*)(.*)$/

export function continueOnEnter(
  value: string,
  caret: number
): { from: number; to: number; insert: string; caret: number } | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1
  const nlAt = value.indexOf('\n', caret)
  const lineEnd = nlAt === -1 ? value.length : nlAt
  const line = value.slice(lineStart, lineEnd)
  const atLineEnd = nlAt === -1 || caret === lineEnd
  const fencesBefore = (value.slice(0, lineStart).match(/^```/gm) ?? []).length
  if (fencesBefore % 2 === 1) return null // inside a code block

  if (atLineEnd && /^```\w*$/.test(line)) {
    return { from: caret, to: caret, insert: '\n\n```', caret: caret + 3 }
  }

  const m = MARKER_LINE.exec(line)
  if (!m) return null
  const [, indent, marker, checkbox, space, rest] = m
  const kind = markerKind(marker)
  // `-foo` / `1.foo`: content glued to the marker is not a list.
  if (space === '' && rest !== '') return null
  const num = kind === 'ol' ? Number(marker.slice(0, -1)) : null
  const continuation =
    num !== null ? `${indent}${num + 1}. ` : checkbox ? `${indent}${marker}${checkbox} ` : `${indent}${marker} `

  // Empty marker line (bare or trailing space, nothing else):
  //   - previous line is the same kind of empty marker → exit the
  //     list/quote (drop the marker, cursor to line start)
  //   - otherwise continue with a fresh marker
  if (rest.trim() === '' && atLineEnd && lineStart > 0) {
    const prevStart = value.lastIndexOf('\n', lineStart - 2) + 1
    const prevLine = value.slice(prevStart, lineStart - 1)
    const prevM = MARKER_LINE.exec(prevLine)
    if (prevM && markerKind(prevM[2]) === kind && prevM[5].trim() === '') {
      return { from: lineStart, to: lineEnd, insert: '', caret: lineStart }
    }
  }

  return { from: caret, to: caret, insert: '\n' + continuation, caret: caret + continuation.length + 1 }
}
