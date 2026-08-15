# ADR-0007: 智能收起（Smart Collapse Fallbacks）与自动聚焦

- 状态：已接受（grill-with-docs 会话，2026-08-14）
- 关联：ADR-0004（landing / restore）、ADR-0005（Alt+Tab 切换器）、ADR-0006（智能初始页面，决策 19 无冲突）

## 背景

初始页面新增「笔记」后暴露一个死锁：single-note 模式打开即聚焦编辑器
（`notesEditorActive` 焦点驻留），而 `useEdgeHover` 的「光标离开 blade →
收起」路径全部被焦点驻留拦截。点击外部 / Alt+Tab（window blur）仍可收起，
但**无点击的外部活动**（在别的窗口滚动滚轮、仅移开鼠标）永远无法收起面板，
且键盘输入会被聚焦的笔记编辑器偷走。切换器 pinned 搜索模式同构：搜索框持
焦点 + 外部滚动不换前台 → 会话钉死，同样偷键盘（原 30s 会话超时只是慢兜底）。

## 决策

### 设置字段（行为页「自动收起」分组，均默认开）

- `smartCollapseFallbacks`（文案「智能收起」）：被动信号自动收起。
- `autoFocus`（文案「自动聚焦」）：进入笔记页自动聚焦编辑器；**仅笔记**，
  切换器搜索框始终聚焦（关掉后 = 打开即读，点击编辑器才开始编辑）。

### 信号矩阵（`smartCollapseFallbacks` 开启时；面板收起分支另需
`hoverActivation`，切换器分支不受其门控——瞬态会话必须保留被动兜底）

| 信号 | 判定 | 笔记面板 | 切换器 pinned |
|------|------|---------|--------------|
| 外部滚动 | WH_MOUSE_LL `WM_MOUSEWHEEL`，物理坐标在面板 rect 外（复用 click-outside 判定） | 强制收起 | 放弃会话 |
| 外部复制 | `ui:copy-flare` 且 Trace 窗口非前台（面板内 Ctrl+C 不误收） | 强制收起 | 放弃会话 |
| 前台离开 | 已有 window blur + 切换器前台轮询 | 保留现状 | 保留现状 |
| idle | 笔记：光标离开 blade + 5s 无输入（keydown/IME/编辑器内 pointer 重置）；切换器：停止积极选择 5s（方向键/hover/打字重置） | 收起 | 放弃会话 |
| 锁屏/睡眠 | powerMonitor suspend / lock-screen | 强制收起 | 放弃会话 |
| 全屏 | 已有 suppressInFullscreen 路径 | 保留现状 | — |

- 开关关闭 = 行为完全回到现状：仅 Esc 两级、点击外部、Alt+Tab、Alt+C、
  拖拽保护；**所有被动信号失效**（含锁屏/睡眠）。
- **删除切换器 30s 会话超时**（`SESSION_TIMEOUT_MS`）：智能收起策略是唯一
  被动兜底。后果：开关关闭时 pinned 会话无被动兜底（用户知情选择，Q12）。
- 收起动作：直接收起（绕过焦点驻留，保留 switcher/drag/slider/debugHold
  守卫）；草稿 180ms debounce + unmount flush，无数据风险。
- idle 判定统一抽象 `shared/idle.ts`（`createIdleGuard`，`SMART_COLLAPSE_IDLE_MS = 5000`），
  渲染器与主进程共用同一实现与阈值。

### 恢复语义（Q3）

store 新增会话级 `notesCurrentId`：single-note 模式记住当前笔记，TTL 内重开
回到同一篇（光标位置随 `noteCaret` 恢复）；恢复机制应用 landing 页（TTL 过期
/ 首次启动）时清空，回到书架第一篇。

## 考虑过的选项

- **打开不聚焦（根因路线）**：可根除问题，但会连带破坏点击外部收起
  （窗口不激活 → blur 不触发），且改变 single-note「打开即写」的产品核心。
- **M3 保护窗**（输入中 T 秒内信号不生效）：参数多、响应慢，M2 事件驱动 +
  idle 兜底已覆盖。
- **切换器保留 30s 超时**：与「策略统一」目标矛盾，且开关关闭时语义分裂。
- **idle 全局起算（I2）**：误杀「盯着笔记思考」场景；改为光标锚定（I1）。

## 后果

- 新 IPC 事件 `smart:external-activity`（四文件契约：EventMap / bridge / preload /
  主进程发送点 `smartCollapse.ts`）；`onMouseWheel` 进入 hook 契约（host → hookManager → index）。
- 设置页新增两个开关；i18n 30 语言各 +4 键。
- 面板内滚动阅读、面板内 Ctrl+C 不触发（坐标/前台判定排除）。
- 设置页打开时信号照常生效（与现状「光标离开也收设置页」一致）。
- 与 ADR-0006 智能初始页面（决策 19）正交：智能收起只管「已离开」，智能
  landing 只管「打开去哪」，互不干扰。
