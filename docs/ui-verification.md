# UI 验证：无头渲染器预览（勿动真机）

渲染层改动一律在**无头 Chromium 里加载构建产物**验证，不驱动用户正在运行的 Trace 实例：真机有单实例锁（`electron/main/index.ts`），第二实例起不来；即使能起，边缘热区 + 置顶心跳会抢用户真实桌面的鼠标和焦点，不可控。预览跑同一份 renderer 产物（`src/` 构建，无 Electron 壳），面板状态（打开、语言、任务/建议数据）全部由 `window.edge` 模拟桥注入——可复现、可断言，2026-08-13 起两轮 Settings/TaskEditor 打磨均用此法验收。

## 步骤（临时文件，验证完删除）

1. 根目录临时建 `vite.preview.config.mjs`（electron-vite 不需要，纯 vite + react 插件，`root: '.'`、alias `@renderer`→`src`/`@shared`→`shared`、`build.outDir: 'out/preview-renderer'`、rollup input = 根 `index.html`）。
2. 构建：`node node_modules/vite/bin/vite.js build --config vite.preview.config.mjs`（`.bin` shim 可能缺失，vite 必须这样直调）。`out/preview-renderer` 用任意静态文件服务器起（几十行 node http 即可）；index.html 的 CSP `script-src 'self'` 对构建产物天然兼容，不需要 dev server。
3. 浏览器工具开 `about:blank` → **注册好脚本再导航**：
   - `page.evaluateOnNewDocument(mockEdgeScript)`：模拟桥 = `window.edge = new Proxy(edge, { get: 未知方法返回 async no-op })`（store 里没 mock 到的调用自动静默降级）。数据面：`loadState` 返回 `{items, settings, version, tasks}`；**tasks/suggestions 还要经 `onTasks`/`onSuggestions` 回调推一次**（App.tsx 是订阅式收数，loadState 不带 suggestions）；`onCursorEdge(cb)` 用 `setInterval` ~120ms 发一次 `{x:1, y:innerHeight/2, stickPosition:'left', displayWidth:innerWidth}` 触发边缘热区保持面板打开。数据按验证目标现造（settings.language='zh-CN'、任务状态组合、L1/L2 建议等）。
   - **rAF pump**（第二个 evaluateOnNewDocument）：无头标签页 `document.hidden === true`，原生 `requestAnimationFrame` 可能完全不触发，Framer Motion 的退出动画卡死 → `AnimatePresence mode="wait"` 旧内容永不卸载（症状：点了新 tab，内容还是旧的）。把 `window.requestAnimationFrame` 重写为 16ms `setInterval` 手动泵。
   - `page.emulateMediaFeatures([{name:'prefers-reduced-motion', value:'reduce'}])`：tab 切换/面板收展的弹簧动画跳过 transform 后能确定性完成。
   - 加载后 `Page.bringToFront` + 连拍两张截图**强制合成器出帧**——否则后台标签页的 WAAPI/退出动画可能冻结不推进。
4. 验证以 **DOM 几何审计为主**（`getBoundingClientRect`/`getComputedStyle` 断言宽高、flexShrink、溢出、列数），比看截图精确、可输出数字；截图只作记录，且**必须按元素 rect 裁剪 clip 再截**（整页截图对超高元素会超时）。

## 坑（全部实测踩过）

- 浏览器工具标签页共享：同名校验标签**先 close 再 open**，否则上次会话注册的 evaluateOnNewDocument 还在，旧 mock 覆盖新 mock（症状：`edge.loadState.toString()` 是 `[native code]`、数据为空）。
- 徽章/计数混在 `textContent` 里，元素查找用 `includes` 别用全等。
- 临时产物零残留：验证完删 `vite.preview.config.mjs`、服务器脚本、`out/preview-renderer`，停掉 hub 进程；`.polish-*.png` 证据截图留给用户看后自删。
