/**
 * continueOnEnter — Enter-press continuation for the note editor, mirroring
 * NotchNotes' input behavior. Returns the edit to apply, or null when Enter
 * keeps its default behavior (inside a code block, or not on a list / quote
 * / fence line).
 *
 * - `1. ` → `2. `, `- `/`• `/`> `/todo markers carry to the next line
 * - an empty item drops its marker (exits the list)
 * - an opening ``` fence at end of line auto-closes with a blank line + fence
 */

/** Replace [start,end) with the given text, keeping the cursor after it. */
function splice(value: string, start: number, end: number, next: string): string {
  return value.slice(0, start) + next + value.slice(end)
}

export function continueOnEnter(value: string, caret: number): { next: string; caret: number } | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1
  const nlAt = value.indexOf('\n', caret)
  const lineEnd = nlAt === -1 ? value.length : nlAt
  const line = value.slice(lineStart, lineEnd)
  const atLineEnd = nlAt === -1 || caret === lineEnd
  const fencesBefore = (value.slice(0, lineStart).match(/^```/gm) ?? []).length
  if (fencesBefore % 2 === 1) return null // inside a code block

  if (atLineEnd && /^```\w*$/.test(line)) {
    return { next: splice(value, caret, caret, '\n\n```'), caret: caret + 3 }
  }

  const m = /^(\s*)((?:\d+)\.|[-•]|>)(\s+\[[ xX]\])?(\s+)(.*)$/.exec(line)
  if (!m) return null
  const [, indent, marker, checkbox, space, rest] = m
  if (rest.trim() === '') {
    const markerEnd = lineStart + indent.length + marker.length + (checkbox ? checkbox.length + space.length : space.length)
    return { next: value.slice(0, lineStart) + value.slice(markerEnd), caret: lineStart }
  }
  const num = /^\d+\.$/.test(marker) ? Number(marker.slice(0, -1)) : null
  const continuation = num !== null ? `${indent}${num + 1}. ` : checkbox ? `${indent}${marker}${checkbox} ` : `${indent}${marker} `
  return { next: splice(value, caret, caret, '\n' + continuation), caret: caret + continuation.length + 1 }
}
