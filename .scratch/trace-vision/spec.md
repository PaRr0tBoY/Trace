# Trace AI 管道重构规格（活动 → 决策 → 记忆）

Type: spec
Status: ready-for-agent
来源：2026-08-11/12 grilling 全会话（候选 1-7 逐项 + 新讨论评估）+ Graphiti/Screenpipe 调研（见 ref/）。本规格替换旧 t09 愿景规格（git 历史可查）；旧规格中已完成项（任务层 UI、t11-t30）与未纳入本波的 V2 交互不迁移。架构原则另记 ADR-0005；领域词汇见 CONTEXT.md。

---

## Problem Statement

Trace 已经能建议任务了，但建议层是"一个引擎包办一切"：触发、分段、归属、LLM 注解、提交全在 suggestionEngine 里，改一处动全身。用户实际面对的问题：

- **任务识别浅**：只有应用名和窗口标题，系统说不清"我现在到底在做什么"；没有"当前任务"这个概念——多个任务可以同时 Active，系统不知道哪个在跑。
- **重复建议**："开发 Trace AI"和"完善 Trace AI Memory"被当成两次新建议；忽略一次只挡 1 小时，同类建议反复打扰。
- **AI 不可解释**：建议从哪来、看到了什么、为什么这么判断，用户和开发者都查不到；改一次 prompt 就不知道历史判断为什么变。
- **隐私靠散点**：采集有三开关，但 AI 层和记忆层没有门；剪贴板内容一旦给 AI 用就是第一次出本机，没有任何开关。
- **本地智能依赖外部运行时**：Ollama 集成意味着用户要先装一个第三方服务，违背"嵌入产品内部"的定位。
- **质量无基准**：改聚类参数、改 prompt，好坏全凭感觉，没有可回归的评测。

目标：把"单个建议引擎"重构成**活动 → 决策 → 记忆**的明确流水线，让 AI 成为可解释、可控制、可度量的可选增强——大多数时间安静，只在真正不确定时才动用。

## Solution

四层管道 + 两个横切面：

```text
采集 → 证据时间线（SQLite）→ 聚类（ActivityLedger）→ [本地模型 可选] → 决策（两级）→ 会话/提案 → 任务
                                                                          ↘ 记忆（时段整理）
横切：隐私门（采集/AI/记忆三权 + 证据深度 × 敏感度）· AI 依据（trace 可追溯）
```

关键机制：

1. **活动是观察对象、会话是解释对象**：聚类产出 Activity（1:N 归入 TaskSession），不再让 Activity 生命周期直接等于会话生命周期。
2. **当前任务唯一**：全局只有一个 RUNNING；WAITING 是系统推断休息态，PAUSED 是用户手动态（免疫自动恢复）；状态带来源与原因标注。
3. **两级决策**：主路径 = Task Change Detector 门控 + `evaluateTaskContext` 一次性决策（continue/switch/new/merge/ignore）；99% 普通状态 0 次 LLM 调用；只有高不确定才升级到 ≤3 次工具调用。
4. **记忆 = 事实图**：episode/entity/fact 三类表；画像/模式等是 fact 的类型不是独立表；时段整理用 combined extraction（整批 ≤2 次 LLM 调用）+ 确定性去重/矛盾消解。
5. **隐私三权**：Capture/AI/Memory 三个权限面，AI 政策五维（拒绝清单/内容类型/时间范围/剪贴板/记忆）；证据深度（L0–L4）与敏感度两维分离；被拒数据绝不进 Agent（预填也过门）。
6. **AI 依据**：trace 表为 canonical，任何决策可追溯到"看到了什么、召回了什么、为什么"；开发者可导出 HTML 报告，用户可在提案卡/任务详情查看依据。
7. **本地模型**：Qwen3-0.6B（Q8_0、/no_think、严格 JSON）嵌入产品内部（node-llama-cpp），默认关、按需下载、失败降级纯算法；Ollama 全部删除。
8. **Golden Dataset**：dev/eval 分层、七项一级标签，作为所有聚类/模型/Agent 改动的回归基准。

铁律（沿用并强化）：**AI 无决定权**（决策只作提案，状态转换由确定性状态机执行约束）；**推断可解释**（AI 依据 + 状态来源）；**采集分级**（L0 默认开，L3 预留）；**记忆写入经用户确认**；**本地模型 ≠ 必需依赖**。

## User Stories

### 活动与证据

1. 作为用户，我想采集事件（应用切换、剪贴板复制）持久化为证据时间线（带时间与来源），以便"之前发生了什么"可查、可回溯。
2. 作为用户，我想聚类模块把行为证据整理成活动（应用集、窗口标题、时长、剪贴板材料、归属目标），以便 AI 不用直接面对原始事件。
3. 作为用户，我想任何活动都能回溯到构成它的事件，以便判断有据可查。
4. 作为用户，我想活动记录其分析版本（classifierVersion / promptVersion），以便换模型后历史判断仍可解释。

### 当前任务与会话

5. 作为用户，我想系统自动判断我当前正在进行的任务（全局唯一 RUNNING），以便不用手动标注"我现在在干嘛"。
6. 作为用户，我想全局同时最多一个任务在 RUNNING（域层强制），其余自动进入 WAITING，以便状态诚实且不打架。
7. 作为用户，我想手动暂停的任务不会被系统自动恢复（PAUSED 免疫），以便我的明确意图不被覆盖。
8. 作为用户，我想区分"你暂停了"与"系统判断等待中"（statusSource / statusReason），以便不被系统自作主张迷惑。
9. 作为用户，我想每次连续运行记录为一个任务会话（起止、置信度、切换原因、前一任务），以便回顾"今天哪段时间在做什么"。
10. 作为用户，我想任务切换需要持续证据（滞回 30–60 秒 + 分数差阈值），以便短时离开不误判、不抖动。
11. 作为用户，我想完成的任务标记 COMPLETED、结束生命周期的标记 ARCHIVED，以便任务列表不腐烂。
12. 作为用户，我想旧数据迁移时多 active 只保留最近活跃者为 RUNNING，其余降 WAITING，以便升级不丢数据不炸状态。

### 提案与建议

13. 作为用户，我想候选任务以提案形式出现（标题、理由、关联应用/窗口、剪贴板材料、证据、置信度），以便判断是否采纳。
14. 作为用户，我想提案分三级：L1 主动建议到任务顶部（含折叠时边缘指示器）、L2 保留候选区不提醒、L3 不展示，以便建议以精取胜。
15. 作为用户，我想 L1 提案需要高置信度 + 证据稳定 + 提案新颖 + 近期无同类拒绝，且只能从 L2 升级（禁 L3→L1 直升），以便通知不反复横跳。
16. 作为用户，我想同类提案按语义指纹冷却（L1 24h / L2 48h / L3 7d），以便不重复打扰。
17. 作为用户，我想采纳提案时命中已有任务则并入、否则新建，以便一键采纳。
18. 作为用户，我想忽略提案时记录原因（不感兴趣/重复/错任务/暂不想处理），以便系统学习我的偏好。
19. 作为用户，我想语义重复的候选被去重（批内相似合并；与现有任务比对时强化该任务置信度），以便候选数量明显减少。

### AI 决策（两级）

20. 作为用户，我想系统在正常情况下不调用大模型（99% 时间静默），以便低延迟、低花费。
21. 作为用户，我想系统只在真正不确定时动用 AI（候选竞争、疑似新任务、长时间中断恢复、多任务竞争、会话边界），以便 AI 用在刀刃上。
22. 作为用户，我想 AI 决策基于最小预填（当前活动、当前会话、≤3 确定性候选、已匹配记忆、画像），以便快速且便宜。
23. 作为用户，我想 AI 需要更多信息时通过工具按需查询（任务、记忆、活动、剪贴板预览），以便不一次性塞全部上下文。
24. 作为用户，我想无 AI 配置或失败时任务系统照常工作（算法决策、算法标题兜底），以便 AI 是增强不是依赖。

### 记忆

25. 作为用户，我想长期记忆沉淀为事实图（episode / entity / fact 三类，带时间有效性与来源链），以便工作模式可追溯。
26. 作为用户，我想时段整理自动提炼事实（combined extraction，整批 ≤2 次 LLM 调用，会话结束 + 时段边界 + 6h 兜底触发），以便记忆不过时、成本可控。
27. 作为用户，我想预填的记忆是确定性预筛的结果（活动/时间/实体命中的 matchedMemories），而不是"记忆 Top-K 硬塞"，以便预填的都是有用的。
28. 作为用户，我想记忆可沿关系扩散检索（默认 1-hop、最多 2-hop，命中路径记入 trace），以便找到间接相关的上下文而不泛滥。
29. 作为用户，我想画像分显式（我填写的）与推断（AI 归纳）两类，显式永远优先，冲突需我裁决，以便 AI 不曲解我的自述。
30. 作为用户，我想在记忆面板看到事实、来源、冲突并确认/忽略/封禁，以便记忆可审查、可清除。

### 隐私

31. 作为用户，我想所有隐私设置集中在一个隐私分区（采集 / AI / 记忆），以便一处掌控。
32. 作为用户，我想 AI 政策按应用拒绝清单、内容类型、时间范围、剪贴板访问、记忆访问五维配置，以便细粒度控制 AI 能看到什么。
33. 作为用户，我想被拒绝的应用的活动不进 AI（算法层照常本地工作），以便隐私与本地功能两不误。
34. 作为用户，我想证据深度（L0–L4）与敏感度分开判定，以便"能看但敏感拒看"（如一张截图 L3 深度但 privacy=denied）可以表达。
35. 作为用户，我想剪贴板内容默认仅以预览（文本 ≤200 字符、图片尺寸/字节、文件路径）进 AI 且可整体关闭，以便新暴露面可控。
36. 作为用户，我想隐私拦截行为被记录并标注（"已被隐私政策过滤"），以便知道为什么这次没有建议。
37. 作为用户，我想 OCR 在采集开关之外还要过 AI 权限门（AI 关闭时不跑 OCR），以便不做无意义采集。

### AI 依据与调试

38. 作为用户，我想每个 AI 决策都能在提案卡/任务详情看到依据（看到了什么、召回了什么、为什么），以便信任可建立。
39. 作为开发者，我想 trace 数据可导出 HTML 报告看完整处理链条（含各版本信息、检索命中原因），以便调试与回归。
40. 作为用户，我想一键清除 AI 依据数据，以便随时清空。
41. 作为用户，我想 trace 数据以 trace 表为唯一事实源、JSONL 只作诊断/导出，以便不会出现"哪个是真的"的困惑。

### 本地模型

42. 作为用户，我想本地模型作为可选增强（默认关），设置里开关、下载进度、手动 .gguf 路径，以便不强行增加体积。
43. 作为用户，我想本地模型做候选过滤（≤3）、标题草稿、rerank，失败/关闭自动降级纯算法，以便语义增强但不添乱。
44. 作为用户，我想本地模型不依赖任何外部运行时（无 Ollama），嵌入产品内部，以便开箱即用或干脆不用。
45. 作为用户，我想本地模型输出为统一的候选结构（CandidateActivity），以便它失败时绝不污染 Agent 数据结构。

### 推荐与质量

46. 作为用户，我想建议的采纳/忽略反馈沉淀为模式记忆（采纳增强、忽略按原因衰减），以便系统越来越懂我。
47. 作为开发者，我想 Golden Dataset（dev/eval 分层、七项一级标签）作为回归基准，每次聚类/模型/Agent 改动可跑分（precision/recall/去重率/切换准确率），以便质量提升可度量。

## Implementation Decisions

### 1. 总体架构

- **Main 是唯一真实来源**：状态、决策、记忆、trace 全部由 main 持有；renderer 是推送视图缓存。不反转。
- **IPC 四文件合约**不变：新增/改名通道必须同步契约映射 / EdgeApi / preload / handler 四处；通道名 `suggestion:*` / `state:suggestions` 与 UI 文案（"候选任务"，ADR-0004）保持不动，内部类型 Suggestion → TaskProposal 全仓改名。
- **纯逻辑与 Electron 胶水分离**（硬约束，沿用）：全部新模块无 Electron 依赖、依赖注入（时钟、持久化、provider），vitest 直测。
- **模块**：activityLedger（聚类）、agent（决策协议 + 工具升级路径）、currentTaskController（门控 + 滞回 + 决策组装）、TaskStore（任务域 + 状态机不变量 + commit 接缝）、evidenceStore（证据时间线）、memoryGraph（记忆三表）、privacyGate（政策）、recommendationHistory（推荐记录）、traceStore（AI 依据）、localModelManager / localModelRuntime（本地模型）。suggestionEngine 收缩为生命周期控制器（定时、pending、采纳/忽略、提交编排）。
- **不新增"Manager/Engine/Layer"式模块**；CurrentTaskController 独立于 TaskStore，但不再细分出 StateMachine 模块——状态机就是 TaskStore 的 transition 方法与不变量本身。

### 2. 证据时间线（SQLite）

- 新增 SQLite 本地库（better-sqlite3）作为 canonical store，文件与现有 JSON 存储并列；events 表 + FTS5 全文，订阅事件总线落库（应用切换、剪贴板复制），含来源与时间戳。
- 保留期默认 30 天、设置可调；清理是后台任务，不阻塞采集。
- `search_activities` 工具支持两种模式：时间窗 + 关键词查询，以及按 id 取单条详情（含剪贴板材料预览）。

### 3. ActivityLedger（聚类模块）

Activity 是**观察对象**（会话是解释对象），不持久化；聚类逻辑从建议引擎整体迁入（触发游标、分段参数、归属、签名、忽略表），行为对算法路径零变化。Activity 形状（契约，比散文精确）：

```ts
interface Activity {
  id: string
  startAt: number
  endAt: number
  apps: { id: string; name: string; durationMs: number; windows: string[] }[]
  clipboardRefs: string[]        // itemId 引用（含来源应用）
  attribution?: { taskId: string; confidence: number }
  signature: string              // 应用组合 × 时段签名（忽略/冷却用）
  classifierVersion: string
  promptVersion?: string
  sessionId?: string             // 所属会话（1:N 容器关系）
}
```

### 4. 任务状态机与会话

状态语义重构（域层强制）：

```ts
type TaskStatus = 'running' | 'waiting' | 'paused' | 'completed' | 'archived'
type StatusSource = 'user' | 'system'
// Task 增加：statusSource、statusReason?（如 activity_lost / user_paused / auto_switch / user_resumed）
```

- **不变量：runningTaskCount ≤ 1**，由 TaskStore transition 方法强制；RUNNING 切换 = 旧任务 settle 会话 + 新任务开会话，原子。
- **PAUSED 免疫自动恢复**；WAITING 是系统推断休息态（可自动回 RUNNING）；COMPLETED / ARCHIVED 仅用户操作；ARCHIVED 不可自动复活。
- 自动暂停阈值、滞回参数沿用现有设置模式（钳制登记三处）。
- 迁移：多 active 旧数据只保留最近活跃者为 RUNNING，其余降 WAITING（statusSource=system）。
- **TaskSession**（一等对象，会话是活动容器）：

```ts
interface TaskSession {
  id: string
  taskId: string
  startedAt: number
  endedAt?: number
  confidence: number
  transitionReason: string
  previousTaskId?: string
}
```

- `TaskStore.commit(proposal)` 只处理 new / update / merge（封装现有三连跳）；不负责"何时切换"。
- 现有 activeMs 聚合（ADR-0006）语义不变，会话在此基础上提供实例级历史。

### 5. CurrentTaskController（主 seam）

独立纯逻辑模块，位于聚类与 TaskStore 之间：

```ts
interface CurrentTaskController {
  observe(activity: Activity): ControllerOutcome   // 主 seam
}
// 内部状态：currentTaskId / currentSessionId / candidateSince / lastEvidenceAt / switchConfidence
// 输出：决策、提案、会话切换、状态迁移、trace 追加
```

- **Task Change Detector（确定性、免费）**：仅在候选分数跌破阈值、候选超当前 + margin、出现新语义簇、长 idle 后恢复、多任务竞争、会话边界时调用决策者；其余 observe 直接 continue——**99% 普通状态 0 次 LLM 调用**。
- **滞回**：候选需持续 ≥30–60 秒且分数差 ≥ margin 才切换（参数进设置）。
- 决策者可替换：Agent / 本地模型 / 纯算法都实现 evaluateTaskContext，controller 不感知谁在做。

### 6. 决策协议（evaluateTaskContext）

统一 seam，判别联合（契约）：

```ts
type TaskDecision =
  | { action: 'continue'; taskId: string; confidence: number; reason: string }
  | { action: 'switch'; fromTaskId: string; toTaskId: string; confidence: number; reason: string; evidence: string[] }
  | { action: 'new'; title: string; confidence: number; reason: string; apps: string[]; evidence: string[] }
  | { action: 'merge'; fromTaskId: string; toTaskId: string; confidence: number; reason: string }
  | { action: 'ignore'; reason: string }
```

- **主路径 = 一次性决策**：最小预填 = 当前活动 + 当前任务会话 + ≤3 确定性候选 + matchedMemories（确定性预筛：活动/时间/实体/相关性命中，非 Top-K）+ 画像（显式 + 相关推断）；预填组装过程整体过隐私门。
- **升级路径**：决策者判断信息不足或低置信时，允许 ≤3 次工具调用（search_tasks / search_memories / search_activities / search_clipboard，后者仅预览）；工具面固定四个，禁止"getEverything"类工具。
- **本地模型中间结构**（决策者的公共输入）：

```ts
interface CandidateActivity {
  activityId: string
  candidateTaskId?: string
  semanticLabel?: string
  score: number
  evidenceRefs: string[]
}
```

- 本地模型 = CandidateActivity 优化器（过滤 ≤3 / 标题草稿 / rerank）；失败或关闭 → 算法候选原样传递，绝不污染决策数据。
- 决策产出：continue/switch 驱动状态机；new/merge 产生提案（≤3）；ignore 记推荐历史。全部记录进 trace。
- suggestTitle（保存时自动标题，ADR-0003）迁入 agent 模块，IPC 通道与触发条件不变（标题空 + 其他内容非空才生成，无独立按钮）。

### 7. 隐私门

```ts
interface PrivacyPolicy {
  aiEnabled: boolean
  deniedApps: string[]                       // exePath 归一化
  allowedContentTypes: ('text' | 'image' | 'files')[]
  aiTimeRangeHours?: number                  // 不限 = undefined
  clipboardAccess: boolean                   // search_clipboard 总开关
  memoryAccess: boolean                      // search_memories / 预填记忆
  memoryEnabled: boolean                     // 记忆写入主开关
}
```

- 三个纯函数出口：captureAllowed / aiAllowed / memoryAllowed；**证据深度（EvidenceLevel：L0 元数据 / L1 结构化 / L2 语义 / L3 视觉 / L4 历史）与隐私敏感度是两个正交维度**，政策按（应用、内容类型、时间范围、工具）判定，深度只是数据的属性。
- 落点：采集器（现有三开关行为不变）、**决策预填**、全部工具、记忆写入；OCR 改为"采集开关 + AI 权限"双过门才跑。
- 拒绝清单命中的应用：AI 层（预填 + 工具）整体过滤，算法层照常本地工作；这类活动的建议标题走算法兜底。
- 拒绝行为记录（元数据 + 原因）进 trace 与诊断日志；AI 依据 UI 标注"已被隐私政策过滤"。
- 默认值：全开显式可见（含剪贴板预览访问），设置页明示每个开关——这是唯一相对现状的行为变化（剪贴板内容首次可出本机，仅预览、可关）。

### 8. AI 依据（trace）

- **trace 表为 canonical**；JSONL 降级为 crash-safe append / 诊断 / 导出 / HTML 报告输入，不与 DB 平级。
- 记录：观察到（活动摘要）、召回了（各工具调用：工具/查询/条数/预览 ≤200 字符）、决策（理由全文 + 评级 + 置信度）、结果（采纳/忽略回填）；**版本信息**（agentVersion / policyVersion / classifierVersion / promptVersion）；检索命中路径与 hop 数；隐私拦截。
- 保留：已采纳提案的 trace 随任务活；未采纳的随推荐历史 30 天清（设置可调）。
- 展示：提案卡 / 任务详情"AI 依据"入口（同一组件）；开发者 HTML 报告导出（完整链条）；"清除 AI 依据"按钮。

### 9. 推荐历史与评级

```ts
interface RecommendationRecord {
  fingerprint: string     // 语义指纹 = 语义簇 + 关键实体 + 时段
  level: 1 | 2 | 3
  shownAt: number
  outcome?: 'accepted' | 'ignored' | 'dismissed' | 'noop'
  actionReason?: 'user_confirmed' | 'user_manually_dismissed' | 'wrong_task' | 'already_exists' | 'not_now'
}
```

- 冷却：同指纹 L1 未采纳 24h / L2 忽略 48h / L3 同类 7 天；现有忽略 LRU 并入。
- 评级稳定性：L1 需高置信度 + 证据稳定 + 提案新颖 + 近期无同类拒绝；**L1 只能从 L2 升级**；级别变化随记录。
- 去重两路：批内语义相似合并（本地模型开时；关时确定性签名）；与现有任务比对（应用集/时段重叠，确定性，永远生效）→ 强化该任务置信度或丢弃候选，匹配信号沉淀进模式记忆。
- Pattern 学习：采纳增强、忽略按 actionReason 衰减、用户编辑标题是最强信号（意图五档权重）。

### 10. 记忆上下文图

- **只有三类表**：episodes / entities / facts（+ FTS5）；Profile / Pattern / Task 记忆 / Preference 一律是 fact 的 type / source 字段，不建独立表；UI 分组 = 按 fact type 过滤的视图。事实带 valid_at / invalid_at / expired_at、来源 episode 链、用户状态（confirmed / suggested / ignored / banned）。
- **时段整理**：新 episode 原始落库（免费）→ 会话结束 / 时段边界 / 6h 兜底触发 → 整批 combined extraction（extract_nodes_and_edges 一次 + 批量时间戳一次，≤2 次 LLM 调用）→ 确定性去重（归一化键 + 余弦 ≥0.6 合并）/ 矛盾消解（时间有效性冲突写 invalid_at）。
- 权重：意图五档（用户编辑 > 用户创建 > 采纳建议 > 系统推断） × 现有衰减 × 时段字段。
- 画像：explicit（设置自述，永远优先）与 inferred（整理归纳）分离；矛盾 → Conflict 状态，不自动覆盖，记忆面板裁决。
- 检索：FTS5 + 实体匹配 + 时间过滤 + 关系扩散（**默认 1-hop / 上限 2-hop**，命中路径与原因记入 trace）；**不加 embedding**（本地模型 ≠ 嵌入模型；FTS5 + 实体 + 时间 + 扩散 v1 足够，嵌入模型留待需要时单独引入）。
- 迁移：memories.json 一次性迁入 facts（source / userState 不变），迁完删除。
- MemoryStore 保持纯逻辑核心 + 持久化适配器（本次换 SQLite 适配器，未来可换后端）。

### 11. 本地模型与 Ollama 删除

- **删除 Ollama 全链路**：provider 探测/预填、`ai:detect-ollama` 通道、preload/bridge 方法、设置页检测与"添加本地"按钮、30 语言 i18n 键、ProviderConfig.kind 字段、启动预填、相关测试。
- **LocalModelManager / LocalModelRuntime 分离**：Manager 管 registry / download / checksum / path / availability / lifecycle；Runtime 管 load / infer / queue / timeout（worker 线程，不阻塞主进程）。
- 模型：Qwen3-0.6B GGUF（Q8_0，官方仓库）、`/no_think` 显式关闭思考、短上下文、低 max_tokens、严格 JSON 输出（客户端校验 + 重试）、低 temperature。
- 获取：设置开关 + 首次启用自动下载（带进度）+ 手动 .gguf 路径；不捆绑安装包。
- 接入点：聚类产出候选后、决策前（过滤 ≤3 + 标题草稿 + rerank）；失败/关闭 → 纯算法路径，功能等价。

### 12. 设置与 i18n

- 新增**隐私分区**：采集（现有三开关迁入）+ AI（主开关 / 拒绝清单多选 / 内容类型勾选 / 时间范围 / 剪贴板访问 / 记忆访问）+ 记忆（主开关 + 推断记忆说明）。拒绝清单应用列表复用现有应用来源（L0 追踪 ∪ 剪贴板来源，图标现成）。
- AI 设置区：评级总开关 + L1 提醒开关（默认开，非隐私项不进隐私分区）。
- 画像字段：职业 / 自我介绍（预填给决策）。
- 本地模型设置：开关 / 下载进度 / 路径。
- 全部新字段走现有三处登记（Settings 类型 / DEFAULT_SETTINGS / merge 钳制）+ 30 语言 i18n。

### 13. Golden Dataset

- 目录分层：`golden/dev` 与 `golden/eval`（不混调参数据；train 当前不需要）。
- 一级标签七项：activity boundary（分段切点）/ current task / candidate ranking / switch decision / merge decision / suggestion level / reason。
- 种子：从 ai-log 历史真实决策导出（建议/采纳/忽略结果作隐式标签），人工抽查修正。
- 评估脚本输出：precision / recall / false positive / duplicate rate / switch accuracy；每次聚类、本地模型、Agent、记忆检索改动必跑。

## Testing Decisions

- **好测试的标准**：只测外部可观察行为——状态机转换、决策动作、门控触发与否、隐私拦截、冷却生效、记忆提取/矛盾消解、检索排序、保留期清理。不 mock 内部调用链、不断言私有函数调用次数。
- **主 seam（新）**：`CurrentTaskController.observe(activity)`——组装真实 stores（TaskStore / memoryGraph / evidenceStore / privacyGate 政策 / recommendationHistory / 注入决策者）后调用，断言输出。关键用例：
  - 门控：连续稳定活动 → 决策者 0 次调用（99% 不变量）；分数跌破阈值 → 恰好 1 次；多候选竞争 → 升级路径。
  - 滞回：候选持续不足 30–60s 不切换；持续满足 threshold + margin + dwell 才 switch。
  - 状态：切换原子性（旧会话 settle + 新会话开）；PAUSED 免疫（决策者说 switch 到 PAUSED 任务 → 拒绝）；runningTaskCount ≤ 1。
  - 隐私：denied 应用的活动 → 预填与工具均无该数据；clipboardAccess=false → search_clipboard 返回空 + 拦截记录。
  - 决策者替换：同一输入下 agent / 算法 / 本地模型（fake）产出一致结构；本地模型失败 → 算法候选原样。
  - 端到端：事件 → 活动 → 决策 → 提案 → 采纳 → 任务/会话/记忆/trace 全链一条测试。
- **模块单元缝（沿用现有 vitest 纯模块模式）**：activityLedger（分段/归属/签名，同 clusterer 测试先例）；TaskStore（状态机全转换表、迁移规则、commit 三态、merge 类型安全）；privacyGate（政策纯函数全维）；evidenceStore（落库/查询/保留期）；recommendationHistory（指纹/冷却/actionReason）；memoryGraph（提取/去重/矛盾/权重/检索 hop 上限/迁移）；localModel（注入 fake runtime 的可选性）。时间敏感逻辑全部注入时钟，不 sleep。
- **Golden Dataset 跑分**：主 seam 之上的数据回归层，作为阶段验收与回归门槛。
- **不测的**：IPC 合约（四文件由 typecheck 编译期校验，现有机制）；renderer UI（`npm run dev` 手动冒烟，现状路径）；原生模块打包加载（dev 模式 + 打包产物冒烟，非自动化）；窗口/拖拽行为（平台验证）。

## Out of Scope

- **V2 圆球磁吸交互**（旧 t09 愿景规格内容，不迁移）。
- **Screenpipe 集成**：不捆绑任何二进制；调研仅作架构参考。
- **云端 embedding / 外部向量库**：v1 检索无 embedding（本地模型 ≠ 嵌入模型）。
- **L3 视觉证据（截图采集）**：证据分级中 L3 只作分级占位，无采集实现。
- **L1 应用适配器**（Chrome/VSCode/Terminal 的 URL/workspace/cwd 采集）。
- **应用切换层的按任务组织窗口、窗口暂存、快速笔记**（旧愿景遗留，另行立项）——窗口级 Alt-Tab 切换器 v1 已落地（2026-08-13，feature/tabtab），不在本规格范围。
- **macOS**：平台已定 Windows。
- **任务系统遗留项**：无 priority/color、无回收站、无任务数上限。
- **Agent 完整自主循环**：本波 = 一次性决策 + 有限升级（≤3 次工具调用）；"替换成 AgentDecisionProvider"的扩展性由决策协议 seam 保证，不实现完整 Loop。

## Further Notes

- **ADR-0005**：本规格的架构原则（ActivityLedger 中间层 / Agent 判断不改核心状态 / Memory 三表时间上下文图 / SQLite canonical / 本地模型可选 / 无 Ollama / 隐私三权 / AI 依据解释基础设施）单独成文，不在此重复实现选择（Q8_0、调用次数等不进 ADR）。
- **阶段不变量（每阶段验收 = 不变量成立 + 测试绿）**：
  - A 地基：现有功能完全不变。
  - B 任务域：TaskSession 可解释当前 RUNNING。
  - C 证据时间线：任何 Activity 可回溯至 Event。
  - I AI 依据：任何 Agent decision 可追溯。
  - D 隐私门：被拒数据绝不进 Agent。
  - G 推荐历史：同类建议不重复打扰。
  - F 记忆图：任何长期记忆可回溯到 Episode。
  - H 本地模型：关闭后功能等价可用。
  - E 两级决策：99% 普通状态不触发 LLM。
- **实施顺序**：A → B → C → I → D → G → F → H → E → J（收尾），一个批次做完，不按版本迭代。
- **种子集协作**：Golden Dataset 种子从 ai-log 导出后由用户抽查修正（N4 决议）。
- **后续流程**：本规格就绪后走 `/to-tickets`（拆实现票，每张带 blocking 边）→ `/implement` 逐张（tdd + code-review）。
