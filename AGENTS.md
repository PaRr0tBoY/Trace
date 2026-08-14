# AGENTS.md

## 项目身份

**Trace** — 悬停在屏幕左边缘、hover 展开的剪贴板管理器（原 Edge-Drop，已 rebrand）。零点击交互，支持原生 OLE 拖拽到任意桌面应用。

- **平台**：仅 Windows（Win32 OLE 拖拽、PowerShell HDROP 解析、透明窗口光标轮询、koffi FFI）
- **技术栈**：Electron 34 · React 18 · TypeScript 5 · Framer Motion 11 · Zustand 4 · electron-vite · vitest；koffi 用于全屏检测与剪贴板格式读取（upstream 引入）
- **单一 worktree**：`C:\Users\Acid\Documents\repo\Trace`（main）。feature/Animation、feature/tasks 分支已删除；animate/deslop 已 merge 入 main（2026-08-12），其 worktree（`C:\Users\Acid\.herdr\worktrees\Trace\animate-deslop`）待清理
- **分支状态**：main = upstream 0.2.6 合并结果（merge 3741b70）+ 本地 100+ 提交（ADR-0001…0005、任务层、AI 层）未推送；upstream 同步按需手动做

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
| `npm test` | vitest 单元测试（44 文件 / 896 用例：任务层、决策管道、记忆、AI、几何等） |

- **有 vitest 测试，没有 lint 脚本。** 验收靠 `npm run typecheck` + `npm test` + `npm run dev` 手动验证。
- npm ≥ 11 默认拦截 postinstall 脚本：装完依赖要 `npm approve-scripts electron esbuild koffi`，否则 esbuild/electron 二进制缺失，`npm run dev` 直接失败。
- **better-sqlite3 也在被拦截之列（2026-08-14 实测）**：拦截后 prebuild-install 不跑，`node_modules/better-sqlite3/build/Release` 残留系统 Node ABI 产物，Electron 34（ABI 132）启动报 `ERR_DLOPEN_FAILED`/`NODE_MODULE_VERSION 137`，`[Store] trace.db open failed`（记忆/证据不持久化）。**`npm rebuild better-sqlite3 --runtime=electron ...` 会被 allowScripts 静默拦下（报 success 但脚本没跑）**——正确修法：在 `node_modules/better-sqlite3` 里手动 `npx prebuild-install --runtime=electron --target=<electron 实际版本> --disturl=https://electronjs.org/headers`（校验和可对 `%LOCALAPPDATA%\npm-cache\_prebuilds\*-electron-v132-*.tar.gz` 比对确认）。
- 打包失败报 `EBUSY` 时：`taskkill /F /IM electron.exe /T` 关掉运行中的实例再试。
- `npm run package` = `build:github`，electron-builder 的 publish 配置指向 GitHub releases——**无 `GH_TOKEN` 环境变量时 NSIS 产物照常生成，但 upload 阶段报错退出**；本地打包验收用 `npm run package`（产物在 `dist/`），发布才需 token。
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
- `SendMap` — 即发即弃（`item:start-drag`、`ui:input-focus`、`panel:expand`…）

任务层通道：`task:load/merge/update/delete/link-*`、`task:suggest-title`（t56 迁入决策模块）、`suggestion:accept`（带 opts：title/note/apps/clipboardItemIds）、`suggestion:accept-with-resource`、`suggestion:ignore`（带 reason）、`task:app-options`（ADR-0002 编辑器应用网格）、`app:icons`（on-demand 图标）、`app:open-linked-window`（ADR-0005 窗口切换）。

AI 管道通道（t42/t51/t54）：`trace:list-by-decision/list-by-task/get-by-id/clear/export-report`（AI 依据）、`memory:list/act`、`memory-graph:list/set-state/adjudicate`（记忆面板）、`local-model:status/start-download/remove/set-source/set-path/pick-path`。

领域模型在 `shared/types.ts`：`ItemData`（text/image/image-collection/files 判别联合）、`ClipboardItem`/`ClipboardItemDto`、`Settings`、`MAX_STACK = 10`、`DragRequest`。

## 状态流：Main 是唯一真实来源

1. `electron/main/state.ts` 持有 `ItemStore` + `ClipboardWatcher` 单例，是运行时中枢；`pushState` 统一对外广播。
2. 每次变更后 main 推送完整 `ClipboardItemDto[]`（`state:items`）。
3. Renderer 的 Zustand store（`src/store/appStore.ts`）只是这份推送的视图缓存；动作通过 `window.edge.*` 委托给 main。
4. 不要反转：renderer 不做持久化决策，乐观更新后以 main 推送为准。

## 关键子系统

### 边缘触发器（`electron/main/window.ts` + `src/hooks/useEdgeHover.ts`）
- 窗口 384px 宽、透明、无边框、常驻最前；视觉 blade 270px（`--panel-width`）。折叠时 `setIgnoreMouseEvents(true)` 点击穿透。
- Main 每 16ms `screen.getCursorScreenPoint()` 轮询（透明窗口收不到 pointermove），**IPC 减频**（ADR-0004 后）：边缘状态翻转即发；面板关闭时仅 450px 内且移动 ≥3px 才发；面板开着时移动才发（静止不再 60Hz 刷屏）。
- 滞回：3px 触发 × 120ms 停留打开；≤255px 保持；>290px 开始 250ms 关闭宽限。
- 关闭检测主靠 renderer 的 `panel:leave` 自定义事件（React mouseleave 不冒泡，正好只响应真实离开），Y 轴越界 pointermove 兜底；外部 OS 文件拖拽期间永不关闭。
- **detector window**（`createDetectorWindow`）：1px 宽 × 30% 高的透明 click-through 窗口，曾是 OS 拖入的兜底 surface。**已不再创建**（`window.ts` 仅保留 legacy 函数）——拖入感知完全由主进程光标轮询完成；该函数若重新启用，**必须保持 click-through**（非 click-through 的置顶透明窗口在 Windows 上会吞掉整条边缘的桌面点击）。
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
- 文本也走文件拖出（temp .txt + UTF-8 BOM，Notepad/Word 识别编码）；早期手搓 OLE IDataObject 方案因 `RPC_E_CALL_REJECTED` 放弃（koffi 对象无法跨进程 marshaling，见 git 历史 oleDrag.ts）。
- 拖拽图标：`@resvg/resvg-js` 渲染 SVG（文件栈卡片），badge 用主题色 accent（`THEME_ACCENTS[themeColor]`，主题切换重建缓存），64 项内存缓存 + 启动预暖。

### 其他 main 模块
- `powershell.ts` — PowerShell 调用封装（模拟 Ctrl+V 粘贴、HDROP 文件列表、`runOutput` 捕获 stdout 供 OCR）。**多行脚本在常驻会话 stdin 会卡死**——给常驻通道的脚本必须写成单行（`;` 连接，OCR 脚本即如此）。
- `fullscreen.ts` — koffi 全屏应用检测（决定面板 z-order/收回行为）。
- `onboardingWindow.ts` — 首次启动引导窗口，独立 frameless 窗口，加载 `#/onboarding` 路由。
- `config.ts` — `APP_CONFIG`（应用名、`tracelocal://` 图片协议）与 `runtime` 可变标志。
- `focus.ts` — 输入框焦点桥（见注意事项"输入框焦点（t21）"）。
- `windowSwitch.ts` — ADR-0005：`app:open-linked-window` 的实现（pid 命中 → 激活窗口；应用存活 → 最新窗口；否则启动 exe）。`suggestionEngine.ts` 的 `latestSwitchFor` 提供链接窗口快照（linkedWindow）。`activateHwnd` 导出给切换器复用；**只有最小化窗口才 SW_RESTORE**（无脑 restore 会把最大化窗口切成普通窗口）。
- `aiLog.ts` — JSONL 可观测日志（`ai-log.jsonl`）：聊天调用、引擎算法输出、记忆写入各留一条；`provider.ts` 的 `log` 钩子 + `MemoryStore`/`suggestionEngine` 的 `log` 均汇入。
- `appIcons.ts` — APP 图标：`attachAppIcons`/`attachSuggestionIcons` 在 `pushState.tasks/suggestions` 推送前批量填充（`AppRef.iconUrl` / `TaskProposal.appIcons`），`app:icons` 通道按需补取；**磁盘持久化**（`app-icons.json`，userData，7 天 TTL，防抖写盘，负缓存不落盘）+ 启动后台预取（`prewarmAppIcons`：持久化任务 apps ∪ 剪贴板 sourceApp ∪ 最近事件，idle 后 1.5s 跑）——重启后图标立即就绪，不暴露提取过程；`appIconCore.ts` 是纯逻辑（LRU 128 内存缓存含负缓存 30min TTL/seed/snapshot/占位），可注入测试。
- `imageProtocol.ts` — `tracelocal://thumb` 缩略图协议（ADR-0004 性能项，图片预览 base64 移出 IPC DTO）。
- `ocr.ts` — Windows.Media.Ocr（WinRT，经 PowerShell 单行脚本）识别前台窗口文字，作为 LLM 建议的 `ocrContext` 输入。**只作 AI 资料不进 UI、不持久化**；隐私三开关（incognito/L0/总开关）任一关闭即跳过；分析触发时才跑，超时放弃。
- `suggestionDrop.ts` — 拖到备选卡"自动建任务并绑定"的纯逻辑组合（`acceptWithResource`），IPC 层薄封装。
- **Alt+Tab 切换器（ADR-0005，tabtab 合并 2026-08-13）**：`keyboardHook.ts`（WH_KEYBOARD_LL 钩子状态机：idle/altDown/pending/tap/armed，回调纯状态机、副作用全 defer——在 OS 钩子派发上下文里调 koffi/Electron API 会死锁，实测）；`hookHost.ts` 跑在 **utilityProcess**（纯 Node 事件循环，自带 PeekMessageW pump；宿主崩溃 → OS 自动摘钩，绝不吞键）；`hookManager.ts` 主进程侧 fork/桥接与生命周期；`switcher.ts` 会话控制器（show/advance/hover/click/execute，30s 超时自愈，退出还原交互性）；`windowSnapshot.ts` z-order 窗口枚举（复刻 explorer 的 Alt+Tab ring 成员规则：可见、非 toolwindow 除非 APPWINDOW、过滤宿主 exe）。渲染侧 `SwitcherView.tsx` 整页替换（`switcherActive` 时暂停边缘 hover 与点击穿透）。**注意**：`hookHost.ts` 必须作为独立入口构建（electron.vite.config.ts 的 rollup input），`hookManager` 用 `utilityProcess.fork(join(__dirname, 'hookHost.js'))` 拉起。

### 决策与记忆管道（ADR-0005，t31–t58 全量重构）
- **数据层（`electron/store/`，全部纯逻辑零 Electron import，vitest 直测）**：
  - `db.ts` — SQLite canonical（7 表 + FTS5 + WAL + 迁移框架，v4）；vitest 用 Node ABI 预编译回退（`node_modules/.cache/better-sqlite3-node/`）
  - `activityLedger.ts` — 聚类管线（从 suggestionEngine 迁出）：事件 → 段 → 簇（分数/margin/zone）；`recommendationFingerprint`（冷却键）
  - `evidenceStore.ts` — 证据时间线（event 级，30d 保留）；`traceStore.ts` — AI 依据五类（observed/recall/decision/result/privacy），`decisionId` 贯穿全链
  - `recommendationHistory.ts` — 推荐记录 + 冷却（L1 24h / L2 48h / L3 7d，accepted 永久）+ 模式学习（意图五档 × 指数衰减 × 时段）
  - `proposalGrading.ts` — L1/L2/L3 分级（L1 只能从 L2 升级、禁直升；批内语义/签名去重；与现有任务比对）
  - `memoryGraph.ts` — 记忆三表（episodes/entities/facts + FTS5）：去重（norm-key + 余弦 ≥0.6）、矛盾 invalid_at（不覆盖）、权重 = 五档 × expDecay × 时段、确认/忽略/封禁/冲突裁决；`episodeConsolidator.ts` — 时段整理（会话结束/日界/6h 兜底，≤2 次 LLM）
  - `privacyGate.ts` — 隐私三权政策（capture/AI/memory），`policyFromSettings` 纯投影；被拒数据记 trace kind='privacy'
  - `localModelManager.ts` / `localModelRuntime.ts` / `localModelWorker.ts` — 本地模型（Qwen3-0.6B Q8_0）：下载/校验/worker 线程推理；`localModelOptimizer.ts` — 候选过滤 ≤3/标题草稿/rerank（关/失败 = 纯算法等价）
- **决策层（`electron/main/`）**：
  - `suggestionEngine.ts` — 收缩为生命周期控制器（定时/待定提案/采纳编排/commit 接缝），聚类/决策/suggestTitle 均迁出
  - `currentTaskController.ts` — 主 seam：`observe(activity)`，六触发门控（分数跌破/候选超 margin/新簇/idle 恢复/多任务竞争/会话边界），两级调用策略（稳态 0 次 LLM、窗口 dwell 后恰好 1 次），滞回（30–60s dwell + margin 进设置），原子切换（域层 settle+open+迁移），PAUSED 免疫
  - `decisionProvider.ts` — 决策者三实现同一协议（算法/agent/本地模型）：最小预填（隐私门过）、四工具面 ≤3 预算（search_tasks/memories/activities/clipboard，后者预览且受开关控制）、suggestTitle
  - `provider.ts` — Agent 链（OpenAI 兼容，json_schema 400 → 降级 json_object；空 completion 重试 + thinking 关闭；DeepSeek 实测）

### 设置（`electron/store/settings.ts`）
- 扁平 JSON，读取时深合并到 `DEFAULT_SETTINGS` 并**钳制数值**（hotZoneHeight 0.2–0.6、historyLimit 50–2000、autoDeleteHours ≥ 0、uiStyle 枚举、themeColor/restoreTime/tasksFilter 枚举钳制在 `settingsClamp.ts`）。新加设置字段要同时登记 `shared/types.ts` 的 `Settings`/`DEFAULT_SETTINGS` 和这里的 `merge()`。
- **动画档位 `motionLevel`（'standard' | 'extended'，默认 standard）是全部动效的唯一事实源**：CSS 侧经 `applyMotionLevel`（`src/lib/theme.ts`）写 `data-motion` 属性（extended 专属 CSS 规则挂 `:root[data-motion='extended']` 下，如 .act 按压缩放），Framer 侧由各组件读 motionLevel === 'extended' 门控（bounce/胶囊弹簧/高亮/波纹），GSAP 由 LiquidOctopusLoader 与 CopyIndicatorCurve 图标自读 store 门控。**`reducedMotion="never"` 固定**——刻意不跟随 OS `prefers-reduced-motion`（作者机器 OS 动画关闭曾静默杀掉全部动画，见 useOpenBounce 注释）。standard = 干脆的功能动画（reveal/卡片进出/flyout/toast/曲线 morph）；extended = 再加回弹与装饰 delight（面板回弹、标签胶囊弹簧、视图滑动过渡、新条目高亮、空状态淡入、徽章弹簧、按压缩放、复制波纹、图标呼吸、章鱼脉冲）。
- Settings UI 是 4-tab（behaviour/position/appearance/tasks，ADR-0004）；`settingsTab` 在 store 里，restore 机制记住它。

### 渲染层
- `src/main.tsx` 按 hash 路由：`#/onboarding` → Onboarding，否则 App。
- 组件树：App → Panel（Header / ItemList / Settings / ToastStack），App 还挂 CopyIndicatorCurve、PreviewFlyout、IndicatorStyleFlyout；Settings 内嵌 ChangelogView 子视图；i18n 30 语言（`src/i18n/`）。
- 导航（ADR-0004）：三视图 `View`（clipboard/files/tasks），tasks 视图二级 tab（existing/candidates），导航状态全在 store（restore 机制记忆/重置，`src/lib/restore.ts` + `shouldRestoreToLanding`）。
- 文件视图：FileListView + FileMemberRow + `src/lib/fileTabs.ts`（动态扩展名 tab）；任务详情 TaskDetail（关联应用/窗口/关联内容/置信度/创建原因）。
- 主题（ADR-0004）：`shared/themes.ts`（`THEME_ACCENTS`/`THEME_COLORS`，5 主题）+ `src/lib/theme.ts`（`applyTheme` 运行时换 accent）；`--accent-rgb` 供 rgba 用。
- 任务层 UI：`tasks/` 下 TaskView（二级 tab + 全页子视图：TaskEditor 创建/编辑/convert panel、TaskDetail、ContentPicker）、TaskProposalCard（两行卡 + 剪贴板 chips + 点击开 convert panel，卡内无编辑/展开）、TaskEditor（引导式：标题/app 网格/剪贴板列表/AI 标题，suggestion 模式展示 "why"）、TaskDropPanel（拖入绑定面板：保存区 + 任务列表 + 备选卡落点）、dropActions.ts（`linkDraggedItem`/`acceptSuggestionDrop`）；`data-drop-task-id`/`data-drop-suggestion-id`/`.drop-save-zone` 是 Panel `onInternalDrop` 的解析锚点。
- 样式分层：tokens.css（主题变量：`--accent` 主题色、`--bg-2`/`--divider` 中性色）→ global → panel/item/settings/tasks。

## 注意事项

- **upstream 同步（2026-08-09）**：已合并 Deepender25/Edge-Drop 到 v0.2.6（63 提交 / 3 万行：i18n 30 语言、设置 3-tab 重构、Web Audio 音效、多显示器持久化、性能优化、vitest）。**自动更新（electron-updater）已整体剔除**——silent auto-update 会下载 upstream 的包覆盖 Trace，合并后删除了 updater.ts、相关 IPC 通道、设置 UI 与 i18n 键；保留 `app:get-releases`（What's New 视图，指向 PaRr0tBoY/Trace releases，离线回退静态 changelog）。品牌已全部替换为 Trace；ChangelogView.tsx 与 ipc.ts 的静态 changelog 保留 Edge-Drop 历史原文；AppX 证书身份（Deepender.EdgeDrop）保留（证书绑定）。
- **feature/tasks 已删除（2026-08-09）**：任务系统设计作废（上游大更新后决策推翻重建）。旧设计要点（Task 聚合根、四层面板、Alt-Tab 窗口切换、koffi 键盘轮询、C# 窗口枚举 helper）仅存于 git 历史（`3dc9b07`、`f146a96`），重建时可参考但不要恢复代码。**任务系统现已重建（2026-08-12，ADR-0001/0002/0003/0005 + animate/deslop 合并）：引导式 TaskEditor、窗口切换、restore、主题、双行导航。**
- **t14 剪贴板自动归属已移除（2026-08-12）**：任务关联内容只由显式操作变更（拖入绑定、task:link-item/unlink）。剪贴板事件仍带来源 app（sourceApp，ADR-0001）和 itemId 流向建议引擎（分段 + readItem），但不再自动 link 到任务；`decideClipboardAttribution`/`autoAttributionEnabled` 已删，剪贴板事件只在 attributor.ts 的 `buildClipboardEvent` 记录。
- userData 目录：`%APPDATA%\Trace`（rebrand 后），旧 `edge-drop` 数据不迁移。
- **输入框焦点（t21，2026-08-11 最终版）**：键盘输入必须真正激活窗口——实测三条死路：①`focusable:false` 窗口 `element.focus()` 静默失败（无 focusin）；②user32 `SetFocus` 只设线程焦点，全局按键仍去前台窗口（keybd_event 实测 0 到达）；③`setFocusable(false)` 在 Windows 上**隐藏窗口**（禁用）。最终方案：窗口常驻 `focusable:true`（window.ts），OS 侧用 koffi 的 `WS_EX_NOACTIVATE`（`GetWindowLongPtrW`/`SetWindowLongPtrW`，`electron/main/focus.ts`）控制可激活性。输入框聚焦链：renderer 全局 `focusin`/`pointerdown`（App.tsx，捕获阶段，匹配 `input, textarea, [contenteditable]`）→ `ui:input-focus` → main：剥 NOACTIVATE + `win.focus()`（+ `setSkipTaskbar(true)` 防任务栏按钮）。**激活按会话保持**：输入框 blur 不释放（切换输入框不闪烁），面板关闭（`window:set-interactive(false)`）才贴回 NOACTIVATE；窗口失活（`onWindowBlur`）时主动 blur 输入框防 Chromium 焦点重放误激活；pointerdown 非输入元素 → `ui:input-blur` → `win.blur()` 立即失活（Chromium 对 focusable:true 窗口**任何点击都会激活**，NOACTIVATE 拦不住——实测，所以非输入点击后必须主动失活还焦点）。输入框聚焦时 Escape 只 blur 不关面板（useEdgeHover onKeyDown）。
- **0.2.6 合并丢失了三个 IPC handler（2026-08-11 恢复）**：`file:reveal`、`displays:list`、`window:set-preview-mode` 在 `shared/ipc.ts`/preload 有声明但 main 从未注册（真机报 `No handler registered`）。已恢复并注释。**教训：四文件契约靠 typecheck 校验签名，但"声明了没注册"typecheck 查不出**——新增通道后跑一次真机或 grep 确认 `handle('channel'` 存在。
- **搜索框 focus 样式（2026-08-12）**：不用主题色——accent 光晕在透明面板上边缘粗糙且被 `overflow:hidden` 容器截断；focus 时白色细线框（`rgba(255,255,255,0.85)`），无 box-shadow（panel.css `.search input:focus`）。
- **tutorial IPC 死链已清（2026-08-13，t58）**：`tutorial:step`（EventMap）/`tutorial:set-step`（SendMap）两端 main 均无对端，已从四文件删除；renderer 内部 `tutorialStep` 状态流保留（onboarding 过滤逻辑）。**`app:quit` 曾是无 handler 的活坏通道**（Settings 退出按钮 reject 被 void 吞），已补注册 `app.quit()`。
- `drag_debug.txt` 是 OLE 拖拽排障日志，已被 gitignore（upstream 加的），运行时生成不提交。
- `features_and_architecture.md` 是旧架构文档（fork 前写的），可能滞后于代码；`scratch/` 用途不明，别动。
