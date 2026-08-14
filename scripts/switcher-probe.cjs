// Switcher repro probe — injects a full Alt+Tab→Enter(pin)→Alt-up→Esc gesture
// sequence via SendInput, driving the REAL hook + switcher in a running dev
// instance. Read the main-process logs after each phase to see where the
// chain breaks. Run: node scripts/switcher-probe.cjs <phase>
//
//   phase=show    Alt down, Tab down/up (hold past threshold) → switcher appears
//   phase=pin     Alt down, Tab hold, Enter (pin), Alt up → search mode + activation
//   phase=esc     Alt down, Tab hold, Enter, Alt up, then Esc after 600ms
//   phase=arrows  Alt down, Tab hold, Enter, Alt up, then Down arrow after 600ms
const koffi = require('koffi')

const VK_MENU = 0x12
const VK_TAB = 0x09
const VK_RETURN = 0x0d
const VK_ESCAPE = 0x1b
const VK_DOWN = 0x28
const VK_UP = 0x26
const KEYEVENTF_KEYUP = 0x0002
const INPUT_KEYBOARD = 0x0001

// x64 INPUT layout (see keyboardHook.ts): type(4) pad(4) wVk(2) wScan(2) dwFlags(4) time(4) dwExtraInfo(8) tail(8) = 40
const INPUT = koffi.struct('INPUT', {
  type: 'uint32_t',
  pad: 'uint32_t',
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
  mouseTail: 'uintptr_t'
})

const user32 = koffi.load('user32.dll')
const sendInput = user32.func('SendInput', 'uint32_t', ['uint32_t', 'INPUT *', 'int'])
const getForegroundWindow = user32.func('GetForegroundWindow', 'void *', [])
const getWindowTextW = user32.func('GetWindowTextW', 'int', ['void *', 'void *', 'int'])
const isWindow = user32.func('IsWindow', 'int', ['void *'])
const getSystemMetrics = user32.func('GetSystemMetrics', 'int', ['int'])
const setCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const mouseEvent = user32.func('void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, void* dwExtraInfo)')
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getWindowRect = user32.func('GetWindowRect', 'int', ['void *', 'void *'])

function windowRect(hwnd) {
  const buf = Buffer.alloc(16)
  getWindowRect(hwnd, buf)
  return { left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) }
}

function foregroundTitle() {
  const hwnd = getForegroundWindow()
  if (!hwnd) return '(null)'
  const buf = Buffer.alloc(512)
  const n = getWindowTextW(hwnd, buf, 256)
  const title = n > 0 ? buf.toString('utf16le', 0, n * 2) : '(no title)'
  return `${title} [hwnd=${hwnd}]`
}

function key(vk, up = false) {
  const input = {
    type: INPUT_KEYBOARD,
    pad: 0,
    wVk: vk,
    wScan: 0,
    dwFlags: up ? KEYEVENTF_KEYUP : 0,
    time: 0,
    dwExtraInfo: 0n,
    mouseTail: 0n
  }
  const n = sendInput(1, [input], koffi.sizeof(INPUT))
  console.log(`  injected vk=${vk.toString(16)} ${up ? 'UP' : 'down'} → sendInput=${n}`)
}

async function main() {
  const phase = process.argv[2] || 'show'
  console.log(`[probe] phase=${phase}`)

  key(VK_MENU)
  await sleep(80)
  key(VK_TAB)
  await sleep(350) // past TAP_THRESHOLD_MS(50) → armed → onShow
  key(VK_TAB, true)
  await sleep(150)

  if (phase === 'show') {
    console.log('[probe] holding — check logs for "[Switcher] show"')
    await sleep(2500)
    key(VK_MENU, true)
    return
  }

  key(VK_RETURN)
  await sleep(60)
  key(VK_RETURN, true)
  await sleep(150)
  console.log(`[probe] before Alt-up, foreground = ${foregroundTitle()}`)
  key(VK_MENU, true) // pin released → activatePanel
  await sleep(900)   // activation + simulated click + retry window
  console.log(`[probe] after Alt-up, foreground = ${foregroundTitle()}`)
  await sleep(400)
  console.log(`[probe] +400ms, foreground = ${foregroundTitle()}`)

  if (phase === 'esc') {
    console.log('[probe] sending Esc — expect "[Switcher] cancel (search Esc)"')
    key(VK_ESCAPE)
    await sleep(60)
    key(VK_ESCAPE, true)
    await sleep(1200)
  } else if (phase === 'arrows') {
    console.log('[probe] sending Down arrow — expect selection move via control-key')
    key(VK_DOWN)
    await sleep(60)
    key(VK_DOWN, true)
    await sleep(60)
    key(VK_DOWN)
    await sleep(60)
    key(VK_DOWN, true)
    await sleep(1200)
  } else if (phase === 'arrowpin') {
    // armed → Down arrow should pin AND move highlight (third search entry)
    console.log('[probe] armed, sending Down — expect pin + selection move')
    key(VK_DOWN)
    await sleep(60)
    key(VK_DOWN, true)
    await sleep(400)
    key(VK_MENU, true) // release Alt → pinReleased → panel activation
    await sleep(900)
    console.log(`[probe] after Alt-up, foreground = ${foregroundTitle()}`)
    key(VK_ESCAPE)
    await sleep(60)
    key(VK_ESCAPE, true)
    await sleep(600)
  } else if (phase === 'drillright') {
    // pinned → Right arrow should drill into a grouped row, Left exits
    key(VK_RIGHT)
    await sleep(60)
    key(VK_RIGHT, true)
    await sleep(500)
    console.log('[probe] sent Right in main list — expect drill-in (log/marker)')
    key(VK_LEFT)
    await sleep(60)
    key(VK_LEFT, true)
    await sleep(500)
    console.log('[probe] sent Left in drill — expect back to main list')
  } else if (phase === 'clickout') {
    // Click far outside the panel (screen center — panel is a left-edge
    // 384px blade). Expect "[Switcher] panel blurred — cancel session".
    const w = getSystemMetrics(0)
    const h = getSystemMetrics(1)
    const cx = Math.round(w / 2)
    const cy = Math.round(h / 2)
    const fg = getForegroundWindow()
    if (fg) {
      const r = windowRect(fg)
      console.log(`[probe] foreground rect = ${JSON.stringify(r)}, screen=${w}x${h}`)
      console.log(`[probe] click at (${cx}, ${cy}) is ${cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom ? 'INSIDE' : 'OUTSIDE'} the foreground window`)
    }
    console.log(`[probe] clicking outside at (${cx}, ${cy}) — expect blur → cancel`)
    setCursorPos(cx, cy)
    await sleep(50)
    mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, null)
    await sleep(30)
    mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, null)
    await sleep(800)
    console.log(`[probe] after click-outside, foreground = ${foregroundTitle()}`)
  }
  console.log('[probe] done')
}

main().catch((err) => {
  console.error('[probe] failed:', err)
  process.exit(1)
})
