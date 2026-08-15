// mouse-hook-count-host.cjs — 诊断用最小计数宿主:装 WH_MOUSE_LL + 4ms 泵,
// 计数穿越全局 LL 钩子链的 WM_MOUSEMOVE / WM_LBUTTONDOWN,并按需快照回报。
// 仅由 mouse-hook-lifecycle-probe.cjs fork,不参与应用运行。
const koffi = require('koffi')

const WH_MOUSE_LL = 14
const PM_REMOVE = 0x0001
const WM_MOUSEMOVE = 0x0200
const WM_LBUTTONDOWN = 0x0201

const user32 = koffi.load('user32.dll')
const MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
  pt_x: 'int32_t', pt_y: 'int32_t', mouseData: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t'
})
const MSG = koffi.struct('MSG', {
  hwnd: 'void *', message: 'uint32_t', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32_t', pt_x: 'int32_t', pt_y: 'int32_t'
})
const hookProto = koffi.proto('intptr_t (int nCode, uintptr_t wParam, intptr_t lParam)')
const SetWindowsHookExW = user32.func('SetWindowsHookExW', 'void *', ['int', koffi.pointer(hookProto), 'void *', 'uint32_t'])
const UnhookWindowsHookEx = user32.func('UnhookWindowsHookEx', 'int', ['void *'])
const CallNextHookEx = user32.func('CallNextHookEx', 'intptr_t', ['void *', 'int', 'uintptr_t', 'intptr_t'])
const PeekMessageW = user32.func('PeekMessageW', 'int', [koffi.pointer(MSG), 'void *', 'uint32_t', 'uint32_t', 'uint32_t'])

let moves = 0
let downs = 0
let hookPtr = null
// lParam 必须原样转发给链上的下一个钩子:传 0 会破坏后续钩子对事件结构的
// 解码(下游钩子可能因此把事件当垃圾丢弃)。
const cb = koffi.register((nCode, wParam, lParam) => {
  if (nCode >= 0) {
    if (wParam === WM_LBUTTONDOWN) downs++
    else if (wParam === WM_MOUSEMOVE) moves++
  }
  return CallNextHookEx(hookPtr, nCode, wParam, lParam)
}, koffi.pointer(hookProto))

const pumpMsg = { hwnd: null, message: 0, wParam: 0n, lParam: 0n, time: 0, pt_x: 0, pt_y: 0 }
hookPtr = SetWindowsHookExW(WH_MOUSE_LL, cb, null, 0)
process.parentPort?.postMessage({ type: 'ready', installed: !!hookPtr })
setInterval(() => {
  let n = 0
  while (PeekMessageW(pumpMsg, null, 0, 0, PM_REMOVE) && n++ < 64) { /* dispatch */ }
}, 4)

process.parentPort?.on('message', (e) => {
  if (e.data?.type === 'snap') {
    process.parentPort?.postMessage({ type: 'snap', moves, downs })
  } else if (e.data?.type === 'stop') {
    if (hookPtr) UnhookWindowsHookEx(hookPtr)
    process.exit(0)
  }
})
