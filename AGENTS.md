# AGENTS.md

## 项目身份

**Trace** — 悬停在屏幕左边缘、hover 展开的剪贴板管理器（原 Edge-Drop，正在重命名）。零点击交互，支持原生 OLE 拖拽到任意桌面应用。

- **平台**：仅 Windows（Win32 OLE 拖拽、PowerShell HDROP 解析、透明窗口光标轮询）
- **技术栈**：Electron 30 · React 18 · TypeScript 5 · Framer Motion 11 · Zustand 4 · electron-vite
- **分支**：`feature/Animation`（与 origin/main 同 commit，工作区有未提交改动）

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

- **没有 lint 脚本，没有测试框架，没有测试文件。** 验收靠 `npm run typecheck` + `npm run dev` 手动验证。
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

`shared/ipc.ts` 用三个类型映射定义全部通道，`shared/bridge.ts` 的 `EdgeApi` 是 preload 实现与 renderer 消费的接口。**改 IPC 必须同时改这两个文件**，否则类型检查直接失败：

- `InvokeMap` — renderer invoke → main 返回 Promise（`state:load`、`item:merge`、`settings:update`…）
- `EventMap` — main → renderer 推送（`state:items`、`window:cursor-edge`、`ui:toast`…）
- `SendMap` — 即发即弃（`item:start-drag`、`tutorial:set-step`）

`ipc.ts` 的 `handle()`/`on()` 注册助手按通道类型做编译期校验，新 handler 必须走它们。领域模型在 `shared/types.ts`：`ItemData`（text/image/image-collection/files 判别联合）、`ClipboardItem`/`ClipboardItemDto`（DTO 图片内联 base64）、`Settings`、`MAX_STACK = 10`、`DragRequest`。

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
- `useEdgeHover` 把所有响应值放 refs，effect 只挂一次（重启会取消计时器）。新增依赖时照此办理。
- **置顶心跳**：`setAlwaysOnTop` 每 500ms 重申一次；原生拖拽期间必须暂停（`setHeartbeatPaused`），否则置顶窗口会压到拖拽幽灵上面。动 z-order 相关代码先看这里。
- `window.ts` 禁止 import `state.ts`（循环依赖，文件头有注释）。

### 剪贴板（`electron/clipboard/`）
- `ClipboardWatcher` 600ms 轮询；`formats.ts` 负责读取、分类与签名。
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
- `onboardingWindow.ts` — 首次启动引导窗口，独立 frameless 窗口，加载 `#/onboarding` 路由。
- `config.ts` — `APP_CONFIG`（应用名、`tracelocal://` 图片协议）与 `runtime` 可变标志。

### 设置（`electron/store/settings.ts`）
- 扁平 JSON，读取时深合并到 `DEFAULT_SETTINGS` 并**钳制数值**（hotZoneHeight 0.2–0.6、historyLimit 50–2000、autoDeleteHours ≥ 0、uiStyle 枚举）。新加设置字段要同时登记 `shared/types.ts` 的 `Settings`/`DEFAULT_SETTINGS` 和这里的 `merge()`。

### 渲染层
- `src/main.tsx` 按 hash 路由：`#/onboarding` → Onboarding，否则 App。
- 组件树：App → Panel（Header / DropOverlay / ItemList / SplitDropZone / Settings / ToastStack）。
- 样式分层：tokens.css（主题变量）→ global → panel/item/settings。

## 注意事项

- **重命名进行中**：代码已从 Edge-Drop 改为 Trace（package.json、`APP_CONFIG.appName`、`tracelocal://` 协议、CSP、localStorage key `trace_pinned_collapsed`），但 `README.md`/`FEATURES.md`/`features_and_architecture.md` 仍是旧品牌。userData 目录随应用名变化（`%APPDATA%\Trace`），旧 `edge-drop` 数据不会自动迁移。
- 根目录的 `electron.vite.config.*.mjs` 是 electron-vite 生成的历史备份，可清理。
- `drag_debug.txt` 是 OLE 拖拽排障日志（运行时追加）；`scratch/` 用途不明，别动。
