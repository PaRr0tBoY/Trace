// mouse-hook-lifecycle-probe.cjs — 手动 E2E 探针:验证 WH_MOUSE_LL 钩子的
// 按需安装/卸载语义(click-outside 快速关闭功能的红线回归)。
//
// 运行前先 `npm run build`(需要 out/main/hookHost.js 真实产物):
//   node_modules\electron\dist\electron.exe scripts\mouse-hook-lifecycle-probe.cjs
//
// 四个阶段:
//   0 未开面板(宿主刚 fork, 钩子未装)  → 注入点击 → 期望 0 条 mouse-down
//   1 panel-open  (钩子安装)            → 注入点击 → 期望 1 条
//   2 panel-close (钩子卸载)            → 注入点击 → 期望仍 1 条(零遍历)
//   3 再次 panel-open(钩子重装)         → 注入点击 → 期望 2 条
//
// 注入布局说明(重要):SendInput 的 INPUT 是联合体,x64 下 union 偏移 8:
//   type(0..3) pad(4..7) union(8..39)。
//   KEYBDINPUT: wVk(8) wScan(10) dwFlags(12) time(16) dwExtraInfo(24)
//   MOUSEINPUT: dx(8) dy(12) mouseData(16) dwFlags(20) time(24) dwExtraInfo(28)
// 同一个 dwFlags 槽在两种输入里偏移不同(12 vs 20)。用键盘布局发鼠标事件
// 会把 LEFTDOWN(2) 写进 dy 槽,实际注入的是 2 像素移动而非点击——此前的
// "点击注入"全是移动,phase-1 的唯一汇报来自探针窗口期内用户的真实点击。
// 因此鼠标与键盘各用逐槽对应的专用结构体,且 down/up 之间留 50ms 间隔
// (真实点击不会同帧 down+up)。
//
// count-host(mouse-hook-count-host.cjs)全程存活并快照计数 LBUTTONDOWN,
// 为每个阶段提供"点击确实穿越了全局 LL 钩子链"的独立通道证据——这让
// phase-2 的"零汇报"成为非空洞断言(链上有计数、宿主静默),而不是
// "注入根本没进系统"。
//
// 点击注入落在探针自己的常驻置顶窗口上,不触碰用户其他应用;
// 探针结束后恢复光标原位。所有断言写入结果 JSON 并以退出码表达。
const { app, BrowserWindow, utilityProcess } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')

// 键盘 INPUT —— 与 x64 KEYBDINPUT 逐槽对应(dwExtraInfo 需 8 对齐 → 偏移 24)。
const KEY_INPUT = koffi.struct('PROBE_KEY_INPUT', {
  type: 'uint32_t', pad: 'uint32_t', wVk: 'uint16_t', wScan: 'uint16_t',
  dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t', tail: 'uintptr_t'
})
// 鼠标 INPUT —— 与 x64 MOUSEINPUT 逐槽对应(dwFlags 在偏移 20,不是 12!）。
const MOUSE_INPUT = koffi.struct('PROBE_MOUSE_INPUT', {
  type: 'uint32_t', pad: 'uint32_t', dx: 'int32_t', dy: 'int32_t',
  mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t'
})
// koffi 的 .func 第一个参数是 DLL 导出符号名,不能起别名——同一 SendInput
// 按参数类型(键盘/鼠标 INPUT 指针)分别绑定。
const SendKeyInput = user32.func('SendInput', 'uint32_t', ['uint32_t', koffi.pointer(KEY_INPUT), 'int'])
const SendMouseInput = user32.func('SendInput', 'uint32_t', ['uint32_t', koffi.pointer(MOUSE_INPUT), 'int'])
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int32_t', 'int32_t'])
const GetCursorPos = user32.func('GetCursorPos', 'int', ['void *'])

const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const KEYEVENTF_KEYUP = 0x0002
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1

const POS = { x: 0, y: 0 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 注入一次真实点击:定位 → down → 50ms → up。返回 SendInput 返回值(0 = 失败)。 */
async function injectClick(x, y) {
  SetCursorPos(x, y)
  await sleep(30)
  const mk = () => ({ type: INPUT_MOUSE, pad: 0, dx: 0, dy: 0, mouseData: 0, dwFlags: 0, time: 0, dwExtraInfo: 0n })
  const down = mk(); down.dwFlags = MOUSEEVENTF_LEFTDOWN
  const downRet = SendMouseInput(1, [down], koffi.sizeof(MOUSE_INPUT))
  await sleep(50)
  const up = mk(); up.dwFlags = MOUSEEVENTF_LEFTUP
  const upRet = SendMouseInput(1, [up], koffi.sizeof(MOUSE_INPUT))
  return { downRet, upRet }
}

const resultPath = path.join(os.tmpdir(), 'mouse-hook-lifecycle-result.json')
const phases = []
// 模块级声明:finish() 与 watchdog 都要访问这些变量,声明在 whenReady 回调
// 内会导致 finish 闭包失效(ReferenceError)以及 TDZ 崩溃(历史上两次挂起的根因)。
const childLogs = []
const allChildren = []
let watchdogTimer = null

function record(name, ok, detail) {
  phases.push({ phase: name, ok, ...detail })
}

function finish(exitCode) {
  if (watchdogTimer) clearTimeout(watchdogTimer)
  try { for (const c of allChildren) { try { c.kill() } catch {} } } catch {}
  try {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: exitCode === 0, phases, childLogs: childLogs.join('').split('\n').filter(Boolean) }, null, 2))
  } catch (err) {
    // last resort — the exit code still carries the verdict
  }
  app.exit(exitCode)
}

app.whenReady().then(async () => {
  // 记录光标位置,结束后恢复
  try {
    const buf = Buffer.alloc(8)
    GetCursorPos(buf)
    POS.x = buf.readInt32LE(0)
    POS.y = buf.readInt32LE(4)
  } catch { /* best effort */ }

  let win = null
  try {
    win = new BrowserWindow({ width: 160, height: 120, x: 8, y: 8, show: true, alwaysOnTop: true, focusable: true })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.loadURL('about:blank')
  } catch (err) {
    record('exception', false, { error: 'window create failed: ' + String(err) })
    finish(1)
    return
  }

  const hostPath = path.join(__dirname, '..', 'out', 'main', 'hookHost.js')
  if (!fs.existsSync(hostPath)) {
    record('preflight', false, { error: `hookHost.js not built: ${hostPath} — run npm run build first` })
    finish(1)
    return
  }

  let child = null
  try {
    child = utilityProcess.fork(hostPath, [], { serviceName: 'mouse-hook-probe-host', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    record('exception', false, { error: 'fork failed: ' + String(err) })
    finish(1)
    return
  }
  allChildren.push(child)
  let mouseDowns = 0
  let kbMessages = 0
  let childSpawned = false
  let childExitCode = null
  child.on('spawn', () => { childSpawned = true })
  child.on('exit', (code) => { childExitCode = code })
  if (child.stdout) child.stdout.on('data', (d) => childLogs.push(String(d)))
  if (child.stderr) child.stderr.on('data', (d) => childLogs.push(String(d)))
  child.on('message', (m) => {
    if (m && m.type === 'mouse-down') mouseDowns++
    if (m && (m.type === 'show' || m.type === 'tap' || m.type === 'advance')) kbMessages++
  })

  const waitFor = async (ms) => sleep(ms)

  // Watchdog: whatever happens, write partial evidence, kill every child and
  // exit — a hung probe must never leave an orphaned global hook throttling
  // the user's real input.
  watchdogTimer = setTimeout(() => {
    record('watchdog-timeout', false, { phasesSoFar: phases.length })
    finish(2)
  }, 30000)

  function injectAltTab() {
    // Alt down → Tab down/up → Alt up: the hook swallows the Tab and posts
    // show/tap — proves the child process, keyboard hook and pump are alive.
    const key = (vk, flags) => ({ type: INPUT_KEYBOARD, pad: 0, wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0n, tail: 0n })
    SendKeyInput(1, [key(0x12, 0)], koffi.sizeof(KEY_INPUT))
    SendKeyInput(1, [key(0x09, 0)], koffi.sizeof(KEY_INPUT))
    SendKeyInput(1, [key(0x09, KEYEVENTF_KEYUP)], koffi.sizeof(KEY_INPUT))
    SendKeyInput(1, [key(0x12, KEYEVENTF_KEYUP)], koffi.sizeof(KEY_INPUT))
  }

  try {
    await waitFor(1200) // host boots + hook pump up

    // 阶段 0: 面板从未打开 — 钩子未安装,点击无汇报
    const ret0 = await injectClick(88, 68)
    await waitFor(600)
    record('phase-0-closed-no-report', mouseDowns === 0, { mouseDowns, ...ret0 })

    // 注入通道 sanity check: 独立计数宿主验证"注入的 LBUTTONDOWN 会穿越
    // 全局 LL 鼠标钩子链"(排除探针注入方法本身的疑点)。count-host 全程存活,
    // 后续每个阶段的 delta 都是"点击确实进了系统"的独立证据。
    const countHostPath = path.join(__dirname, 'mouse-hook-count-host.cjs')
    let countHost = null
    try {
      countHost = utilityProcess.fork(countHostPath, [], {
        serviceName: 'mouse-hook-count-host',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') }
      })
    } catch (err) {
      record('exception', false, { error: 'count-host fork failed: ' + String(err) })
      finish(1)
      return
    }
    allChildren.push(countHost)
    const countLogs = []
    if (countHost.stdout) countHost.stdout.on('data', (d) => countLogs.push(String(d)))
    if (countHost.stderr) countHost.stderr.on('data', (d) => countLogs.push(String(d)))
    let countReady = false
    let lastSnap = { moves: 0, downs: 0 }
    countHost.on('message', (m) => {
      if (m && m.type === 'ready') countReady = !!m.installed
      if (m && m.type === 'snap') lastSnap = { moves: m.moves, downs: m.downs }
    })
    const snapshot = async () => {
      try { countHost.postMessage({ type: 'snap' }) } catch {}
      await waitFor(120)
      return { ...lastSnap }
    }
    await waitFor(600)

    const snapPre = await snapshot()
    const retS = await injectClick(100, 68)
    await waitFor(600)
    const snapPost = await snapshot()
    record('inject-traverses-ll-hook', countReady && snapPost.downs - snapPre.downs >= 1, {
      countReady,
      downsDelta: snapPost.downs - snapPre.downs,
      movesDelta: snapPost.moves - snapPre.moves,
      ...retS,
      countLogs: countLogs.join('').slice(-300)
    })

    // 键盘链路 sanity check: 宿主/键盘钩子/泵是否活着
    const kbBefore = kbMessages
    injectAltTab()
    await waitFor(500)
    record('kb-hook-alive', kbMessages >= kbBefore + 1, { kbMessages, childSpawned, childExitCode, childLogs: childLogs.join('').slice(-500) })

    // 阶段 1: panel-open → 钩子安装 → 点击被汇报
    child.postMessage({ type: 'panel-open' })
    await waitFor(400)
    const snap1Pre = await snapshot()
    const ret1 = await injectClick(112, 68)
    await waitFor(600)
    const snap1Post = await snapshot()
    record('phase-1-open-reports', mouseDowns === 1, { mouseDowns, downsDelta: snap1Post.downs - snap1Pre.downs, ...ret1 })

    // 阶段 2: panel-close → 钩子卸载 → 点击零遍历(但 count-host 证明点击进了系统)
    child.postMessage({ type: 'panel-close' })
    await waitFor(400)
    const snap2Pre = await snapshot()
    const ret2 = await injectClick(124, 68)
    await waitFor(600)
    const snap2Post = await snapshot()
    record('phase-2-closed-no-report-again', mouseDowns === 1, { mouseDowns, downsDelta: snap2Post.downs - snap2Pre.downs, ...ret2 })

    // 阶段 3: 再次 panel-open → 钩子重装 → 点击恢复汇报
    child.postMessage({ type: 'panel-open' })
    await waitFor(400)
    const snap3Pre = await snapshot()
    const ret3 = await injectClick(136, 68)
    await waitFor(600)
    const snap3Post = await snapshot()
    record('phase-3-reopen-reports', mouseDowns === 2, { mouseDowns, downsDelta: snap3Post.downs - snap3Pre.downs, ...ret3 })
    // 迟到汇报检查:链上若有未响应的钩子,汇报可能延迟到达
    await waitFor(1000)
    record('phase-3-late-check', mouseDowns === 2, { mouseDowns })

    try { countHost.postMessage({ type: 'stop' }) } catch {}
    await waitFor(200)
  } catch (err) {
    record('exception', false, { error: String(err) + '\n' + (err && err.stack || '') })
  }

  // 恢复光标
  try { SetCursorPos(POS.x, POS.y) } catch { /* best effort */ }
  if (child) { try { child.kill() } catch {} }
  finish(phases.every((p) => p.ok) ? 0 : 1)
})
