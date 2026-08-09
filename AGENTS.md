# AGENTS.md

## 项目身份

**Trace** — 悬停在屏幕左边缘、hover 展开的剪贴板管理器 + AI 原生个人工作上下文管理器（原 Edge-Drop，已重命名）。零点击交互，支持原生 OLE 拖拽到任意桌面应用。

长期目标（见 feature/tasks 分支的 `Product.md`）：以 **Task** 为核心实体，把窗口、文件、剪贴板变成任务的关联资源，最终成为用户的"第二工作记忆"。MVP 是四层面板：Layer 1 窗口切换器（Alt-Tab 替代）· Layer 2 文件中转站 · Layer 3 剪贴板 · Layer 4 任务列表（默认页）。

- **平台**：仅 Windows（Win32 OLE 拖拽、PowerShell HDROP 解析、透明窗口光标轮询、koffi FFI 键盘状态检测）
- **技术栈**：Electron 34 · React 18 · TypeScript 5 · Framer Motion 11 · Zustand 4 · electron-vite · vitest；feature/tasks 分支另用 koffi（main 的 koffi 是 upstream 电源检测用的）
- **仓库是单一 git 仓库、两个 worktree**：`C:\Users\Acid\Documents\repo\Trace`（main）、`...\Trace-tasks`（feature/tasks，任务系统 WIP，**当前开发主线**）
- **分支状态**：main 已同步最新 AGENTS.md（feature/Animation 已并入后删除）；feature/tasks 基于 f5dd509 领先任务系统 WIP（Alt-Tab 激活、窗口枚举修复等，见下文），**未合并回 main**。跨 worktree 改代码前先确认目标分支。

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

- **有 vitest 测试（upstream 2026-08 合并进来），没有 lint 脚本。** 验收靠 `npm run typecheck` + `npm test` + `npm run dev` 手动验证。
- npm ≥ 11 默认拦截 postinstall 脚本：新 worktree 装完依赖要 `npm approve-scripts electron esbuild koffi`，否则 esbuild/electron 二进制缺失，`npm run dev` 直接失败。
- 打包失败报 `EBUSY` 时：`taskkill /F /IM electron.exe /T` 关掉运行中的实例再试。

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

- `InvokeMap` — renderer invoke → main 返回 Promise（`state:load`、`item:merge`、`task:create`…）
- `EventMap` — main → renderer 推送（`state:items`、`window:cursor-edge`、`keyboard:alt-tab-start`…）
- `SendMap` — 即发即弃（`item:start-drag`、`tutorial:set-step`）

领域模型在 `shared/types.ts`（`ItemData` 判别联合、`ClipboardItem`/`ClipboardItemDto`、`Settings`、`MAX_STACK = 10`、`DragRequest`、`WindowInfo`）+ `shared/task.ts`（`Task`/`TaskDto`/`TaskStatus`）。

## 状态流：Main 是唯一真实来源

1. `electron/main/state.ts` 持有 `ItemStore` + `ClipboardWatcher` + `TaskStore` 单例，是运行时中枢；`pushState` 统一对外广播。
2. 每次变更后 main 推送完整 `ClipboardItemDto[]`（`state:items`）。
3. Renderer 的 Zustand stores（`src/store/appStore.ts`、`taskStore.ts`、`windowStore.ts`）只是这份推送的视图缓存；动作通过 `window.edge.*` 委托给 main。
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

### Task 系统（feature/tasks：`electron/store/TaskStore.ts` + `shared/task.ts` + `src/store/taskStore.ts`）
- Task 是聚合根：`title` / `status`（active|paused|waiting|completed，全手动）/ `linkedItemIds` / `linkedWindows` / `linkedFilePaths` / `history`，持久化 `tasks.json`。
- 双向关联：`Task.linkedItemIds` ↔ `ClipboardItem.linkedTaskIds`。两个 store 各自持久化，**删除一侧必须手工清理另一侧的引用**（见 Product.md A.6 风险表）。
- 清理保护：`TaskStore.protectedItemIds` 通过 `ItemStore.setProtectedIds()` 注入，`trim()` / `pruneExpired()` / `clearUnpinned()` 跳过受保护项。接线在 `state.ts`。
- 窗口枚举 `windowManager.ts`：首次使用编译 C# helper exe（`userData/TraceWinHelper-vN.exe`，csc v4.0.30319），结果 2s 缓存。**改 C# 源码必须 bump `HELPER_VERSION`**（exe 缓存在 userData，重编译只在缺失时发生）；`GetWindowTextW` 的 P/Invoke 必须带 `CharSet = CharSet.Unicode`——缺了标题会截断成首字符、中文变乱码（实测踩过）。Product.md 写的 koffi/SetWindowsHookEx 方案已弃用——实现改为 koffi `GetAsyncKeyState` 20ms 轮询（`keyboardHook.ts`），窗口激活 `activateWindow()` 走 koffi user32（AttachThreadInput + SetForegroundWindow）。
- **已知限制：轮询无法拦截系统 Alt-Tab**，松手时系统切换器会同时出现。真正的钩子替换是待办。
- Alt-Tab 状态机（`keyboardHook.ts`）：双击 Alt → Layer 3，双击 Ctrl → Layer 2，Alt+Tab 按住 → Layer 1（`keyboard:alt-tab-start/cycle/end`，end 的 index = -1 表示 ESC 取消），Alt 释放 → main 激活选中窗口并关面板。
- **坑**：键盘打开面板（Alt-Tab / 双击 Alt/Ctrl）时光标不在左边缘，`useEdgeHover` 的 250ms 关闭宽限会误关面板——已用 appStore 的 `keyboardOpen` 标志挡住（`setOpen(false)` 时自动清除；改关闭逻辑时保留该检查）。

### 剪贴板（`electron/clipboard/`）
- `ClipboardWatcher` 600ms 轮询；`formats.ts` 负责读取、分类与签名。
- 去重签名：文本 = 字符串本身；图片 = FNV-1a 哈希 ~400 个采样 BGRA 字节；文件 = 换行连接路径列表。签名即去重键。
- 隐私：密码管理器/听写工具格式（Bitwarden、KeePass、`ExcludeClipboardContentFromMonitorProcessing` 等）case-insensitive 匹配后整体跳过。
- 文件列表走 PowerShell（`FileNameW` 绕过 Electron 单文件限制）。

### ItemStore（`electron/store/ItemStore.ts`）
- `sigToId` Map → 去重 O(1)；重复复制提升到顶部、hitCount++、刷新时间戳。
- `merge()`/`split()` 类型安全：图片只能并图片、文件只能并文件；栈上限 `MAX_STACK`。
- `trim()` 从尾部驱逐最旧未保护项；持久化 = `items.json` 索引 + 每张图片独立 PNG，都在 userData 下（`paths.ts` 集中定义）。
- 文件元数据（大小/缩略图）走缓存 Map；`size` 取不到时返回 0，renderer 隐藏标签。

### 原生拖拽（`electron/main/drag.ts`）
- renderer 拦截 `dragstart` → `item:start-drag` 即发即弃 → main 把内容暂存临时文件 → `webContents.startDrag({file, icon})`。必须从 dragstart 同步调用，所以走 send 不走 invoke。
- 拖拽图标：`@resvg/resvg-js` 渲染 SVG（文件栈卡片、文本玻璃卡片、图片缩略图），64 项内存缓存 + 启动预暖。
- `logDrag` 追加写 `./drag_debug.txt`（见注意事项）。

### 其他 main 模块
- `powershell.ts` — PowerShell 调用封装（模拟 Ctrl+V 粘贴、HDROP 文件列表）。
- `onboardingWindow.ts` — 首次启动引导窗口，独立 frameless 窗口，加载 `#/onboarding` 路由。
- `config.ts` — `APP_CONFIG`（应用名、`tracelocal://` 图片协议）与 `runtime` 可变标志。

### 设置（`electron/store/settings.ts`）
- 扁平 JSON，读取时深合并到 `DEFAULT_SETTINGS` 并**钳制数值**（hotZoneHeight 0.2–0.6、historyLimit 50–2000、autoDeleteHours ≥ 0、uiStyle 枚举）。新加设置字段要同时登记 `shared/types.ts` 的 `Settings`/`DEFAULT_SETTINGS` 和这里的 `merge()`。

### 渲染层
- `src/main.tsx` 按 hash 路由：`#/onboarding` → Onboarding，否则 App。
- 组件树（main）：App → Panel（Header / ItemList / Settings / ToastStack），Settings 内嵌 ChangelogView 子视图。feature/tasks 分支另有 Layer 1/2/3/4 结构（见 Task 系统节）。
- `src/components/PreviewFlyout.tsx` 是 upstream 遗留死文件（无人引用），别动。
- 样式分层：tokens.css（主题变量）→ global → panel/item/settings。

## 注意事项

- **upstream 同步（2026-08-09）**：已合并 Deepender25/Edge-Drop 到 v0.2.6（63 提交 / 3 万行：i18n 30 语言、设置 3-tab 重构、Web Audio 音效、多显示器持久化、性能优化、vitest）。**自动更新（electron-updater）已整体剔除**——silent auto-update 会下载 upstream 的包覆盖 Trace，合并后删除了 updater.ts、相关 IPC 通道、设置 UI 与 i18n 键；保留手动 `app:get-releases`（What's New 视图，指向 PaRr0tBoY/Trace releases，离线回退静态 changelog）。品牌已全部替换为 Trace；ChangelogView.tsx 与 ipc.ts 的静态 changelog 保留 Edge-Drop 历史原文；AppX 证书身份（Deepender.EdgeDrop）保留（证书绑定）。
- **main 已 rebrand**（package.json name、`APP_CONFIG.appName`、`tracelocal://` 协议、CSP、localStorage key `trace_pinned_collapsed_map`），feature/tasks **尚未合并**，仍叫 edge-drop。userData 目录随应用名变化（`%APPDATA%\Trace`），旧 `edge-drop` 数据不会自动迁移。
- `drag_debug.txt` 是 OLE 拖拽排障日志，**被 git 跟踪且持续增长**（drag.ts 的 `logDrag` 用 `appendFileSync` 写 `process.cwd()`）。自己调试跑出来的追加行不要提交。
- `Product.md`（feature/tasks）是产品规范，含工程上下文附录（IPC 四文件注册链、实现顺序、风险表）；`docs/agents/*.md` 是模板化 agent 约定（issue tracker 用 `gh` 管理 PaRr0tBoY/Trace issues）。`features_and_architecture.md`/`README.md` 可能滞后于代码。
- 根目录的 `electron.vite.config.*.mjs` 是 electron-vite 生成的历史备份（main 已删，feature/tasks 还有），可清理。
- `.codegraph/` 是 CodeGraph 工具索引（未跟踪），Product.md A.4 有它的 MCP 工具用法；提示"文件被编辑过"时要手动 Read 确认。
- `scratch/` 用途不明，别动。
