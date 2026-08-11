# AGENTS.md

## 项目身份

**Trace** — 悬停在屏幕左边缘、hover 展开的剪贴板管理器（原 Edge-Drop，已 rebrand）。零点击交互，支持原生 OLE 拖拽到任意桌面应用。

- **平台**：仅 Windows（Win32 OLE 拖拽、PowerShell HDROP 解析、透明窗口光标轮询、koffi FFI）
- **技术栈**：Electron 34 · React 18 · TypeScript 5 · Framer Motion 11 · Zustand 4 · electron-vite · vitest；koffi 用于全屏检测与剪贴板格式读取（upstream 引入）
- **单一 worktree**：`C:\Users\Acid\Documents\repo\Trace`（main）。feature/Animation、feature/tasks 分支已删除（任务系统设计作废，待推翻重建）
- **分支状态**：main = upstream 0.2.6 合并结果（merge 3741b70），领先 origin/main 78 个提交未推送；upstream 同步按需手动做

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | Electron + Vite HMR 开发模式 |
| `npm run typecheck` | 全量类型检查（node + web 两个 tsconfig） |
| `npm run typecheck:node` | 仅 `electron/` + `shared/` |
| `npm run typecheck:web` | 仅 `src/` + `shared/` |
| `npm run build` | 生产构建到 `out/` |
| `npm run package` | 构建 + Windows NSIS 安装包到 `dist/` |
| `npm run preview` | 预览构建产物 |
| `npm test` | vitest 单元测试（geometry/imageProtocol/power） |

- **有 vitest 测试，没有 lint 脚本。** 验收靠 `npm run typecheck` + `npm test` + `npm run dev` 手动验证。
- npm ≥ 11 默认拦截 postinstall 脚本：装完依赖要 `npm approve-scripts electron esbuild koffi`，否则 esbuild/electron 二进制缺失，`npm run dev` 直接失败。
- 打包失败报 `EBUSY` 时：`taskkill /F /IM electron.exe /T` 关掉运行中的实例再试。
- 注意：本环境（pi）裸 `git` 命令输出会被干扰（显示旧状态），用 `/cmd/git` 或 `/mingw64/bin/git` 执行 git 命令。

## 三进程架构

| 层 | 目录 | 运行时 | 职责 |
|---|---|---|---|
| Main | `electron/main/` | Node.js | 剪贴板、文件 I/O、OLE 拖拽、窗口/托盘、状态中枢 |
| Preload | `electron/preload/index.ts` | 沙箱 | `contextBridge.exposeInMainWorld('edge', api)` |
| Renderer | `src/` | 浏览器 | React UI、动画、交互 |

- Renderer 无 Node 权限（`sandbox: true`），一切系统能力走 `window.edge`。
- Preload 在捕获阶段全局拦截 `dragover`/`drop`，用 `webUtils.getPathForFile` 处理文件拖入（contextBridge 无法序列化 File 对象）。

## IPC 合约（最核心的约束）

`shared/ipc.ts` 用三个类型映射定义全部通道，`shared/bridge.ts` 的 `EdgeApi` 是 preload 实现与 renderer 消费的接口。**新增通道必须改四个文件**，漏一个就类型或运行时报错：

1. `shared/ipc.ts` — 契约：InvokeMap / EventMap / SendMap 之一
2. `shared/bridge.ts` — EdgeApi 接口方法签名
3. `electron/preload/index.ts` — 实现（`invoke()` / `send()` / `on()` 类型安全助手）
4. `electron/main/ipc.ts` — handler 注册（`handle()` / `on()` 编译期校验助手）

- `InvokeMap` — renderer invoke → main 返回 Promise（`state:load`、`item:merge`、`app:get-releases`…）
- `EventMap` — main → renderer 推送（`state:items`、`window:cursor-edge`、`ui:toast`…）
- `SendMap` — 即发即弃（`item:start-drag`、`tutorial:set-step`）

领域模型在 `shared/types.ts`：`ItemData`（text/image/image-collection/files 判别联合）、`ClipboardItem`/`ClipboardItemDto`、`Settings`、`MAX_STACK = 10`、`DragRequest`。

## 状态流：Main 是唯一真实来源

1. `electron/main/state.ts` 持有 `ItemStore` + `ClipboardWatcher` 单例，是运行时中枢；`pushState` 统一对外广播。
2. 每次变更后 main 推送完整 `ClipboardItemDto[]`（`state:items`）。
3. Renderer 的 Zustand store（`src/store/appStore.ts`）只是这份推送的视图缓存；动作通过 `window.edge.*` 委托给 main。
4. 不要反转：renderer 不做持久化决策，乐观更新后以 main 推送为准。

## 关键子系统

### 边缘触发器（`electron/main/window.ts` + `src/hooks/useEdgeHover.ts`）
- 窗口 384px 宽、透明、无边框、常驻最前；视觉 blade 270px（`--panel-width`）。折叠时 `setIgnoreMouseEvents(true)` 点击穿透。
- Main 每 16ms `screen.getCursorScreenPoint()` 轮询（透明窗口收不到 pointermove），`clientX <= 450` 或面板开着时持续推送 `window:cursor-edge`。
- 滞回：3px 触发 × 120ms 停留打开；≤255px 保持；>290px 开始 250ms 关闭宽限。
- 关闭检测主靠 renderer 的 `panel:leave` 自定义事件（React mouseleave 不冒泡，正好只响应真实离开），Y 轴越界 pointermove 兜底；外部 OS 文件拖拽期间永不关闭。
- **detector window**（`createDetectorWindow`）：1px 宽 × 30% 高的透明 click-through 窗口，常驻面板下方（'normal' 置顶级 vs 面板 'screen-saver' 级），是 OS 拖入的兜底 surface。**必须保持 click-through**——非 click-through 的置顶透明窗口在 Windows 上会吞掉整条边缘的桌面点击（最小命中区域）。拖入感知实际由主进程光标轮询完成，detector 只做保险。
- `useEdgeHover` 把所有响应值放 refs，effect 只挂一次（重启会取消计时器）。新增依赖时照此办理。
- **置顶心跳**：`setAlwaysOnTop` 每 500ms 重申一次（'screen-saver' 级，压过全屏应用）；原生拖拽期间必须暂停（`setHeartbeatPaused`），否则置顶窗口会压到拖拽幽灵上面。动 z-order 相关代码先看这里。
- `window.ts` 禁止 import `state.ts`（循环依赖，文件头有注释）。

### 剪贴板（`electron/clipboard/`）
- `ClipboardWatcher` 600ms 轮询；`formats.ts` 负责读取、分类与签名（koffi 读原生剪贴板格式）。
- 去重签名：文本 = 字符串本身；图片 = FNV-1a 哈希 ~400 个采样 BGRA 字节；文件 = 换行连接路径列表。签名即去重键。
- 隐私：密码管理器/听写工具格式（Bitwarden、KeePass、`ExcludeClipboardContentFromMonitorProcessing` 等）case-insensitive 匹配后整体跳过。
- 文件列表走 PowerShell（`FileNameW` 绕过 Electron 单文件限制）。

### ItemStore（`electron/store/ItemStore.ts`）
- `sigToId` Map → 去重 O(1)；重复复制提升到顶部、hitCount++、刷新时间戳。
- `merge()`/`split()` 类型安全：图片只能并图片、文件只能并文件；栈上限 `MAX_STACK`。
- `trim()` 从尾部驱逐最旧未固定项；持久化 = `items.json` 索引 + 每张图片独立 PNG，都在 userData 下（`paths.ts` 集中定义）。
- 文件元数据（大小/缩略图）走缓存 Map；`size` 取不到时返回 0，renderer 隐藏标签。

### 原生拖拽（`electron/main/drag.ts`）
- renderer 拦截 `dragstart` → `item:start-drag` 即发即弃 → main 把内容暂存临时文件 → `webContents.startDrag({file, icon})`。必须从 dragstart 同步调用，所以走 send 不走 invoke。
- 拖拽图标：`@resvg/resvg-js` 渲染 SVG（文件栈卡片、文本玻璃卡片、图片缩略图），64 项内存缓存 + 启动预暖。

### 其他 main 模块
- `powershell.ts` — PowerShell 调用封装（模拟 Ctrl+V 粘贴、HDROP 文件列表）。
- `fullscreen.ts` — koffi 全屏应用检测（决定面板 z-order/收回行为）。
- `onboardingWindow.ts` — 首次启动引导窗口，独立 frameless 窗口，加载 `#/onboarding` 路由。
- `config.ts` — `APP_CONFIG`（应用名、`tracelocal://` 图片协议）与 `runtime` 可变标志。

### 设置（`electron/store/settings.ts`）
- 扁平 JSON，读取时深合并到 `DEFAULT_SETTINGS` 并**钳制数值**（hotZoneHeight 0.2–0.6、historyLimit 50–2000、autoDeleteHours ≥ 0、uiStyle 枚举）。新加设置字段要同时登记 `shared/types.ts` 的 `Settings`/`DEFAULT_SETTINGS` 和这里的 `merge()`。

### 渲染层
- `src/main.tsx` 按 hash 路由：`#/onboarding` → Onboarding，否则 App。
- 组件树：App → Panel（Header / ItemList / Settings / ToastStack），Settings 内嵌 ChangelogView 子视图；i18n 30 语言（`src/i18n/`）。
- `src/components/PreviewFlyout.tsx` 是 upstream 遗留死文件（无人引用），别动。
- 样式分层：tokens.css（主题变量）→ global → panel/item/settings。

## 注意事项

- **upstream 同步（2026-08-09）**：已合并 Deepender25/Edge-Drop 到 v0.2.6（63 提交 / 3 万行：i18n 30 语言、设置 3-tab 重构、Web Audio 音效、多显示器持久化、性能优化、vitest）。**自动更新（electron-updater）已整体剔除**——silent auto-update 会下载 upstream 的包覆盖 Trace，合并后删除了 updater.ts、相关 IPC 通道、设置 UI 与 i18n 键；保留 `app:get-releases`（What's New 视图，指向 PaRr0tBoY/Trace releases，离线回退静态 changelog）。品牌已全部替换为 Trace；ChangelogView.tsx 与 ipc.ts 的静态 changelog 保留 Edge-Drop 历史原文；AppX 证书身份（Deepender.EdgeDrop）保留（证书绑定）。
- **feature/tasks 已删除（2026-08-09）**：任务系统设计作废（上游大更新后决策推翻重建）。旧设计要点（Task 聚合根、四层面板、Alt-Tab 窗口切换、koffi 键盘轮询、C# 窗口枚举 helper）仅存于 git 历史（`3dc9b07`、`f146a96`），重建时可参考但不要恢复代码。
- userData 目录：`%APPDATA%\Trace`（rebrand 后），旧 `edge-drop` 数据不迁移。
- **输入框焦点（t21）**：面板窗口 `focusable:false`（upstream 遗留，**禁止改 true**）。输入框聚焦链：renderer 全局 `focusin`（App.tsx，捕获阶段，匹配 `input, textarea, [contenteditable]`）→ `ui:input-focus` 即发即弃 IPC → main `electron/main/focus.ts` 调 `win.setFocusable(true)+win.focus()` 真正激活窗口（仅 OS 层 SetFocus/剥 WS_EX_NOACTIVATE 不够——Chromium 内部激活状态在创建时缓存，实测按键仍被吞；必须走 Electron 的 focus 机制）。blur（focusout → `ui:input-blur`）→ `setFocusable(false)` + koffi 显式加回 WS_EX_NOACTIVATE（实测 setFocusable(false) 不动 OS 样式）。仅点输入框才激活窗口；其余点击不抢焦点。输入框聚焦时 Escape 只 blur 不关面板（useEdgeHover onKeyDown）。
- `drag_debug.txt` 是 OLE 拖拽排障日志，已被 gitignore（upstream 加的），运行时生成不提交。
- `features_and_architecture.md` 是旧架构文档（fork 前写的），可能滞后于代码；`scratch/` 用途不明，别动。
