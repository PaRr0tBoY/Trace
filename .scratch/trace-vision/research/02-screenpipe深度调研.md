# Screenpipe 深度调研（Windows 10/11）

> 调研时间：2026-08（信息截至 v2.4.x，2026-03/04 的 issue 报道）。全部结论基于 web 检索到的官方文档、GitHub 源码/issue、官方博客与定价页。数据点均附来源 URL。
> 一句话结论：**能力上"事件数据底层"完全够用且 Windows 是一等公民；许可上"捆绑分发"此路不通，只能走 BYO sidecar（用户自装）或付费商业嵌入授权。**

---

## 0. 产品现状与时间线

- Screenpipe（Mediar, Inc.，旧名 mediar-ai，YC S26，GitHub 20K stars）：本地优先的"屏幕+音频记忆"层，Rust 核心 + Tauri 桌面 app，支持 macOS / Windows 10/11 / Linux。Windows 10/11 官方标注"✅ Full support"（.exe 安装包 + 企业 MSI 静默安装）。
  - https://github.com/screenpipe/screenpipe
- 当前 app 版本 v2.4.x（issue #3858 提到 v2.4.208，2026-03 前后）；README 明示 main 分支"moving fast and breaking things"，稳定版在付费 app 发行渠道。
- 架构分层：`screenpipe`（桌面 app/CLI + daemon）→ `screenpipe-core`（Rust 捕获引擎）→ `@screenpipe/sdk`（Node/Electron/Tauri/Swift 嵌入层）→ REST API localhost:3030 + MCP server。
- 2026 年（v2.19 前后）许可从 MIT 改为 **Screenpipe Commercial License**（source-available），同时终身买断退役、转为订阅制。历史 MIT 版本仍按 MIT 授权（仅旧版本）。

---

## 1. 实际捕获什么（Windows 10/11）

### 开箱即有（稳定、文档化）

| 能力 | 机制 | 来源 |
|---|---|---|
| 事件驱动截图 | 监听 OS 事件（应用切换 300ms debounce、窗口焦点变化、鼠标点击 200ms、打字停顿 500ms、滚动停止 400ms、剪贴板变化 200ms、视觉变化 3s 检查、空闲 5s 兜底），事件触发才截屏；DXGI/Windows Graphics Capture 捕获，多显示器全捕获 | https://screenpipe-screenpipe.mintlify.app/features/screen-capture |
| 文本提取 | accessibility 树优先（Windows UIA），OCR 兜底；Windows 用原生 Windows.Media.Ocr（非 Tesseract） | https://screenpipe-screenpipe.mintlify.app/features/screen-capture |
| 音频转录 | 系统音频（WASAPI loopback）+ 麦克风，本地 Whisper（Large-V3-Turbo）近实时转录，说话人识别/分离 | https://screenpipe.com/resources/use-cases/audio-capture-transcription |
| 元数据 | 每帧记录 app_name、window_name、browser_url、focused；`ui_events` 表记录 app_switch/click/scroll/key_press 等事件（含 Windows） | crates/screenpipe-core/assets/skills/screenpipe-api/SKILL.md；https://screenpipe.com/blog/screenpipe-v2-14-cli-search-power-tiers-onnx-redactor |
| 剪贴板 | 剪贴板变化触发捕获并写入 ui_events（`capture_on_clipboard` 控制） | crates/screenpipe-engine/src/event_driven_capture.rs |
| 检索 | SQLite FTS5 关键词全文 + 语义检索（embedding）；时间/应用/窗口/URL/说话人过滤 | https://screenpipe-screenpipe.mintlify.app/features/screen-capture |
| 活动统计 | `/activity-summary`：每应用/每窗口活跃分钟数（时间统计直接可用） | https://docs.screenpipe.com/api-recipes |

### 实验性/需显式开启

- **键盘事件（按键文本）**：`content_type=input` 覆盖 clicks/keystrokes/clipboard/app switches；但按键原始文本捕获默认**关闭**（CLI/设置里 `capture_on_keystroke` 默认 false，需显式开启 `--capture-on-keystroke`；v2.14 起 key press 事件在 Windows 上也与帧关联）。点击/滚动/应用切换事件默认开。
  - https://screenpipe.com/blog/screenpipe-v2-14-cli-search-power-tiers-onnx-redactor ；crates/screenpipe-engine/src/vision_manager/manager.rs
- **语义上下文（VLM 理解屏幕内容）**：`semantic_context_mode`（memory/computer-use）为较新实验能力。
  - crates/screenpipe-engine/src/vision_manager/manager.rs
- 原始视频/MP4 导出、云端转录、云端 AI、团队功能——付费层。

---

## 2. 集成模式与数据存储

### 集成模式（对 Electron 的可行性）

| 模式 | 说明 | 可行性 |
|---|---|---|
| 桌面 app | 官方安装包（.exe/.msi），订阅制 $25/mo 起 | 用户自行安装；Trace 只能当外部依赖 |
| CLI / daemon | `npx -y screenpipe@latest record` 或本地构建二进制，起 daemon 暴露 localhost:3030；`--port` 可改端口；可 headless 常驻 | **可行**（Trace 主进程 spawn + HTTP）|
| SDK 嵌入 | `@screenpipe/sdk`（Node/Electron/Tauri/Swift）：`@screenpipe/sdk/electron` 把原生捕获跑在主进程，preload 暴露 context-isolated API（permissions/start/stop/snapshot/status/reveal）；提供 `app_switched` 等实时事件流（0.4.x 稳定事件：start/stop、recording_started/stopped、paused/resumed、**app_switched**、frames_progress、permissions_changed、error）；Electron 需要 `sandbox: false` | 技术可行，但**商业授权门槛**（见 §6） |
| MCP server | `screenpipe-mcp` npm 包：stdio 全工具集（search/export-video/list-meetings/activity-summary/search-elements/frame-context）；HTTP 版 localhost:3031（Streamable HTTP，目前仅 search_content） | 旁路方案，Trace 不需要 MCP |
| REST API | localhost:3030，JSON | **主路径** |

- SDK 事件流（含 app_switched）是官方文档化的实时通道：https://screenpipe.com/sdk ；https://screenpipe.com/blog/screenpipe-v2-14-cli-search-power-tiers-onnx-redactor

### 数据存储

- `~/.screenpipe/db.sqlite`（元数据、accessibility 文本、OCR 文本、转录、说话人、标签、UI 元素）+ `~/.screenpipe/data/`（JPEG 截图、音频块）+ `~/.screenpipe/pipes/`；`SCREENPIPE_DATA_DIR` 环境变量可搬迁。FTS5 全文索引。
  - https://docs.screenpipe.com/architecture ；https://docs.screenpipe.com/privacy-data-flow
- 核心表：`frames`（app_name/window_name/browser_url/focused）、`ocr_text`、`elements`、`audio_transcriptions`、`audio_chunks`、`speakers`、`ui_events`（event_type/app_name/window_title/browser_url）、`accessibility`、`meetings`、`memories`。
  - crates/screenpipe-core/assets/skills/screenpipe-api/SKILL.md
- **磁盘增长**：事件驱动下 ~5–10 GB/月（官方多页一致口径）；截图 JPEG ~300 MB/8 小时（vs 连续录制 ~2 GB/8h）；FAQ 另提 1 FPS 连续 ~30 GB/月。retention 模式（media/lean/all）+ 自动清理 + `/data/compact` 回收。
  - https://github.com/screenpipe/screenpipe ；https://docs.screenpipe.com/faq

---

## 3. API 表面与鉴权

- 端点（OpenAPI 在 localhost:3030，tags 一览）：Search、Frames、Elements、Audio、Vision、Meetings、Speakers、Memories、Tags、Activity、Vault（静态加密）、Cloud Sync/Archive、Data Retention、Database、System、Experimental。
- 常用：
  - `GET /search`（q、content_type=ocr|audio|input|accessibility|all、app_name、window_name、browser_url、speaker_name、start/end_time、limit/offset、frame_id、tags、include_related）
  - `GET /search/keyword`（纯关键词）、`GET /activity-summary`
  - `POST /raw_sql`（**只读 SQL**，直接查上面所有表——对 Trace 的任务聚合查询很有用）
  - `GET /health`（管道状态：capture_fps、OCR 延迟、帧丢弃率、转录统计、tree walker 状态）
  - `GET/POST /frames/{id}/text|context|metadata`、`GET /elements`、`POST /add`
  - `/audio/list|start|stop`、`/vision/list`、`/speakers/update|merge`、`/meetings`、`/memories`、`/retention/configure`、`/data/delete-range`、`/data/compact`、`/archive/*`
- **鉴权（注意新旧文档冲突）**：最新 security 页——**所有 API 请求需 Bearer token**（首次启动自动生成，存 OS 钥匙串加密；无 localhost 豁免），豁免端点仅 `/health`、`/ws/health`、`/connections/oauth/callback`；token 用 `screenpipe auth token` 或 Settings → Privacy → API security 查看；支持 Bearer header / HttpOnly cookie / `?token=` 三种携带方式。老文档（mintlify）写"默认无鉴权"，可配 `--api-auth=false` 关闭（FAQ 口径：不带 flag 时默认开启）。**对 Trace：以最新 security 页为准，按"默认有 token"设计**。
  - https://screenpipe.com/security/architecture ；https://docs.screenpipe.com/getting-started ；https://docs.screenpipe.com/faq
- SDK：npm `@screenpipe/sdk`（v0.4.3，旧名 `@screenpipe/js`）；`pipe.queryScreenpipe({q, contentType, limit, startTime})` 风格；也支持纯 fetch 调 3030（无 SDK 依赖）。
  - https://www.jsdelivr.com/package/npm/@screenpipe/sdk ；https://screenpipe.com/resources/use-cases/screenpipe-for-developers

---

## 4. AI 管线

- **本地 + 云端双通道，配置化**：`aiProviderType` ∈ `native-ollama` / openai 等；`aiModel` + `openaiApiKey` 等从 settings 读取（`pipe.settings.getAll()`）；Ollama 走 `ollama-ai-provider`。官方 FAQ：AI provider 与 screenpipe 订阅解耦（自带 key 或本地 Ollama 即可，不必订阅）。
  - https://github.com/screenpipe/screenpipe/discussions/917 ；https://docs.screenpi.pe/faq
- Pipes（定时 AI agent）：`~/.screenpipe/pipes/{name}/pipe.md`（YAML front-matter 配 schedule/model/provider/preset），preset 引用 `~/.screenpipe/store.bin` 的 `settings.aiPresets`（可多 preset 回退）。这与 Trace 的 provider 抽象同构：**Trace 可以不管 screenpipe 的 AI 配置，只用它的采集与检索**。
  - crates/screenpipe-core/src/pipes/mod.rs
- 转录引擎：本地 Whisper Large-V3-Turbo（默认）或云端 Deepgram / screenpipe-cloud；VLM/语义分析可走本地或云端。
- 离线可用：采集、OCR、accessibility、本地转录、搜索、localhost API 全部不依赖网络；需联网的只有云转录/云 AI/云同步/登录鉴权。
  - https://docs.screenpi.pe/faq

---

## 5. 资源成本与 Windows 成熟度

- **CPU**：~5–10%（文档口径 5–15%），事件驱动比连续轮询省 3–5 倍。
- **RAM**：~600 MB 典型（官方多页口径 0.5–3 GB）。
- **磁盘**：~5–10 GB/月（见 §2）。
- **最低硬件**：双核 CPU + 2 GB RAM 可跑；官方推荐四核 + 4–8 GB RAM + SSD。
  - https://screenpipe.com/about ；https://docs.screenpipe.com/faq ；https://docs.screenpipe.com/architecture
- **Windows 成熟度**：一等公民（.exe/.msi、Intune/Jamf MDM、静默安装 + 预置配置、SAML SSO 企业计划）。DXGI/WGC 捕获 + UIA accessibility + Windows.Media.Ocr + WASAPI。
- **常驻稳定性已知问题**（2026-03/04 密集修复期）：
  - Windows Graphics Capture 黄色/橙色边框闪烁（IsBorderRequired）——用户投诉多（issue #2562），修复方案已进捕获库（xcap PR #265 best-effort）；Win11 24H2 企业版 + WDAC 环境曾整链崩掉
  - 非默认音频设备崩溃 + 句柄泄漏（#3858，已修 PR #4358，label high priority）
  - Tauri/tao 事件循环 panic（#2495，已修 PR #2535）
  - 静默崩溃仍有人报（#2729，v2.3.15，2026-04）
  - 结论：**功能面 Windows 成熟，但作为 7×24 常驻进程仍有偶发崩溃在修，Trace 侧必须做进程守护/自动重启与健康轮询**。

---

## 6. 许可（关键决策点）

### 精确条款（LICENSE.md 全文已核）

- 名称：**Screenpipe Commercial License**（source-available，非 OSI 开源）。
- "Licensed Work" = 源码 + 文档 + **任何由源码构建的二进制**（包括第三方构建）。
- "Commercial Use" = ①在业务或生产环境中使用；②产生营收或**支持营收活动**；③评估期后由/代表营利实体使用。
- 免费：个人非商业、非营利/教育/科研、任意规模 7 天评估。
- §3：**官方预构建二进制不受本许可管辖，受 ToS + 订阅约束**。
- §4：任何商业使用都要付费商业许可（无公司规模/人数/营收门槛）。
- §5 禁止（无商业许可时）：作为商业产品或服务的一部分**出售/再许可/分发**；向第三方提供托管/托管式服务；**嵌入或集成进"提供给客户的产品"**；构建竞品。
- §6：**Licensor 保留对 Licensed Work（包括你做的任何修改/补丁）的全部所有权**——fork 修改也不归你。
- 历史 MIT 版本仍 MIT（仅旧版本）。
  - https://github.com/screenpipe/screenpipe/blob/main/LICENSE.md

### 官方构建的 ToS 约束

- ToS §25：官方软件仅授予"个人或内部商业用途"的**有限、可撤销、不可再许可、不可转让**许可；**明确禁止再分发/转售/再许可**官方软件。
  - https://screenpi.pe/terms
- 定价：Standard $25/月（本地捕获+搜索+时间线）、Pro $50/席位/月、Enterprise $150/席位/月；终身买断已停售。
  - https://github.com/screenpipe/screenpipe

### 对 Trace（MIT 免费开源、捆绑分发 screenpipe 二进制）的界定

| 路径 | 许可判定 | 结论 |
|---|---|---|
| 捆绑**官方** screenpipe 二进制进 Trace 安装包 | ToS §25 禁止再分发官方软件 | ❌ 违规 |
| 捆绑**自建**（从源码/npm CLI 构建）screenpipe 二进制进 Trace | §5"作为产品的一部分分发/嵌入"；§6 修改归 Mediar；且 Trace 公开分发即落入"产品"语境 | ❌ 高风险（即使 Trace 免费，"商业产品或服务"的边界在文本上不清晰，需书面确认） |
| **BYO sidecar**：Trace 检测/引导用户自行安装 screenpipe（官方 app 或 npx CLI），Trace 只消费 localhost:3030 | Trace 不分发 Licensed Work；用户的使用受个人许可/订阅约束（用户自担）；Trace 免费开源分发不受影响 | ✅ 唯一能让 Trace 保持 MIT 开源分发的路径 |
| **@screenpipe/sdk 嵌入**（Electron 主进程原生捕获 + 实时 app_switched 事件） | SDK 明确是商业嵌入授权：screenpipe.com/sdk 标 "Commercial embedding license"，enterprise 级、private beta、按 OEM/白标商务谈判；npm 包 license = SEE LICENSE IN LICENSE.md（即本商业许可） | ⚠️ 需付费商业协议，个人项目阶段可申请评估，但**开源分发不可能免费** |
| 锁定旧 MIT 版本源码自建 | 旧版仍 MIT，可自由嵌入/分发 | ⚠️ 理论可行但不推荐：缺事件驱动捕获等新能力，且等于继承旧代码库 |

- 官方的态度（博客原文）："We build a product or service on screenpipe's source. That is commercial use of the source: you need a license."——任何"基于 screenpipe 做产品"的意图都要付费。API-only 集成是否算"构建产品"**许可文本未明确**，属于灰色地带。
  - https://screenpipe.com/blog/screenpipe-license-update
- **注意**：Acid 若以公司/营利实体身份开发 Trace（§1(c)），或 Trace 未来商业化（免费但支撑用户营收活动也算 §1(b)），都需要单独确认。**建议在开工 05（事件采集架构）前发邮件 louis@screenpi.pe 书面确认"MIT 免费开源应用 + BYO sidecar API 集成"的立场**，这是本调研最重要的待确认项。

---

## 7. 已知限制与风险

- **Windows 稳定性**：见 §5（边框闪烁、音频设备崩溃、tao panic、静默崩溃）。常驻需守护进程。
- **安全软件误报**：检索未发现 screenpipe 被 AV 拉黑的公开报道；但"录屏 + 按键钩子 + 常驻"软件天然是 AV/EDR 重点对象，且自建/未签名二进制风险更高（官方 app 有签名，建议用户走官方安装）。
- **隐私**：全量本地录屏是产品核心，用户必须知情授权（Trace 要在 UI 上明确）；默认 PII 脱敏开（`--use-pii-removal` 默认 true）、忽略窗口/应用/URL 过滤、DRM 内容自动暂停、静态加密（vault，AES-256-GCM）、retention 自动清理、telemetry 可关（PostHog 匿名，默认开）。剪贴板内容会被 screenpipe 记录（与 Trace 自身剪贴板存储叠加，需考虑重复与隐私设置）。
  - https://screenpipe.com/security/architecture ；https://docs.screenpipe.com/privacy-data-flow ；https://docs.screenpipe.com/faq
- **多显示器**：事件驱动多显示器配对捕获（各显示器独立触发、焦点感知：非焦点显示器降级为 Warm/Cold 视觉 diff）。✅
  - crates/screenpipe-engine/src/event_driven_capture.rs
- **中文 OCR**：Windows 用 Windows.Media.Ocr 原生引擎，**语言由系统语言包决定**（需在 Windows 设置装中文 OCR 语言包）；语言选择可配置（commit #3903 修复 honor Windows OCR language selection）；历史有中文 OCR 字符间空白 bug（#612，v2.2.0 修复关闭）。结论：中文 OCR **可用但依赖系统语言包、质量一般**，关键中文场景建议 Trace 侧保留自建 OCR 兜底或接受现状。Whisper 中文转录没问题。
  - https://github.com/screenpipe/screenpipe/commit/8ed2fcdb4abfd1302bf6caf210e06be593065f4d ；https://github.com/screenpipe/screenpipe/issues/612 ；https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.availablerecognizerlanguages
- **实时性**：事件入库有 debounce（app switch 300ms、点击 200ms、软 checkpoint 1.5s 合并），搜索/轮询路径是秒级；真正的近实时事件只有 SDK 事件流（商业授权）。任务切换规则若需即时响应，sidecar 模式不满足。

---

## 8. 白拿 vs 自建（结论清单）

### 白拿（BYO sidecar + localhost:3030 即得）

- ✅ 事件驱动截图 + accessibility 文本 + OCR 兜底（全显示器）
- ✅ 全文/语义搜索（FTS5 + embeddings），按应用/窗口/URL/时间/说话人过滤
- ✅ 本地 Whisper 音频转录 + 说话人识别（用户授权后）
- ✅ 应用/窗口/浏览器 URL 历史与 `ui_events` 事件表（app_switch 等，可 /raw_sql 查询）
- ✅ `/activity-summary` 每应用/窗口活跃分钟（任务时间统计直接复用）
- ✅ 剪贴板变化事件（可与 Trace 自带 watcher 互补，但注意双份记录）
- ✅ 隐私护栏全家桶（PII 脱敏、过滤、忽略窗口、retention、加密）
- ✅ MCP server（stdio 全工具）——Trace 不必用，但生态里 agent 可直接查
- ✅ AI 管线与 Trace 解耦：Trace 用自己的 provider 抽象，screenpipe 只当数据源

### 仍需自建 / 需要决策

- ⚠️ **任务切换规则的实时前台窗口事件**：sidecar HTTP 下只有秒级轮询（ui_events / raw_sql）；要近实时 app_switched 只能上商业 SDK 嵌入。**建议 V1 用 Trace 自建 koffi/Win32 前台窗口轮询（已有全屏检测经验）+ screenpipe 事后补上下文**，把"实时事件"留在自建侧。
- ⚠️ **许可架构**：开源分发只能 BYO；SDK 嵌入 = 商业谈判。需在 05 决策并书面确认。
- ⚠️ 键盘/剪贴板原始内容捕获默认关，且 Trace 自有剪贴板管线（OLE 原生格式）更精确——不依赖 screenpipe 的 input 捕获。
- ⚠️ 中文 OCR 依赖系统语言包，质量一般；关键中文文本建议 Trace 侧评估兜底方案。
- ⚠️ 常驻守护：screenpipe 进程崩溃自愈、磁盘配额监控、/health 轮询，需 Trace 主进程实现。

---

## 9. 关键来源汇总

- 仓库/README/定价：https://github.com/screenpipe/screenpipe
- LICENSE.md 全文：https://github.com/screenpipe/screenpipe/blob/main/LICENSE.md
- 许可变更声明：https://screenpipe.com/blog/screenpipe-license-update
- ToS：https://screenpi.pe/terms
- SDK 页（嵌入授权）：https://screenpipe.com/sdk
- 架构/存储：https://docs.screenpipe.com/architecture
- API 食谱（端点/鉴权用法）：https://docs.screenpipe.com/api-recipes
- API 参考：https://docs.screenpipe.com/cli-reference ；https://screenpipe-screenpipe.mintlify.app/developers/api-overview
- 安全架构：https://screenpipe.com/security/architecture
- 事件驱动捕获源码：https://github.com/screenpipe/screenpipe/blob/main/crates/screenpipe-engine/src/event_driven_capture.rs
- SDK 事件流/变更日志：https://screenpipe.com/blog/screenpipe-v2-14-cli-search-power-tiers-onnx-redactor
- 中文 OCR issue：https://github.com/screenpipe/screenpipe/issues/612 ；OCR 语言选择修复：https://github.com/screenpipe/screenpipe/commit/8ed2fcdb4abfd1302bf6caf210e06be593065f4d
- Windows 稳定性 issue：#2562（边框闪烁）、#3858（音频设备崩溃）、#2495（tao panic）、#2729（静默崩溃）
