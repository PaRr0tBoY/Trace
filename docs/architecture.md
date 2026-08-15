# 架构：关键子系统与行为陷阱

子系统按目录组织，坑就地写。

## 边缘触发器（`electron/main/window.ts` + `src/hooks/useEdgeHover.ts`）

- 窗口 384px 宽、透明、无边框、常驻最前；视觉 blade 270px（`--panel-width`）。折叠时 `setIgnoreMouseEvents(true)` 点击穿透。
- Main 每 16ms `screen.getCursorScreenPoint()` 轮询（透明窗口收不到 pointermove），**IPC 减频**（ADR-0004 后）：边缘状态翻转即发；面板关闭时仅 450px 内且移动 ≥3px 才发；面板开着时移动才发（静止不再 60Hz 刷屏）。
- 滞回：3px 触发 × 120ms 停留打开；≤255px 保持；>290px 开始 250ms 关闭宽限。
- 关闭检测主靠 renderer 的 `panel:leave` 自定义事件（React mouseleave 不冒泡，正好只响应真实离开），Y 轴越界 pointermove 兜底；外部 OS 文件拖拽期间永不关闭。
- **detector window**（`createDetectorWindow`）：1px 宽 × 30% 高的透明 click-through 窗口，曾是 OS 拖入的兜底 surface。**已不再创建**（`window.ts` 仅保留 legacy 函数）——拖入感知完全由主进程光标轮询完成；该函数若重新启用，**必须保持 click-through**（非 click-through 的置顶透明窗口在 Windows 上会吞掉整条边缘的桌面点击）。
- `useEdgeHover` 把所有响应值放 refs，effect 只挂一次（重启会取消计时器）。新增依赖时照此办理。
- **置顶心跳**：`setAlwaysOnTop` 每 500ms 重申一次（'screen-saver' 级，压过全屏应用）；原生拖拽期间必须暂停（`setHeartbeatPaused`），否则置顶窗口会压到拖拽幽灵上面。动 z-order 相关代码先看这里。
- `window.ts` 禁止 import `state.ts`（循环依赖，文件头有注释）。

## 剪贴板（`electron/clipboard/`）

- `ClipboardWatcher` 600ms 轮询；`formats.ts` 负责读取、分类与签名（koffi 读原生剪贴板格式）。
- 去重签名：文本 = 字符串本身；图片 = FNV-1a 哈希 ~400 个采样 BGRA 字节；文件 = 换行连接路径列表。签名即去重键。
- 隐私：密码管理器/听写工具格式（Bitwarden、KeePass、`ExcludeClipboardContentFromMonitorProcessing` 等）case-insensitive 匹配后整体跳过。
- 文件列表走 PowerShell（`FileNameW` 绕过 Electron 单文件限制）。

## ItemStore（`electron/store/ItemStore.ts`）

- `sigToId` Map → 去重 O(1)；重复复制提升到顶部、hitCount++、刷新时间戳。
- `merge()`/`split()` 类型安全：图片只能并图片、文件只能并文件；栈上限 `MAX_STACK`。
- `trim()` 从尾部驱逐最旧未固定项；持久化 = `items.json` 索引 + 每张图片独立 PNG，都在 userData 下（`paths.ts` 集中定义）。
- 文件元数据（大小/缩略图）走缓存 Map；`size` 取不到时返回 0，renderer 隐藏标签。

## 原生拖拽（`electron/main/drag.ts`）

- renderer 拦截 `dragstart` → `item:start-drag` 即发即弃 → main 把内容暂存临时文件 → `webContents.startDrag({file, icon})`。必须从 dragstart 同步调用，所以走 send 不走 invoke。
- 文本也走文件拖出（temp .txt + UTF-8 BOM，Notepad/Word 识别编码）；早期手搓 OLE IDataObject 方案因 `RPC_E_CALL_REJECTED` 放弃（koffi 对象无法跨进程 marshaling，见 git 历史 oleDrag.ts）。
- 拖拽图标：`@resvg/resvg-js` 渲染 SVG（文件栈卡片），badge 用主题色 accent（`THEME_ACCENTS[themeColor]`，主题切换重建缓存），64 项内存缓存 + 启动预暖。

## 其他 main 模块

- `powershell.ts` — PowerShell 调用封装（模拟 Ctrl+V 粘贴、HDROP 文件列表、`runOutput` 捕获 stdout 供 OCR）。**多行脚本在常驻会话 stdin 会卡死**——给常驻通道的脚本必须写成单行（`;` 连接，OCR 脚本即如此）。
- `fullscreen.ts` — koffi 全屏应用检测（决定面板 z-order/收回行为）。
- `onboardingWindow.ts` — 首次启动引导窗口，独立 frameless 窗口，加载 `#/onboarding` 路由。
- `config.ts` — `APP_CONFIG`（应用名、`tracelocal://` 图片协议）与 `runtime` 可变标志。
- `focus.ts` — 输入框焦点桥（见「行为陷阱」输入框焦点 t21）。
- `windowSwitch.ts` — ADR-0005：`app:open-linked-window` 的实现（pid 命中 → 激活窗口；应用存活 → 最新窗口；否则启动 exe）。`suggestionEngine.ts` 的 `latestSwitchFor` 提供链接窗口快照（linkedWindow）。`activateHwnd` 导出给切换器复用；**只有最小化窗口才 SW_RESTORE**（无脑 restore 会把最大化窗口切成普通窗口）。
- `aiLog.ts` — JSONL 可观测日志（`ai-log.jsonl`）：聊天调用、引擎算法输出、记忆写入各留一条；`provider.ts` 的 `log` 钩子 + `MemoryStore`/`suggestionEngine` 的 `log` 均汇入。
- `appIcons.ts` — APP 图标：`attachAppIcons`/`attachSuggestionIcons` 在 `pushState.tasks/suggestions` 推送前批量填充（`AppRef.iconUrl` / `TaskProposal.appIcons`），`app:icons` 通道按需补取；**磁盘持久化**（`app-icons.json`，userData，7 天 TTL，防抖写盘，负缓存不落盘）+ **窗口驱动预取**：启动 1.5s 后枚举当前所有有窗口的应用（`snapshotWindows`）批量提取，且 eventBus 订阅 app-switch/剪贴板事件——**每个新到前台/复制来源的应用即时后台提取**（in-flight 去重）；`appIconCore.ts` 是纯逻辑（LRU 128 内存缓存含负缓存 30min TTL、in-flight 去重、seed/snapshot/占位），可注入测试。
- `imageProtocol.ts` — `tracelocal://thumb` 缩略图协议（ADR-0004 性能项，图片预览 base64 移出 IPC DTO）。
- `ocr.ts` — Windows.Media.Ocr（WinRT，经 PowerShell 单行脚本）识别前台窗口文字，作为 LLM 建议的 `ocrContext` 输入。**只作 AI 资料不进 UI、不持久化**；隐私三开关（incognito/L0/总开关）任一关闭即跳过；分析触发时才跑，超时放弃。
- `suggestionDrop.ts` — 拖到备选卡"自动建任务并绑定"的纯逻辑组合（`acceptWithResource`），IPC 层薄封装。
- **Alt+Tab 切换器（ADR-0005，tabtab 合并 2026-08-13 + TabTab 改造 2026-08-14）**：`keyboardHook.ts`（WH_KEYBOARD_LL 钩子状态机：idle/altDown/pending/tap/armed/**pinned**，回调纯状态机、副作用全 defer——在 OS 钩子派发上下文里调 koffi/Electron API 会死锁，实测；**另有 WH_MOUSE_LL 鼠标钩子**专供 pinned 期点击外部检测）；`hookHost.ts` 跑在 **utilityProcess**（纯 Node 事件循环，自带 PeekMessageW pump；宿主崩溃 → OS 自动摘钩，绝不吞键）；`hookManager.ts` 主进程侧 fork/桥接与生命周期（`setHookPinned` 经 postMessage `{type:'pin-state'}` 推入状态机）；`switcher.ts` 会话控制器（show/advance/hover/click/execute/pin/cancel，30s 超时自愈，退出还原交互性）——**行模型**：main 保留未分组 `windows[]` 底账，按 `switcherGroupWindows` 设置把 DTO 分组广播（group 行带 `groupCount` 徽标 + `windows` 子 DTO；`index` 恒为未分组 z-order 索引，hover/click 回报原索引由 main 映射回行）；`windowSnapshot.ts` z-order 窗口枚举（复刻 explorer 的 Alt+Tab ring 成员规则：可见、非 toolwindow 除非 APPWINDOW、过滤宿主 exe）。**TabTab 搜索模式**：armed 时 Enter/方向键/可打印字符均 pin（三条入口：字母、方向键、Enter），pin 后 Alt-up 不再执行（hook 吞掉）、键盘全透传给面板；**hook 的 pinnedSession 是会话级标记**（Alt-up 把状态机拉回 idle 但搜索会话继续，控制键归属必须按会话而非状态）；方向键移动过滤列表（`edge.switcherHover(原始index)` 同步 main）、Enter 执行（复用 `switcherClick`）、左右方向键在一级/二级（drill）页面间切换、Esc 取消会话（`switcher:cancel` → `setHookPinned(false)` + resetSession——pinned 下 Alt 已松开，unpin 回 armed 无 Alt 可循环会挂 30s 超时，直接 reset 更干净）。动画：行级快速滑入+淡入（x 28px、0.16s、stagger 0.02s）+ 整页退出纯淡出（Panel 的 AnimatePresence，mode sync 保证进入不被 exit 拖慢）。渲染侧 `SwitcherView.tsx` 整页替换（`switcherActive` 时暂停边缘 hover 与点击穿透）；分组行点击进本地 drill 二级界面（返回按钮在非 pinned 下也显示）。**注意**：`hookHost.ts` 必须作为独立入口构建（electron.vite.config.ts 的 rollup input），`hookManager` 用 `utilityProcess.fork(join(__dirname, 'hookHost.js'))` 拉起。**面板自动聚焦 + 点击外部收起的完整根因与修复（三级激活升级 + WH_MOUSE_LL 点击外部 + GetForegroundWindow 轮询）见 `.impeccable.md`（渐进式发现文档，Mechanism Notes 区）**；注入探针 `scripts/switcher-probe.cjs`（SendInput 手势序列：show/pin/esc/arrows/clickout/arrowpin/drillright）驱动真实 hook 链路，供回归复测。

## 决策与记忆管道（ADR-0005，t31–t58 全量重构）

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

## 设置（`electron/store/settings.ts`）

- 扁平 JSON，读取时深合并到 `DEFAULT_SETTINGS` 并**钳制数值**（hotZoneHeight 0.2–0.6、historyLimit 50–2000、autoDeleteHours ≥ 0、uiStyle 枚举、themeColor/restoreTime/tasksFilter 枚举钳制在 `settingsClamp.ts`）。新加设置字段要同时登记 `shared/types.ts` 的 `Settings`/`DEFAULT_SETTINGS` 和这里的 `merge()`。
- **动画档位 `motionLevel`（'standard' | 'extended'，默认 standard）是全部动效的唯一事实源**：CSS 侧经 `applyMotionLevel`（`src/lib/theme.ts`）写 `data-motion` 属性（extended 专属 CSS 规则挂 `:root[data-motion='extended']` 下，如 .act 按压缩放），Framer 侧由各组件读 motionLevel === 'extended' 门控（bounce/胶囊弹簧/高亮/波纹），GSAP 由 LiquidOctopusLoader 与 CopyIndicatorCurve 图标自读 store 门控。**`reducedMotion="never"` 固定**——刻意不跟随 OS `prefers-reduced-motion`（作者机器 OS 动画关闭曾静默杀掉全部动画，见 useOpenBounce 注释）。standard = 干脆的功能动画（reveal/卡片进出/flyout/toast/曲线 morph）；extended = 再加回弹与装饰 delight（面板回弹、标签胶囊弹簧、视图滑动过渡、新条目高亮、空状态淡入、徽章弹簧、按压缩放、复制波纹、图标呼吸、章鱼脉冲）。
- Settings UI 是 4-tab（behaviour/position/appearance/tasks，ADR-0004）；`settingsTab` 在 store 里，restore 机制记住它。

## 渲染层

- `src/main.tsx` 按 hash 路由：`#/onboarding` → Onboarding，否则 App。
- 组件树：App → Panel（Header / ItemList / Settings / ToastStack），App 还挂 CopyIndicatorCurve、PreviewFlyout、IndicatorStyleFlyout；Settings 内嵌 ChangelogView 子视图；i18n 30 语言（`src/i18n/`）。
- 导航（ADR-0004）：三视图 `View`（clipboard/files/tasks），tasks 视图二级 tab（existing/candidates），导航状态全在 store（restore 机制记忆/重置，`src/lib/restore.ts` + `shouldRestoreToLanding`）。
- 文件视图：FileListView + FileMemberRow + `src/lib/fileTabs.ts`（动态扩展名 tab）；任务详情 TaskDetail（关联应用/窗口/关联内容/置信度/创建原因）。
- 主题（ADR-0004）：`shared/themes.ts`（`THEME_ACCENTS`/`THEME_COLORS`，5 主题）+ `src/lib/theme.ts`（`applyTheme` 运行时换 accent）；`--accent-rgb` 供 rgba 用。
- 任务层 UI：`tasks/` 下 TaskView（二级 tab + 全页子视图：TaskEditor 创建/编辑/convert panel、TaskDetail、ContentPicker）、TaskProposalCard（两行卡 + 剪贴板 chips + 点击开 convert panel，卡内无编辑/展开）、TaskEditor（引导式：标题/app 网格/剪贴板列表/AI 标题，suggestion 模式展示 "why"）、TaskDropPanel（拖入绑定面板：保存区 + 任务列表 + 备选卡落点）、dropActions.ts（`linkDraggedItem`/`acceptSuggestionDrop`）；`data-drop-task-id`/`data-drop-suggestion-id`/`.drop-save-zone` 是 Panel `onInternalDrop` 的解析锚点。
- 样式分层：tokens.css（主题变量：`--accent` 主题色、`--bg-2`/`--divider` 中性色）→ global → panel/item/settings/tasks。

## 行为陷阱

- userData 目录：`%APPDATA%\Trace`（rebrand 后），旧 `edge-drop` 数据不迁移。
- **输入框焦点（t21，2026-08-11 最终版）**：键盘输入必须真正激活窗口——实测三条死路：①`focusable:false` 窗口 `element.focus()` 静默失败（无 focusin）；②user32 `SetFocus` 只设线程焦点，全局按键仍去前台窗口（keybd_event 实测 0 到达）；③`setFocusable(false)` 在 Windows 上**隐藏窗口**（禁用）。最终方案：窗口常驻 `focusable:true`（window.ts），OS 侧用 koffi 的 `WS_EX_NOACTIVATE`（`GetWindowLongPtrW`/`SetWindowLongPtrW`，`electron/main/focus.ts`）控制可激活性。输入框聚焦链：renderer 全局 `focusin`/`pointerdown`（App.tsx，捕获阶段，匹配 `input, textarea, [contenteditable]`）→ `ui:input-focus` → main：剥 NOACTIVATE + `win.focus()`（+ `setSkipTaskbar(true)` 防任务栏按钮）。**激活按会话保持**：输入框 blur 不释放（切换输入框不闪烁），面板关闭（`window:set-interactive(false)`）才贴回 NOACTIVATE；窗口失活（`onWindowBlur`）时主动 blur 输入框防 Chromium 焦点重放误激活；pointerdown 非输入元素 → `ui:input-blur` → `win.blur()` 立即失活（Chromium 对 focusable:true 窗口**任何点击都会激活**，NOACTIVATE 拦不住——实测，所以非输入点击后必须主动失活还焦点）。输入框聚焦时 Escape 只 blur 不关面板（useEdgeHover onKeyDown）。
- **搜索框 focus 样式（2026-08-12）**：不用主题色——accent 光晕在透明面板上边缘粗糙且被 `overflow:hidden` 容器截断；focus 时白色细线框（`rgba(255,255,255,0.85)`），无 box-shadow（panel.css `.search input:focus`）。
- **better-sqlite3 依赖陷阱（2026-08-14 实测）**：npm ≥ 11 的 allowScripts 拦截同样作用于 better-sqlite3——拦截后 prebuild-install 不跑，`node_modules/better-sqlite3/build/Release` 残留系统 Node ABI 产物，Electron 34（ABI 132）启动报 `ERR_DLOPEN_FAILED`/`NODE_MODULE_VERSION 137`，`[Store] trace.db open failed`（记忆/证据不持久化）。**`npm rebuild better-sqlite3 --runtime=electron ...` 会被 allowScripts 静默拦下（报 success 但脚本没跑）**——正确修法：在 `node_modules/better-sqlite3` 里手动 `npx prebuild-install --runtime=electron --target=<electron 实际版本> --disturl=https://electronjs.org/headers`（校验和可对 `%LOCALAPPDATA%\npm-cache\_prebuilds\*-electron-v132-*.tar.gz` 比对确认）。
- `features_and_architecture.md` 是旧架构文档（fork 前写的），可能滞后于代码；`scratch/` 用途不明，别动。
