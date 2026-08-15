# ADR-0009: 任务资源模型——三类资源、归属判定与上下文调取

- 状态：已接受（2026-08-15，grill 延续会话）
- 关联：ADR-0001（sourceApp）；ADR-0002（创建引导流）；ADR-0003（AI 标题并入保存按钮）；ADR-0006（摄取阶梯、动作化表达、智能 landing）；ADR-0008（文件中转站与拖拽）

## 背景

剪贴板域拆成三块（剪贴板栈 text/image / 文件中转站 / 笔记）后，任务的组成随之变化。现状任务 = 标题 + 备注（`note`）+ 应用归属（`apps`）+ 资源（`ResourceRef`：clipboard | files 两类），存在三个空白：

1. **文件归属无判定依据**：station 条目只有 route（drag-in | clipboard），没有来源应用——"这个文件是哪个应用复制/拖入的"无从得知，任务编辑器与候选任务的应用集永远丢文件来源。
2. **笔记无归属、无任务接缝**：笔记编辑时前台应用是什么，笔记就该归属该应用；且笔记可以**直接转化为任务**（用户把想法写进笔记，想法可能转化为一次创意工作或别的类型的工作）。
3. **调取流程不通**：资源要先进任务详情、再点资源行拖出——"做任务时从集中地方调取上下文相关资源，而不是从所有资源硬找"的核心价值没兑现。

## 决策

### 1. 资源三分类

`ResourceRef` 扩展为三类，任务组成 = **标题 + 备注 + 应用归属 + 三类资源**：

```ts
type ResourceRef =
  | { kind: 'clipboard'; itemId: string; snapshot: ResourceSnapshot }  // 剪贴板栈条目（text/image）
  | { kind: 'files'; paths: string[] }                                  // 文件（station 条目或裸路径）
  | { kind: 'note'; noteId: string; snapshot: NoteSnapshot }            // 笔记（新增）
```

**备注与笔记资源语义分离**：备注（`task.note`）是任务私有的短说明（纯文本，卡片 80 字预览）；笔记是独立内容对象（Markdown，可转任务、可有归属）。两者不合并——备注不随笔记走，笔记不降级成备注。

### 2. 文件归属判定（station 条目补 sourceApp）

- station 条目增加 `sourceApp: AppRef | null`：**复制路径**（route = clipboard）= 捕获时前台应用（与剪贴板 sourceApp 同源同门控——`l0CaptureEnabled` 关则 null）；**拖入路径**（route = drag-in）= null——拖入是显式意图，无来源应用语义。
- 存量条目迁移为 null；归属用于：任务编辑器进程候选集合、候选任务应用集、文件资源展示来源图标（与剪贴板条目一致）。

### 3. 笔记归属判定（编辑会话前台应用）

- 规则：**编辑笔记时前台应用 = 笔记归属应用**。实现前提成立——面板 `WS_EX_NOACTIVATE` 不抢焦点，编辑笔记时 `GetForegroundWindow` 返回的是用户正在用的应用（不是 Trace）。
- `Note` 增加 `app: AppRef | null`：创建时记录前台应用；编辑会话（打开 → 关闭/切换/失焦）结束时结算主导前台应用并更新。归属展示进笔记视图（来源图标），可选按应用分组（挂起）。

### 4. 笔记 → 任务转化

笔记视图单条笔记卡提供"转为任务"动作：

- 新任务：`title` = 笔记标题（第一行）；`note` = 笔记正文（Markdown 保留）；`apps` = [笔记归属应用]（null 则空）；`resources` = [note 资源（快照引用原笔记）]
- 转化后笔记**保留**并标记 `taskId` 关联；笔记卡显示"已转为任务 X"入口（点击打开任务）——同一笔记仅一次转化，二次点击 = 打开关联任务
- 转化走 `task:create` 扩展（带 noteId，main 侧构建快照，renderer 不碰原始内容）

### 5. 上下文调取（点击 = 取用，拖拽 = 移出）

目的不变式：**任务 = 上下文容器；调取 = 从容器取用，不在全库硬找**。两类动作，各司其职：

- **点击 = 取用**（新增，不改拖拽）：
  - 文本/链接资源：点击复制回剪贴板栈顶（随时可粘贴）
  - 图片：点击预览（复用 preview flyout）
  - 文件：点击在资源管理器显示/打开
  - 笔记：点击展开阅读/编辑
- **拖拽 = 移出**（保持 OLE 拖出，现状 `ResourceRow` draggable），优化触达：
  - 任务卡 hover 即出**资源抽屉**（标题 + 资源微缩条），不进详情即可见可拖
  - 任务视图顶部**当前任务上下文条**：RUNNING 任务资源快捷区（呼应 ADR-0006 决策 17 动作化表达——"有 N 条关联内容可粘贴"直接可点）

### 6. 实施切面

- `ResourceRef` 三分类 → shared/types.ts + TaskStore 快照构建 + 任务详情/编辑器/候选 UI + `UnlinkTarget` 扩展 note 类
- `StationEntry.sourceApp` → station 域 + 存量迁移（null）；station 条目在编辑器进程选择器显示来源图标
- `Note.app` → NoteStore + 笔记 UI；编辑器进程候选集合扩为 L0-tracked ∪ clipboard sourceApps ∪ station sourceApps ∪ note apps
- 调取动作 → 资源行/资源抽屉/上下文条的交互层，IPC 复用现有通道（`item:set-pinned` 语义不扩；复制回栈顶走新 `resource:fetch` 通道，main 侧把内容快照写回栈顶）

## 后果

- 上下文调取闭环：面板 = 集中调取点，"从所有资源硬找"被"任务内筛选"替代
- 笔记成为任务系统一等公民：可归属、可挂任务、可转任务；想法 → 创意工作的路径最短（笔记 → 转任务 → 照常状态机）
- 文件归属补齐后，候选任务的应用集与归因不再丢文件来源
- 挂起项：笔记视图按应用分组（可选）；笔记转任务后的 AI 参与（标题已有无需生成，正文做任务描述润色——有上下文再说）；`resource:fetch` 与剪贴板栈顶的冲突语义（fetch 是否越过 pin/置顶策略）实现时定
