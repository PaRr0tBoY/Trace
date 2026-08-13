// 临时验证：keyboardHook 状态机（SendInput 注入，无副作用——吞键模式）
// 手动套件（不进默认 npm test，注入真实按键有副作用）：
// npx vitest run --config vitest.manual.config.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import koffi from 'koffi'
import { startKeyboardHook, stopKeyboardHook } from '../electron/main/keyboardHook'

const user32 = koffi.load('user32.dll')
const INPUT = koffi.struct({
  type: 'uint32_t', pad: 'uint32_t',
  wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
  mouseTail: 'uintptr_t'
})
const sendInput = user32.func('SendInput', 'uint32_t', ['uint32_t', 'INPUT *', 'int'])
const KEYEVENTF_KEYUP = 0x0002
const INPUT_KEYBOARD = 0x0001
const VK_LMENU = 0xA4, VK_LSHIFT = 0xA0, VK_TAB = 0x09

function keyInput(vk: number, up: boolean) {
  return { type: INPUT_KEYBOARD, wVk: vk, wScan: 0, dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0n }
}
function chord(keys: [number, boolean][]) {
  sendInput(keys.length, keys.map(([vk, up]) => keyInput(vk, up)), koffi.sizeof(INPUT))
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function typeSequence(keys: Array<[number, boolean, number?]>) {
  for (const [vk, up, delay = 25] of keys) {
    sendInput(1, [keyInput(vk, up)], koffi.sizeof(INPUT))
    await sleep(delay)
  }
}

describe('keyboardHook Alt+Tab takeover', () => {
  const events: string[] = []
  beforeAll(() => {
    startKeyboardHook({
      onShow: ({ shiftDown }) => events.push(`show:${shiftDown ? 'shift' : 'plain'}`),
      onAdvance: (delta) => events.push(`advance:${delta}`),
      onExecute: () => events.push('execute')
    })
  })
  afterAll(() => stopKeyboardHook())

  it('plain Alt press: no events, no intervention', async () => {
    events.length = 0
    await typeSequence([[VK_LMENU, false], [VK_LMENU, true]])
    await sleep(150)
    expect(events).toEqual([])
  })

  it('Alt+Tab: show, tab repeat advances, release executes', async () => {
    events.length = 0
    // Tab held > TAP_THRESHOLD_MS (50): a real finger holds Tab ~80-120ms,
    // an injected 25ms tap would take the tap path and switch without UI.
    await typeSequence([
      [VK_LMENU, false],
      [VK_TAB, false, 80], [VK_TAB, true],
      [VK_TAB, false, 80], [VK_TAB, true],
      [VK_LMENU, true]
    ])
    await sleep(150)
    expect(events).toEqual(['show:plain', 'advance:1', 'execute'])
  })

  it('Shift+Alt+Tab: initial show with shift, then advances backwards', async () => {
    events.length = 0
    await typeSequence([
      [VK_LSHIFT, false], [VK_LMENU, false],
      [VK_TAB, false, 80], [VK_TAB, true],
      [VK_TAB, false, 80], [VK_TAB, true],
      [VK_LMENU, true], [VK_LSHIFT, true]
    ])
    await sleep(150)
    expect(events).toEqual(['show:shift', 'advance:-1', 'execute'])
  })

  it('reverse order (Tab before Alt): hook ignores, keys pass through', async () => {
    events.length = 0
    await typeSequence([[VK_TAB, false], [VK_TAB, true], [VK_LMENU, false], [VK_LMENU, true]])
    await sleep(150)
    expect(events).toEqual([])
  })
})
