import { describe, expect, it } from 'vitest'
import { truncateUtf8, decodeOcrOutput, isOcrAllowed } from '../electron/main/ocr'

describe('truncateUtf8', () => {
  it('keeps text under the byte budget untouched', () => {
    expect(truncateUtf8('hello', 2048)).toBe('hello')
    expect(truncateUtf8('', 2048)).toBe('')
  })

  it('clips ASCII at the byte budget', () => {
    expect(truncateUtf8('abcdef', 3)).toBe('abc')
  })

  it('never splits a multi-byte CJK character', () => {
    // 每个中文字 3 字节：'中文测试' = 12 字节
    expect(truncateUtf8('中文测试', 9)).toBe('中文测')
    expect(truncateUtf8('中文测试', 8)).toBe('中文') // 9 字节处是字符边界，8 截到完整字符
  })

  it('handles zero and negative budgets', () => {
    expect(truncateUtf8('abc', 0)).toBe('')
    expect(truncateUtf8('abc', -1)).toBe('')
  })

  it('keeps a budget larger than the text', () => {
    expect(truncateUtf8('中文', 1000)).toBe('中文')
  })
})

describe('decodeOcrOutput', () => {
  it('decodes base64 UTF-8 text', () => {
    const encoded = Buffer.from('中文标题', 'utf8').toString('base64')
    expect(decodeOcrOutput(encoded)).toBe('中文标题')
  })

  it('trims surrounding whitespace/newlines from the PS pipe', () => {
    const encoded = Buffer.from('hello', 'utf8').toString('base64')
    expect(decodeOcrOutput(`\r\n${encoded}\r\n`)).toBe('hello')
  })

  it('returns empty for empty input', () => {
    expect(decodeOcrOutput('')).toBe('')
    expect(decodeOcrOutput('   ')).toBe('')
  })

  it('returns empty for garbage that is not base64', () => {
    expect(decodeOcrOutput('!!!not-base64!!!')).toBe('')
  })

  it('clips long results to the 2KB budget', () => {
    const long = '字'.repeat(3000) // 9000 字节
    const decoded = decodeOcrOutput(Buffer.from(long, 'utf8').toString('base64'))
    expect(Buffer.byteLength(decoded, 'utf8')).toBeLessThanOrEqual(2048)
    expect(decoded.length).toBe(Math.floor(2048 / 3)) // 完整字符数
  })
})

describe('isOcrAllowed', () => {
  const on = { taskCaptureEnabled: true, l0CaptureEnabled: true, incognito: false }

  it('allows capture when all three switches are on', () => {
    expect(isOcrAllowed(on)).toBe(true)
  })

  it('blocks when any switch is off', () => {
    expect(isOcrAllowed({ ...on, taskCaptureEnabled: false })).toBe(false)
    expect(isOcrAllowed({ ...on, l0CaptureEnabled: false })).toBe(false)
    expect(isOcrAllowed({ ...on, incognito: true })).toBe(false)
  })
})
