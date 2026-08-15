# Map: Trace 2.0 愿景规格

label: wayfinder:map

## Destination

产出一份完整的 Trace 2.0 愿景规格（PRD + 技术方案）：把 Trace 从剪贴板管理器进化为"AI 原生个人工作上下文管理器"——Task 为核心理念，UI 分层（任务列表为核心层，文件中转站、剪贴板挂接现有能力），指定左侧灵动岛交互（V1 hover 模型 + V2 圆球磁吸规格）、可配置 AI provider（本地 + 云端）、以 Screenpipe 为事件数据底层（用户指定）的采集架构、长期记忆系统，并界定 V1/V2/V3 分期与范围。规格可交接给实现。

## Notes

- 域：Trace 仓库（Windows / Electron 34 / React 18 / TS 5 / Zustand / koffi FFI）。规格必须落在现有架构上：Main 单一真实来源、IPC 四文件合约（ipc.ts / bridge.ts / preload / main-ipc）、ItemStore 模式、置顶心跳与 OLE 拖拽约束。
- 每个 session 先读 AGENTS.md。任务系统旧设计（feature/tasks 已删）在 git 历史 3dc9b07 / f146a96，可参考、不可恢复代码。
- 技能：grilling / domain-modeling / research / prototype。
- 用户铁律：AI 无决定权（纯建议引擎，用户确认/编辑/忽略后才成立）；任何 AI 推断必须可解释；信息采集分级（L0-L3，L3 按需授权默认关闭）；记忆写入需用户确认。
- 已定决策：可配置 AI provider（本地 Ollama + 云端 API）；V1 沿用 hover 展开模型（圆球磁吸为 V2+ 规格）；应用切换层（Alt-Tab）后置为独立努力——**v1 窗口级切换器已落地**（2026-08-13，feature/tabtab 合并入 main：WH_KEYBOARD_LL 钩子跑在 utilityProcess、z-order 快照、面板整页替换、按住型交互，无标签页/无搜索）；按任务组织窗口、窗口暂存仍后置；Screenpipe 为事件数据底层候选——source-available 商业许可（个人非商业免费），商业化影响在 ticket 02 调研核实。
- 平台重定向：聊天记录（2026-07-13~16）假设 macOS（NSPanel/AppleScript），本图一切规格按 Windows/Electron 论证。
- 交流语言：中文。研究产出落 `.scratch/trace-vision/research/<slug>.md`，ticket 的 Answer 指向它。

## Decisions so far

- [全局悬浮球磁吸交互调研](issues/04-全局悬浮球磁吸交互调研.md) — 可行：独立球窗口（~48px, click-through）+ main 进程弹簧物理（复用现有 16ms 轮询）+ velocity 意图判定；展开用"隐藏球→面板弹出"严格串行；三个平台限制写入规格：独占全屏置顶无效、混合 DPI setPosition 偏移（workaround + 实机验证）、Electron 34 处于 SysDragImage 泄漏影响区间
- [Screenpipe 深度调研](issues/02-screenpipe深度调研.md) — 能力够用（事件驱动截图/OCR/Whisper/FTS5+语义搜索，Windows 一等公民，CPU 5-10% / RAM 0.5-3GB / 磁盘 5-10GB每月）；**许可锁定集成形态**：v2.19 起为 Screenpipe Commercial License（source-available），Trace 开源分发只能走 BYO sidecar（用户自装 + localhost:3030 REST，Bearer token 默认开），禁止捆绑任何 screenpipe 二进制，SDK 嵌入需企业商业授权；实时 app_switched 事件只有商业 SDK 有 → V1 自建 koffi 前台窗口轮询 + screenpipe 事后补上下文；中文 OCR 依赖系统语言包质量一般；常驻偶发崩溃需守护进程；API-only 集成属灰色地带，建议开工 05 前邮件 louis@screenpi.pe 书面确认
- [LLM 本地与云端选项调研](issues/03-llm本地与云端选项调研.md) — OpenAI 兼容 /v1/chat/completions 是所有目标端点共同分母，baseUrl+apiKey+model 三元组覆盖本地与云端；本地默认 Ollama（Qwen3-8B @8GB / Qwen3-14B @16GB，关 thinking），云端默认 DeepSeek（直连、最便宜），OpenAI/Anthropic/Gemini 被墙仅可选高级项；结构化输出两层降级（schema 合约 → json_object+prompt）+ 客户端校验重试；LiteLLM 网关对单应用不必要；Screenpipe 是上下文层非推理引擎，Trace 独立直连 LLM、只吸收其配置模型经验
- [任务数据模型与状态机](issues/01-任务数据模型与状态机.md) — Task = { id/title/status/note?/apps/resources/createdAt/updatedAt/lastActiveAt }，独立 TaskStore（tasks.json，剪贴板存储不动）；四状态规则驱动：Active↔Paused（无归属事件超阈值自动转，默认 15 分钟可配 1-120，用户也可手动暂停），Waiting/Completed 仅手动，Completed 保留可恢复可删（硬删+确认，无回收站）；AppRef 多对多 + lastContext 快照（exePath 归一化作 key）；资源 = itemId 引用 + 轻量快照（trim 驱逐后仍显示）；suggestion 瞬态内存不持久化，确认时匹配则 merge 否则新建（匹配判定归 07）；排序 = 状态分组 + lastActiveAt 降序，球显 Paused+Waiting 数；无 priority/color/上限
- [事件采集架构决策](issues/05-事件采集架构决策.md) — **Screenpipe 集成后置**（用户转向：后续找竞品或学习其事件驱动逻辑自研，02 调研保留作参考，许可风险消解）；V1 全自建：main 进程每 500ms koffi 轮询 GetForegroundWindow，前台窗口变化生成事件 {type:'app-switch', appName, exePath, pid, windowTitle, ts}（借鉴 ui_events 字段设计）→ 事件总线 → 任务归属器（更新 lastActiveAt/状态机）+ 内存环形缓冲事件日志（上限 1000，不持久化，07 的输入）；不做 SetWinEventHook；隐私 = 总开关 + L0 开关（默认开，仅应用/窗口标题/PID）+ incognito 联动暂停 + L3 开关预留（默认关）；无第二常驻进程
- [AI 建议引擎与 Provider 抽象规格](issues/07-ai建议引擎与provider抽象规格.md) — 触发 = 静默期（≥5 事件 + 静默 ≥60s，可配）；聚类 = **算法聚类 + LLM 辅助**（用户转向：规则预筛 → 纯算法归属判定，算法选型归 10 调研；LLM 只做标题/原因/低置信度标注，不判归属）；忽略去重 = 本地签名表（ignored.json LRU 200，LLM 无状态）；Provider = **多 provider 自动降级**（用户选定：OpenAI 兼容统一接口，主备链自动切换，仅限已配置链内；两层结构化输出降级 + 客户端校验重试；无 LiteLLM）；建议卡 = 可编辑标题 + 应用 chips + 置信度 + 可展开原因 + [确认/编辑/忽略]；未配置/全链失败 → 建议层静默降级，任务系统照常
- [任务聚类算法调研](issues/10-任务聚类算法调研.md) — V1 两级流水线：①段化（驻留段 + 时间间隙硬切分默认 ~8-10min + 相邻段应用重叠率软切分，<2-3s 瞬时切换并入邻段；文献共识纯超时不够）②增量簇归属（每任务加权质心摘要：应用计数向量 + 标题 token 频次，可选本地 embedding 通道；余弦/Jaccard 阈值判定并入 vs 新建；置信度 = best/margin 双判据三区制，低置信交用户裁决）；BIRCH/CluStream 只借 CF 摘要+吸收阈值+时间衰减三思想，HDBSCAN/UMAP 明确不用（批量/维度敏感/几十点无密度）；embedding 中文最轻 bge-small-zh-v1.5 26-48MB，缺失时纯 token 重叠降级；LLM 只做命名/解释/低置信说明（业界共识 after-stage 标签生成）；直接先例 Swish（~70% 任务准确率）与 CAiSE 2023（架构几乎一一对应）
- [任务与现有数据层挂接](issues/06-任务与现有数据层挂接.md) — 剪贴板自动归属 = **按复制来源进程**（用户转向：捕获瞬间前台进程匹配任务 AppRef → 链接；多任务共享应用时 lastActiveAt 最近者；规则非 AI、可解释、开关默认开；事件日志新增 clipboard 事件）；关联交互 = 面板内 HTML5 拖拽 + [＋添加内容] 按钮，反向 OLE 拖出复用 item:start-drag；快照 = 文本 preview 200 字符 / 图片 imageId+尺寸+bytes（trim 会删 PNG 文件，驱逐后占位）/ 文件 paths；alive 标记推送时查 ItemStore 计算；state:tasks 全量推送 + invoke 通道（task:load/create/update/delete/merge/link-item/unlink-item）；tasks.json 全新、items.json 不动、无迁移
- [长期记忆系统规格](issues/08-长期记忆系统规格.md) — 存储 = memories.json（同 tasks.json 模式）+ 可选本地 embedding 通道（复用 10 选型，缺失时文本/规则降级）；四类记忆（identity/tool/project/workflow）+ 反馈分流（任务确认/忽略自动沉淀为 suggested 候选，仍需用户确认）；写入确认 = 联动建议引擎提取候选 + 记忆面板 [保存]/[忽略]/[永久禁止]（banned 表关键词匹配）；强化 = conf = sat(hitCount) × exp(-λΔt)（λ 周级，与聚类衰减一致），超期未命中降权、低分进清理候选；使用 = context-prior 注入建议引擎（提升置信度、标题贴合用户术语）；阈值进设置
- [整合愿景规格文档](issues/09-整合愿景规格文档.md) — **地图完成**。交付 = `spec.md`（PRD + 技术方案：Problem/Solution/65 条用户故事/10 组实现决策/测试决策/Out of Scope/Further Notes），落点按 tracker 约定选 `.scratch/trace-vision/spec.md`；测试缝（用户确认）= 单一缝：main 纯逻辑模块 + vitest（geometry/imageProtocol/power 同款），IPC 靠 typecheck、UI 走 dev 手动验证；02/03/04/10 调研事实与 01/05/06/07/08 决议全部织入，类型形状（Task/事件/Memory）内联作精确契约；后续流程 = /to-tickets（拆 V1 实现票）→ /implement 逐张（tdd + code-review）

## Not yet specified

（已清空——全部条目已由各决议票或 spec.md 收口：记忆存储选型归 08；聚类相似度策略归 10；Screenpipe 时机后置归 05；L1 适配器清单与快速笔记层归 spec.md Out of Scope。）

## Out of scope

- 应用切换器的按任务组织窗口、窗口暂存——窗口级 Alt-Tab 替代（v1）已落地（2026-08-13，feature/tabtab）；这两项仍后置为独立努力
- 窗口级上下文恢复（窗口位置/状态还原）——依赖窗口管理，随之上置
- 圆球磁吸交互的 V1 实现——本图只产出 V2+ 规格
- macOS 版本——平台已定 Windows
- 快速笔记层——四层定稿不含（spec.md Out of Scope）
