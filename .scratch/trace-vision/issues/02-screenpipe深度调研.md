# Screenpipe 深度调研

Type: research
Status: resolved

## Question

Screenpipe（github.com/screenpipe/screenpipe，mediar-ai）作为 Trace 事件数据底层的能力与代价。用户已指定要把它融入产品，本 ticket 产出事实清单，供 05（事件采集架构决策）使用：

- **Windows 10/11 上实际捕获什么**：连续截图、OCR 文本、音频转录（本地 Whisper）、应用切换事件、点击/键盘事件、前台窗口与窗口标题——哪些是开箱即有，哪些是实验性/不可靠？
- **集成模式**：桌面 app / CLI / sidecar 子进程 + localhost:3030 REST API / MCP server；对 Electron 应用（Trace 主进程 spawn 子进程 + HTTP 调用）哪种可行？数据存哪（SQLite 位置、增长速率）？
- **API 表面与鉴权**：/search、/vision、/audio 等端点能力；本地鉴权方式。
- **AI 管线**：是否本地（Ollama）+ 云端（OpenAI 兼容）可配置？与我们的 provider 抽象是什么关系？
- **资源成本**：CPU/GPU 占用、磁盘增长、电池、后台常驻的稳定性。
- **许可**（关键决策点）：Screenpipe Commercial License——source-available、个人非商业免费、商业使用付费。Trace 是开源分发、用户可以自行集成 vs 官方发行版捆绑 screenpipe，许可如何界定？会不会导致 Trace 无法开源分发？
- **自建边界**：哪些能力白拿（OCR/截图/搜索/音频），哪些仍需自建（任务切换规则需要的事件流、前台窗口的实时性）？
- **已知限制与风险**：Windows 稳定性、安全软件误报、隐私（全量录屏）、多显示器。

## Answer

要点 gist：

- 能力：事件驱动截图（应用切换/点击/打字停顿/剪贴板/视觉变化）+ accessibility 文本优先、Windows 原生 OCR 兜底 + 本地 Whisper 转录 + FTS5/语义搜索，Windows 10/11 是一等公民，多显示器、`ui_events` 表、`/activity-summary` 全都有；CPU ~5-10%、RAM ~0.5-3GB、磁盘 ~5-10GB/月。
- 集成：BYO sidecar（用户自装官方 app 或 npx CLI）+ localhost:3030 REST（Bearer token 默认开启，`/health` 豁免；`/search`、`/raw_sql` 只读 SQL 是主路径）；实时 `app_switched` 事件只有 `@screenpipe/sdk` 嵌入层才有（Electron 需 sandbox:false）。
- 许可（关键）：已从 MIT 改为 Screenpipe Commercial License（source-available，2026 年 v2.19 起）。个人非商业免费；商业使用（业务环境/营收/营利实体）需付费；§5 禁止把 Licensed Work 嵌入/分发进产品；ToS §25 禁止再分发官方构建；SDK 嵌入明确是 enterprise 商业授权。**Trace 开源分发只能走 BYO API 集成，不能捆绑任何 screenpipe 二进制**；API-only 是否算"构建产品"未明确，需邮件 louis@screenpi.pe 书面确认。
- 风险：Windows 常驻偶发崩溃（边框闪烁/音频设备/tao panic 已修或修复中，静默崩溃仍有人报）需 Trace 侧守护；中文 OCR 依赖系统语言包、质量一般；全量录屏隐私需用户授权与 PII 默认脱敏。

调研全文：`.scratch/trace-vision/research/02-screenpipe深度调研.md`
