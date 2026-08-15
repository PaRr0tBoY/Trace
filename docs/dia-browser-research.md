# Dia 浏览器"预测用户工作"功能调研

> 调研日期：2026-08-14
> 目的：为 Trace 的任务预测 / 建议引擎（currentTaskController、suggestionEngine、proposalGrading 等）提供外部产品参考
> 素材：Dia 官方 release notes / changelog / security FAQ 一手页面（已逐页抓取核实）+ Releasebot 版本时间线（releasebot.io/updates/dia）。正文中标注 **[推断]** 的是分析性内容，非官方确认。
> 原始笔记：`C:\Users\Acid\Downloads\chrome\Dia-浏览器-Morning-Brief.md`（ChatGPT 调研，含官方引用，本次已对关键引用逐一回源验证）

---

## 0. TL;DR

Dia（The Browser Company，2025 年起归入 Atlassian）用一年时间把浏览器从"网页容器"演化成了一套 **Memory → Context → Prediction → Intervention** 的主动工作系统。与 Trace 任务预测最相关的三个能力：

1. **Proactive Suggestions**（v1.19.0，2026-02）：打开新标签页时，根据 Calendar/Email/Slack/Tabs 上下文主动给出"下一步该做什么"的动作建议（不是搜索建议）。官方 slogan：*"Don't think about the next step. Take it."*
2. **Morning Brief**（v1.37.0，2026-06）：每天早上自动生成的工作简报，回答"今天你应该知道什么"，由后台数据准备 + AI synthesis 组成。
3. **Live Tab Groups**（GitHub v1.17.0 → Docs → Meeting）：基于外部工具状态（PR 待 review、文档被 @、会议即将开始）**确定性**地自动浮现"当下重要的工作"，做完自动消退。

Dia 与 Trace 的架构同构度很高（事件流 → 归因 → 聚类 → 状态推断 → 建议），但 Dia 的产品化程度领先在三个点：**预测"动作"而非"内容"**、**工作自动浮现/自动消退**、**未完成工作推断（prospective memory）**。

---

## 1. 全景：一条从 Memory 到 Intervention 的链路

官方 release notes 与 security FAQ 交叉验证后，Dia 的体系可以抽象为五层：

```text
L0 Activity        浏览历史、Tabs、Calendar、Email、Slack 事件流
L1 Memory          服务器生成 summaries（存储于本地设备）→ 语义记忆
L2 Retrieval       Search Memory → Automatic Memory Search（自动判定是否需要历史）
L3 State Inference Automatic Tab Group Names / Live Groups / Meeting Groups → 用户正在做什么
L4 Prediction      Proactive Suggestions → 用户接下来可能要做什么
L5 Intervention    Morning Brief / Proactive Suggestions → 现在应该提醒用户什么
```

官方在 v1.19.0 的原话是：*"We've been asking how you actually work—and what breaks your momentum. What we heard wasn't big blockers, but constant competition for your attention: a calendar invite colliding with an email, a Slack message pulling you from an important tab."* —— 产品目标是缓解**注意力竞争**，不是信息聚合。

---

## 2. 功能时间线（2025-08 → 2026-08）

| 版本 | 日期 | 与"预测工作"相关的内容 |
|---|---|---|
| v0.44.0 | 2025-08-27 | Memory **Profile 级开关**（按 persona 隔离）；Per-Chat Personalization 开关；@history 纳入 Chats |
| v0.45.0 | 2025-09-07 | **Browsing History Skills Pack**（future-self / daily-wrap / weekly / reflect）；ChatGPT 历史导入为 Memories；Memory 排除敏感网站 + incognito + 网站级 opt-out（自动删除该站历史 Memories）；**Chat 的 AI 回答排除在 Memory 外**（Memory 只反映"用户做了什么"）；Activity summaries 格式化 |
| v1.0.1 | 2025-10-08 | **Search Memory 取代 @History**（prompt 中的 @mention 工具，引用个人上下文更可靠） |
| v1.4.0 | 2025-11-05 | **Automatic Memory Search**：无需 @mention，自动判断问题是否需要历史；profile-specific |
| v1.6.0 | 2025-11-20 | **Automatic Memory Search "truly automatic"**：更多触发场景（past events / out-of-context knowledge），失败重试；Slack Search Tool |
| v1.17.0 | 2026-02-05 | **GitHub Live Tab Groups 首发**：打开 PR 自动建组，展示 opened + awaiting review，合并/关闭自动消退，reauthenticate 视觉提示 |
| v1.19.0 | 2026-02-19 | **Automatic Tab Group Names**（按内容 + 已知用户信息生成，随内容演化）；**Proactive Suggestions 首发**（new tab 早晨建议：review notes / polish presentation / 赶 deadline；dismiss / 自然消失 / Personalization 关闭） |
| v1.22.0 | 2026-03-11 | **Proactive Suggestions 深化**：*"Don't think about the next step. Take it."*；官方示例（昨日 1:1 notes 跟进、10am 会议 Figma 预检、漏掉的 LinkedIn 回复）；Command Bar 直通 Chat / Google Search |
| v1.23.0 | 2026-03-19 | GitHub Live Groups 改进：review/merge 完成动画、合并后自动清理、hover 预览最近完成 PR |
| 2026-04-16 | | **Live Docs**：Notion + Google Docs 的 comments/suggestions/mentions/viewer counts 自动浮现，链接直达变更处，处理完自动淡出 |
| 2026-05-07 | | Morning Brief 用真实联系人姓名；Slack 附件（截图/PDF）可读入上下文；Google Drive 通知（"what's been shared with me recently?"） |
| 2026-05-14 | | GitHub Live Group hover 显示 CI 状态 / merge conflict / diff 大小；Confluence 加入 Docs Live Group；tab group 自动分配 emoji；Notion mentions/comments 进 chat |
| 2026-05-28 | | Tab Search / Tidy Tabs（12h–7d 未触碰自动清理，可每日自动）/ Quick Switch |
| v1.36.0 | 2026-06-18 | **Meeting Tab Groups**：从 calendar preview / meeting reminder 加入会议时自动建组，meeting tab 锚定，会议相关链接（invite / agenda / docs / boards / tickets）自动落组 |
| v1.37.0 | 2026-06-25 | **Morning Brief 首发**（"What we're building, unfiltered"）：Settings > Apps > New Chat 开启，连接工具后次日生成；**Slack 为最低要求**；官方明示"可能坏、可能崩，欢迎一起探索摩擦" |
| v1.38.0 | 2026-07-02 | Morning Brief 使用案例：👀 emoji 标记事项汇总、*"who do I still owe a reply to"*（跨 Slack/Gmail/Notion 的未完成承诺）、**全天候使用**（to-do 清单 hover 查看/勾选）；New Tab Page 离开自动清理 |
| v1.39.0 | 2026-07-09 | **Reports**（用户主动请求 → 跨应用检索 → 文档化报告，可内联编辑/样式化；Files 统一管理） |
| v1.41.0 | 2026-07-23 | New Chat 会**反向提问**澄清需求（"AI 不可能全知"） |
| v1.42.0 | 2026-07-30 | Windows 版预告（2026 秋，Windows Wednesdays 系列） |
| v1.43.1 | 2026-08-06 | Profiles context switching（swipe 切换，登录/工具/AI/上下文各归其位） |
| v1.44.0 | 2026-08-13 | LinkedIn 集成（对话式检索候选人） |

---

## 3. 核心功能拆解

### 3.1 Proactive Suggestions —— 与 Trace 建议引擎最接近的功能

**形态**：打开 New Tab 时，命令栏下方展示 3 条左右个性化建议，每条是一个**可执行动作**（打开链接 / 回复某人 / 跟进事项），可 dismiss、可自然淡出、可在 Personalization 设置整体关闭。

**v1.22.0 官方三个示例**（可抽象为三条推断规则）：

| 输入信号 | Dia 推断 | 建议动作 |
|---|---|---|
| 昨天有 1:1 + 存在 notes | 事项未完成，记忆还新鲜 | Review / follow up（跟进昨天讨论的议程项） |
| Calendar 10am 有 presentation + 关联 Figma | 即将发生的工作 | 提前打开 Figma，检查 RND 3 的修改 |
| LinkedIn 有漏掉但想回复的消息 | 有待处理事项 | 现在回复 Christina（不用下班后再补） |

**关键定性**：这是 **Action Suggestion，不是 Search Suggestion**。它不是预测"你可能搜索什么关键词"，而是预测"根据你已经在做的事情，你下一步大概率要继续做什么"。官方原话：*"based on what you were already in the middle of—and a preview of what might be coming up next"*。

**核心机制（官方行为描述，实现细节未公开）**：

```text
Activity + Calendar + Communication + Recent Tabs + Memory
        ↓
Current Work Context
        ↓
Unfinished Work（未完成）+ Upcoming Events（即将发生）
        ↓
Next Action
        ↓
Ranking → 3 条以内建议
```

**与 Trace 的关系**：这正是 Trace `currentTaskController` 的产出形态——只是 Trace 目前把建议呈现在"任务备选卡"，Dia 把它放在 New Tab 的**搜索入口位置**，用"下一步动作"替代"搜索建议"。交互层（dismiss / fade / 可关闭）值得照搬。

### 3.2 Morning Brief —— 每日入口版的预测输出

**v1.37.0 官方定位**（"What we're building, unfiltered"，产品哲学宣言）：

> "Mornings are their own small defeat. You open the laptop and it's all already waiting: the forty tabs you left for some better-rested version of yourself, the thread that reached a decision without you, the email you've put off so long that answering it now is practically a confession. ... It remembers what slipped through the cracks, what deserves your focus, and quiets the storm long enough for you to start the day on your terms."

**触发与生成**：Settings > Apps > New Chat 开启，连接工具后**次日**收到第一份（Slack 最低要求，连接越多越丰富）。v1.38.0 用户案例显示它包含 to-do 清单，可全天 hover 查看、勾选。

**Security FAQ 一手确认的数据流**：

> "Some features, like the Morning Brief, do this on their own to prepare information for you." —— Morning Brief **自行处理数据以提前准备信息**（后台持续准备，非用户打开时才现场生成）。

> "Memory allows you to ask Dia about your previous activity. This is powered by summaries, created on our servers and stored locally on your device." —— 语义记忆 = 服务器生成 summaries + 本地设备存储。

**[推断] 架构**：后台持续观察/同步上下文 → 数据准备 → AI synthesis → 早上生成 Brief。即"在用户提出问题之前就开始工作"的 ambient agent 形态。

**与 Morning Brief 易混淆的区分**（官方语义）：
- Morning Brief：*"What should I know?"* —— 主动推送"今天值得知道什么"
- Proactive Suggestions：*"What should I do?"* —— 主动推送"现在应该做什么"
- Reports（v1.39.0）：*"帮我把 X 整理成报告"* —— 用户主动请求，产出可编辑文档

### 3.3 Live Tab Groups —— 确定性的"工作状态"展示

这是 Dia 最独特的设计：**不靠 LLM 生成，靠工具状态确定性驱动**。

- **GitHub Live Tab Groups**（v1.17.0）：打开 PR 自动创建 sidebar 组，展示你开的 PR + 等你 review 的 PR；pinned 常驻；合并/关闭自动退出；GitHub 断连有 reauthenticate 提示。官方定位：*"your browser can automatically surface the work that matters right now, and let it fade away when it doesn't"*。v1.23.0 加了完成动画、合并后自动清理、hover 恢复最近完成 PR。v1.44.0 之前 hover 可看 CI 状态 / merge conflict / diff 大小。
- **Live Docs**（2026-04-16）：Notion + Google Docs 的评论/建议/提及/分享自动浮现，**链接直达变更处**（不是页面顶部）；处理完自动淡出；显示 viewer counts（"proposal 今天有 5 个人在看"）。*"Your work comes to you, stays in your line of sight while it matters, and cleans up when it's done."*
- **Meeting Tab Groups**（v1.36.0）：加入会议（calendar preview / reminder）自动建组，meeting tab 锚定，会议相关链接自动落组——把"工作事件"作为 context 的中心节点。

**设计要点提炼**：浮现标准是**外部状态变化**（PR 状态、@ 提及、会议开始），消退标准是**工作完成**（merge、处理完、会议结束）——用户不需要维护"我现在做到哪了、下一步是什么"。

### 3.4 Automatic Tab Group Names

不设手动名时，Dia 基于组内内容（topics / content / similarity）+ **它对你的已有了解**生成名字，且随组内容变化自动更新（v1.19.0）。本质是**工作内容聚类**：5 个标签页（GitHub PR + Linear issue + Figma + Slack thread + Google Doc）被识别为"同一个 Project Context"。2026-05-14 起组还会自动分配代表内容的表情符号。

### 3.5 Memory 体系（预测的支撑层）

与 Trace 的 memoryGraph / evidenceStore 高度同构，但有几个值得注意的设计决策：

1. **Memory ≠ Chat History**：v0.45.0 明确把 Chat 中 AI 的回答排除出 Memory——"Memory 反映用户实际做了什么，不是 AI 说了什么"。
2. **Profile 级隔离**（v0.44.0）：Work / Personal 各自独立的记忆命名空间。
3. **检索自动化演进**：@History（显式）→ Search Memory（显式工具）→ Automatic Memory Search（v1.4.0 自动判断）→ "truly automatic"（v1.6.0：更多触发场景 + 失败重试）。这是典型的 **memory routing**：意图检测 → 是否需要历史 → 检索。
4. **敏感内容排除**：敏感网站 / incognito 自动排除；网站级 opt-out 会**连带删除该站历史 Memories**。
5. **隐私边界**：本地加密存储；AI 数据经服务器转发给 OpenAI/Anthropic/Gemini，合同限制不训练；内容数据默认用于改进、30 天删除、可关。

### 3.6 Browsing History Skills —— 把历史当个人时间序列

官方 Skills（v0.45.0 推出，无需安装即用）：

- `/daily-wrap`：总结过去 24 小时的工作，输出 "What I got done yesterday / What I am planning to do today / Blockers"——**"今天计划"是推断出来的**，不一定存在 Todo List 里。
- `/future-self`：基于你的浏览历史和语气，写一封来自未来自己的信（偏娱乐，但证明 Dia 把浏览历史当作可推断"用户状态、目标、未来行为"的时间序列）。
- `/weekly` / `/reflect`：周回顾与反思提示。

---

## 4. 产品原则（官方表述提炼）

1. **预测"动作"，不预测"网页"**。搜索框的位置放的是"下一步动作"（跟进 notes / 预检 Figma / 回复某人），不是搜索词。
2. **自动浮现，自动消退**。*"Surface the work that matters right now, and let it fade away when it doesn't."* 用户零维护。
3. **未完成工作推断（prospective memory）**。昨天 1:1 的 notes 本身没告诉 Dia"提醒我跟进"，是 Dia 推断"相关工作可能尚未完成 → 今天仍然相关 → 现在是跟进时机"。
4. **变化检测优于状态罗列**。价值在于"Project A 昨晚已经做出决定，你无需继续等待"，不是"你正在做 Project A"。
5. **克制与退出权**。dismiss / 自然淡出 / 设置里整体关闭；Morning Brief 明示"可能不完美，欢迎摩擦"（实验性功能先放量再打磨）。
6. **确定性优先**。Live Groups 用工具状态驱动（PR merge 了就消失），LLM 只做命名/总结/建议等生成性部分。

---

## 5. 架构推断：以 TaskState 为中心的管道

官方未公开实现，以下是根据行为、release notes、security FAQ 还原的 **[推断]** 模型：

```text
                  EVENT STREAM
                 (browser / calendar / email / slack / github / docs)
                       │
              Context Linking（跨应用归因：这些信号是同一件事吗）
                       │
                    TaskState / WorkState
              { task, status, last_activity, evidence[],
                momentum, urgency, unresolved[], next_likely_action }
                       │
        ┌──────────────┴──────────────┐
        ↓                             ↓
  Unfinished Work               Upcoming Events
  （推断：昨天没做完的）          （calendar / PR review / 会议）
        └──────────────┬──────────────┘
                       ↓
                 Next Action（动作，不是内容）
                       ↓
                 Ranking / 冷却（3 条以内，dismiss 权重）
                       ↓
        ┌──────────────┴──────────────┐
        ↓                             ↓
  Proactive Suggestions         Morning Brief
  （"现在做什么"）                （"今天知道什么"）
```

关键结论：**最核心的数据对象是 TaskState / WorkState，不是 Memory**。Memory 只是证据来源。

---

## 6. 与 Trace 现状对照

### 6.1 已有对应（Trace 的决策管道与 Dia 同构度很高）

| Dia | Trace 对应 | 说明 |
|---|---|---|
| Event Stream | `activityLedger` 聚类管线（事件→段→簇） | 同构 |
| Context Linking | `attributor`（来源 app 归因）+ suggestionEngine 分段 | 同构，但 Trace 只有剪贴板单源 |
| TaskState | `currentTaskController` 的当前任务（六触发门控、dwell+margin 滞回、原子切换） | 同构且实现更细（滞回、门控） |
| Memory | `memoryGraph`（episodes/entities/facts）+ `evidenceStore` + `episodeConsolidator` | 同构（Trace 另有矛盾裁决、权重衰减） |
| Memory routing | 决策层按需检索（`decisionProvider` 工具面） | 同构 |
| Ranking / 冷却 | `proposalGrading`（L1/L2/L3 分级）+ `recommendationHistory`（24h/48h/7d 冷却 + 模式学习） | 同构且 Trace 的分级/冷却更形式化 |
| Privacy | `privacyGate`（capture/AI/memory 三权） | 同构 |
| 建议呈现 | TaskProposalCard（两行卡 + 剪贴板 chips + convert panel） | 形态不同：Trace 在任务视图内，Dia 在 New Tab 入口 |

### 6.2 差距与可借鉴点（按价值排序）

1. **建议的"动作化"**：Dia 建议是"Review 昨天的 1:1 notes / 打开 10am 的 Figma"——带**具体对象 + 动作 + 时机**。Trace 的备选建议目前偏"任务草稿"（标题 + 来源证据），可以补充"next action 式"的表达层：如"你 2 小时前在编辑 X，相关剪贴板还没粘贴完"。
2. **自动消退 / 完成感**：Dia 的 Live Groups 在 PR merge / 文档处理完时自动消失并给完成反馈。Trace 任务完成（suggestion:accept / task 完结）后缺少"从眼前退场"的仪式感；建议流缺少"已完成 → 淡出"的状态过渡。
3. **未完成工作推断**：Dia 推断"昨天 1:1 有 notes → 可能没跟进 → 今天提醒"。Trace 有 `recommendationFingerprint` 冷却和模式学习，但主要是"推荐过就不再推"，可以加"未完成推断"信号（如：某任务最近活跃后静默 N 小时、且当天时间窗匹配）。
4. **Morning Brief 式每日入口**：Trace 没有"早上打开时先看什么"的入口。可以把现有 `currentTaskController` 的稳态输出做成每日简报（基于 memoryGraph + activityLedger 的昨日变化），挂在面板打开时的首个视图。
5. **确定性状态展示**：Live Groups 的价值在于**不依赖 LLM** 的确定性浮现（PR 状态、@ 提及）。Trace 可以类比的是：把"待处理建议"做成由 proposalGrading 确定性驱动的常驻区块，而不是只在触发时弹出。
6. **Profile/persona 隔离**：Dia 按 Profile 隔离 Memory。Trace 目前无 persona 概念（单用户场景，优先级低）。
7. **搜索入口复用**：Dia 把建议放在命令栏位置，替代搜索建议。Trace 的搜索框（search input）在面板顶部，可以考虑在空搜索状态显示"下一步建议"。
8. **实验性发布姿态**：Dia 明示 Morning Brief"可能坏、欢迎摩擦"，先放量收集真实反馈。Trace 的建议引擎已有关闭开关/分级，可以借鉴"灰度文案"降低用户预期。

---

## 7. 来源清单

官方一手页面（2026-08-14 抓取核实）：

- Proactive Suggestions 首发：https://www.diabrowser.com/release-notes/1-19-0-tab-groups-and-proactive-suggestions （2026-02-19）
- Proactive Suggestions 深化：https://www.diabrowser.com/release-notes/1-22-0-dont-think （2026-03-11）
- GitHub Live Tab Groups 首发：https://www.diabrowser.com/release-notes/1-17-0-github-live-tab-groups （2026-02-05）
- GitHub Live Groups 改进：https://www.diabrowser.com/release-notes/1-23-0-from-review-to-merge-to-whats-next （2026-03-19）
- Morning Brief 首发：https://www.diabrowser.com/release-notes/1-37-0-morning-brief （2026-06-25）
- Meeting Tab Groups：https://www.diabrowser.com/release-notes/1-36-0-pip-stash （2026-06-18）
- Memory 体系：https://www.diabrowser.com/changelog/0-44-0 、/0-45-0 、/1-0-1 、/1-4-0 、/release-notes/1-6-0-conversations-context-chat
- Skills Pack：https://www.diabrowser.com/skills/packs/make-the-most-of-your-browsing-history
- Security FAQ（数据流与存储）：https://www.diabrowser.com/security
- 版本时间线（2026-01 起全量）：https://releasebot.io/updates/dia
- 最新版本 v1.44.0 LinkedIn：https://www.diabrowser.com/release-notes/linkedin-integration
- 原始调研笔记：`C:\Users\Acid\Downloads\chrome\Dia-浏览器-Morning-Brief.md`（ChatGPT 生成，引用已回源验证）
