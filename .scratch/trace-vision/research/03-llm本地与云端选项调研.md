# LLM 本地与云端选项调研

Type: research
Status: resolved
日期：2026-08（调研时点）
供：issue 07（AI 建议引擎与 provider 抽象规格）

## 1. 本地推理选项成熟度

### 1.1 三个 provider 的现状对比

| | Ollama | llama.cpp server | LM Studio |
|---|---|---|---|
| 形态 | CLI + 常驻服务（localhost:11434） | 裸推理引擎 + HTTP server（默认 8080） | 图形化桌面应用 + 本地 server（1234） |
| OpenAI 兼容端点 | `/v1/chat/completions`（`/v1` 内置） | `/v1/chat/completions` + Anthropic Messages API 兼容 | `/v1/chat/completions` + `/v1/responses`（Codex 可直连） |
| 结构化输出 | 原生 `/api/chat` 的 `format` 字段传完整 JSON schema；`/v1` 支持 `response_format` | `json_schema` 字段 / `response_format`，grammar 约束生成 | `response_format.json_schema`（OpenAI 同款格式） |
| 模型管理 | `ollama pull` 自动量化 | 手动下载 GGUF、手动选量化 | GUI 搜索下载、多模型并行服务、可开"Serve on Network" |
| 工具调用 | 支持 | 支持（"~any model"） | 支持 |
| 适合谁 | 默认首选：零配置、最主流 | 需要细粒度控制（量化、KV cache、层 offload） | 非技术用户 / 想要 GUI 和模型管理 |

事实来源：
- Ollama 结构化输出与 `/v1` 兼容性：https://docs.ollama.com/capabilities/structured-outputs 、https://ollama.com/blog/structured-outputs
- Ollama `/v1` 的已知兼容性问题（见 3.2）：https://github.com/ollama/ollama/issues/10937 、https://github.com/ollama/ollama/issues/10001 、https://github.com/ollama/ollama/issues/7978
- llama.cpp server 能力清单（OpenAI/Anthropic 双兼容、schema 约束、function calling）：https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- LM Studio OpenAI 兼容与结构化输出：https://lmstudio.ai/docs/developer/openai-compat/structured-output 、https://lmstudio.ai/docs/developer/openai-compat ；`/v1/responses` 支持：https://lmstudio.ai/docs/developer/openai-compat
- LM Studio "低于 7B 的模型不一定支持结构化输出"：https://lmstudio.ai/docs/developer/openai-compat/structured-output

**结论：三者都可用，Ollama 是集成成本最低的默认选择；LM Studio 对用户更友好（GUI + 模型管理）；llama.cpp 只建议需要深度定制时自建。** 三个都暴露 OpenAI 兼容端点，provider 抽象可以统一走 `/v1/chat/completions`（见第 3 节）。

### 1.2 推荐模型与显存档位（8–16GB 主流显存）

对本项目任务（任务识别 / 上下文总结 / 结构化 JSON 输出）的关键质量指标：**指令遵循能力**（决定 JSON 格式服从度）与**长上下文**（事件批总结）。多来源共识：qwen 系指令遵循最强、是 8–16GB 档位的最优解；llama 系事实准确但格式服从较弱；gemma 3 为多模态折中。

#### 显存需求表（Q4_K_M 量化、短上下文，含 KV cache 与开销）

| 模型 | Q4 总显存 | Q8 总显存 | 128K 上下文注意 | 档位结论 |
|---|---|---|---|---|
| Qwen3-4B | ~3 GB | ~5 GB | — | 8GB 卡起步 |
| Qwen3-8B | ~5–6.5 GB | ~10–11 GB | KV cache 随上下文线性涨 | 8GB 卡 Q4 可跑；12GB 卡可上 Q8 |
| Llama 3.1 8B | ~6.4 GB | ~10–10.7 GB | 128K 全长需 ~25 GB（KV cache 主导），KV cache 量化可减半 | 8GB 卡 Q4 可跑 |
| Gemma 3 12B | ~9–14 GB（权重 7.3GB + 开销） | ~14.8 GB | — | 12GB 卡 Q4 紧；16GB 卡舒服 |
| Qwen3-14B | ~10.7 GB | ~17.4 GB | 32K 上下文约 17 GB | 12GB 卡 Q4 紧；16GB 卡舒服 |
| Qwen3-32B | ~22 GB | ~37 GB | — | 需要 24GB 卡（紧） |
| Gemma 3 27B | ~14 GB（Q4） | — | — | 24GB 卡 |
| Llama 3.3 70B | ~43 GB | — | — | 双卡 24GB，8–16GB 档位不可行 |

事实来源：
- Qwen3 全家谱 VRAM 表（Q4/Q8、最小 GPU、thinking 模式开销）：https://llmhardware.io/guides/qwen3-hardware-requirements
- Qwen3-8B：~6.5GB（Q4, 4k ctx）、32K 上下文 ~11.2GB：https://localmodel.run/model/qwen3-8b ；Q4 5.03GB 权重 + KV cache 结构：https://localmodel.run/model/qwen3-8b
- Qwen3-14B：~10.7GB（Q4, 4k ctx）、Q8 17.4GB：https://localmodel.run/model/qwen3-14b
- Qwen3-32B：~22GB（Q4）：https://localmodel.run/model/qwen3-32b
- Llama 3.1 8B：~6.4GB（Q4）、128K 全长 ~25.2GB（KV cache 19.2GB）：https://specpicks.com/reviews/best-gpu-for-llama-3-1-8b ；https://localmodel.run/model/llama-3.1-8b
- Gemma 3 12B：Q4_K_M 权重 7.3GB、运行时 12–14GB：https://willitrunai.com/models/gemma-3-12b 、https://localvram.com/en/models/gemma3-12b-q4/ ；8K ctx 下 Q4 总 ~8.9GB：https://canitrun.dev/models/gemma-3-12b/
- Gemma 3 27B Q4 ~14GB（24GB 卡）：https://insiderllm.com/guides/best-local-llms-summarization/

#### 质量对比（任务识别/总结场景）

- **qwen 系（首选）**：Qwen 2.5/3 是开源模型里指令遵循最强的（"summarize in 3 bullet points should produce exactly 3 bullet points"），Qwen2.5-14B 是 16GB 档总结甜点；Qwen3-8B 质量接近 Qwen2.5-14B。Qwen3 自带 thinking 模式，但**响应 token 量 2–3 倍**（KV cache 与延迟成本，任务识别这类低延迟场景建议关 thinking 或限制 context）。中文多语言支持好（Trace 用户中文场景）。
- **llama 系**：事实准确、幻觉率低（Llama 3.3 70B 在 Vectara 总结幻觉榜 4.1%，低于 GPT-4o 的 9.6%），但 8B 档长度/格式服从较弱（"Llama 3.1 8B gives you 5 bullet points of varying length"）；70B 质量最好但 8–16GB 档位跑不动。
- **gemma 系**：Gemma 3 12B/27B 指令遵循好，多模态；27B 需 24GB 卡，12B 在 12–16GB 档位可用。

事实来源：
- Qwen 最强指令遵循 + 分档总结选型表（8GB→Qwen2.5-7B/Qwen3-8B，12GB→Qwen3-8B，16GB→Qwen2.5-14B，24GB→Gemma 3 27B / Qwen2.5-32B，双卡→Llama 3.3 70B）：https://insiderllm.com/guides/best-local-llms-summarization/
- Qwen3 thinking 模式 2–3 倍 token：https://llmhardware.io/guides/qwen3-hardware-requirements
- Llama 3.3 70B 幻觉率 4.1%（Vectara HHEM）：https://awesomeagents.ai/models/llama-3-3-70b/
- 总结场景 8B/14B 推荐（Llama 3.3 8B / Qwen3 14B，128K 上下文单遍总结）：https://www.promptquorum.com/prompt-bites/best-local-llm-document-summarization

**8–16GB 档位推荐结论**：
- 8GB：Qwen3-8B（Q4）—— 唯一兼顾质量与 JSON 服从的档位；Qwen3-4B 兜底。
- 12GB：Qwen3-8B（Q8）或 Qwen3-14B（Q4 紧）。
- 16GB：Qwen3-14B（Q4，留足 KV cache 余量）—— 甜点档。

## 2. 云端 API 选项

### 2.1 OpenAI 兼容性与结构化输出支持矩阵

| 端点 | base_url（OpenAI 格式） | 结构化输出 | 价格档位（每百万 token，输入/输出） | 中国大陆可达性 |
|---|---|---|---|---|
| OpenAI | api.openai.com | 原生 schema 合约（`json_schema` + strict） | gpt-5.6-luna $0.20/$1.20；gpt-5.6-terra $2/$12；gpt-5.6-sol $5/$30；gpt-5.4-mini $0.75/$4.50 | 被墙（100% 屏蔽），需 VPN + 非 +86 账号，直连违反 ToS 有封号风险；唯一合规路径是 Azure OpenAI |
| Anthropic | api.anthropic.com（Messages API） | 原生 schema（`output_config.format`，2026-02 GA）+ strict tool use | Claude Sonnet 5 $2/$10（8/31 前）→$3/$15；Haiku 4.5 $1/$5；Opus 5 $5/$25 | 不支持中国大陆/香港（官方 supported-regions 无 China），GFW 屏蔽，需海外账号+节点 |
| Google Gemini | generativelanguage.googleapis.com（另有 OpenAI 兼容端点） | `responseJsonSchema`（JSON Schema 子集）+ 隐式属性顺序 | Gemini 3.6 Flash $1.50/$7.50；3.6 Flash-Lite $0.30/$2.50（另有免费层） | 整个 Google 生态被墙，需 VPN |
| DeepSeek | api.deepseek.com | 仅 `json_object` 模式（无 schema 合约）；strict function calling 走 `/beta` | deepseek-v4-flash ¥1/¥2（≈$0.14/$0.28）；v4-pro ¥3/¥6（≈$0.435/$0.87）；缓存命中输入 ¥0.02–0.025 | **原生直连**，人民币结算 |
| 阿里云百炼（通义） | `{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | tools function calling 全支持；结构化输出为 json_object 类 | qwen-plus ¥0.8/¥2（≤128K）；qwen3.5-plus ¥0.8/¥4.8；qwen3.7-plus ¥2/¥8（限时 8 折） | **原生直连** |
| 智谱 GLM | open.bigmodel.cn/api/paas/v4（另提供 Anthropic 兼容与 GLM 原生） | function calling 支持，但协议与 OpenAI 有差异（官方 SDK 更稳）；GLM 原生协议暴露结构化输出 | GLM-4.7 ¥0.96/¥3.48；GLM-5 ¥4–6/¥18–22；GLM-4.7-Flash 免费；GLM-4.5-Air ¥0.18/¥1.44 | **原生直连** |
| Kimi（月之暗面） | api.moonshot.cn/v1 | 完全 OpenAI 兼容 | kimi-k2.6 系列；送 ¥15 免费额度；256K 长文本主场 | **原生直连** |
| 豆包（火山方舟） | ark.cn-beijing.volces.com/api/v3 | OpenAI 兼容，但 model 字段填 endpoint id（ep-xxx）而非模型名 | 豆包系列，免费额度较多 | **原生直连** |

事实来源：
- OpenAI 价格：https://developers.openai.com/api/docs/pricing 、https://developers.openai.com/api/docs/models/compare
- Anthropic 结构化输出（output_config.format、GA 时间线）：https://platform.claude.com/docs/en/build-with-claude/structured-outputs 、https://claude.com/blog/structured-outputs-on-the-claude-developer-platform ；价格：https://platform.claude.com/docs/en/about/claude-pricing
- Gemini 结构化输出（responseSchema / responseJsonSchema、属性顺序）：https://ai.google.dev/gemini-api/docs/generate-content/structured-output 、https://blog.google/innovation-and-ai/technology/developers-tools/gemini-api-structured-outputs/ ；价格：https://ai.google.dev/gemini-api/docs/pricing
- DeepSeek 兼容性/价格/JSON 输出/工具调用：https://api-docs.deepseek.com/quick_start/pricing 、https://api-docs.deepseek.com/guides/json_mode/ 、https://api-docs.deepseek.com/guides/tool_calls 、https://api-docs.deepseek.com/api/create-chat-completion ；V4 模型与旧别名退役（2026-07-24）：https://benchlm.ai/blog/posts/deepseek-api-pricing 、https://devtk.ai/zh/blog/deepseek-api-pricing-guide-2026/
- 通义价格与 OpenAI 兼容模式：https://help.aliyun.com/zh/model-studio/model-pricing 、https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope ；百炼也托管 DeepSeek/Kimi/GLM/MiniMax：https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses
- 智谱价格：https://open.bigmodel.cn/pricing ；三协议兼容与 GLM function calling 差异：https://therouter.ai/zh/blog/zhipu-glm-api-complete-guide/ 、https://llmrank.top/guides/cn-api-onboarding/
- Kimi/豆包/各厂商对照：https://llmrank.top/guides/cn-api-onboarding/ 、https://aether.aiphys.cn/docs/domestic-model-api

### 2.2 中国网络可达性（权重最高）

- **被墙（需 VPN + 海外账号，且有合规风险）**：OpenAI（GreatFire 实测 api.openai.com 屏蔽率 100%，OpenAI 官方也封堵不支持国家/地区的 API 流量，用代理直连有封号风险）；Anthropic（官方 supported-regions 名单无中国大陆与香港，直连 403/超时）；Google Gemini（整个生态被墙）。
- **原生直连（人民币结算、无 VPN）**：DeepSeek、通义（百炼）、智谱 GLM、Kimi、豆包、MiniMax、小米 MiMo。**全部提供 OpenAI 兼容端点**（豆包为 endpoint-id 模式、GLM 的 function calling 有差异）。
- 用户在中国大陆：**云端首选 = DeepSeek（最便宜）或通义/智谱（质量/生态）**；OpenAI/Anthropic/Gemini 只能作为"用户自备翻墙+海外账号"的可选高级项，不应作为默认路径。

事实来源：
- api.openai.com 被屏蔽（GreatFire 实测）：https://zh.greatfire.org/https/api.openai.com
- OpenAI 封堵不支持国家流量、Azure 是唯一合规路径：https://mindwiredai.com/2026/06/20/how-to-use-openai-api-in-china/
- Anthropic 不支持中国/香港 + 国内网关方案：https://segmentfault.com/a/1190000047762545
- 2026 年中中国大陆可用性总表（国产直连 / GPT·Claude·Gemini 需 VPN）：https://sunsetbrowser.app/blog/china-ai-access-mid-2026-update-en

## 3. 统一抽象最佳实践

### 3.1 OpenAI 兼容协议是否够用

**够用，且是事实上的共同分母**：Ollama（`/v1`）、llama.cpp（`/v1`）、LM Studio（`:1234/v1`）、DeepSeek、通义、智谱、Kimi、豆包、MiniMax、小米 MiMo 全部暴露 `/v1/chat/completions`。只有 Anthropic 原生 API 是另一套（Messages API），但国产端点普遍提供 Anthropic 兼容面（DeepSeek `/anthropic`、智谱、MiniMax），且本项目用 OpenAI 兼容面即可覆盖所有目标 provider。

注意："OpenAI 兼容是营销声明，不是契约"——各家对 tool use、缓存、结构化输出的保真度不同，长尾特性会泄漏（见 3.2）。**provider 抽象应只承诺 chat completions + 结构化输出的最小面，并逐 provider 做 canary 验证。**

事实来源：
- "OpenAI-compatible is a marketing claim, not a contract"（生产级保真度维度分析）：https://mpiv.ai/blog/litellm-in-production-architecture-tradeoffs-and-operational-reality-2026
- DeepSeek 双格式（OpenAI/Anthropic）：https://api-docs.deepseek.com/quick_start/pricing/ ；智谱三协议：https://therouter.ai/zh/blog/zhipu-glm-api-complete-guide/ ；国产厂商 OpenAI/Anthropic 双兼容速览：https://aether.aiphys.cn/docs/domestic-model-api

### 3.2 Ollama `/v1` 兼容性现状

可用，但有几个已知边角：
- `response_format` 的 `json_schema` 变体部分场景被忽略（issue #10937，`json_schema` 传 `format: date-time` 等时），原生 `/api/chat` 的 `format` 字段才是完全版。
- 属性顺序不保序（issue #7978，违反 OpenAI 结构化输出关键顺序保证）——已在 main 分支修复。
- 与 OpenAI `beta.chat.completions.parse` 的兼容性测试通过（issue #10001 实测两者都返回正确 JSON）。
- Ollama Cloud 不支持结构化输出（本项目只用本地，不影响）。

结论：**本地 provider 用 Ollama 时，结构化输出走 `/v1` 的 `response_format`（json_object+schema 或 json_schema）基本可用，但对格式保证要求高时需客户端校验兜底；或让本地模式直接走 Ollama 原生 `format` 字段（在 provider 内部分支，不暴露给上层）。**

事实来源：https://github.com/ollama/ollama/issues/10937 、https://github.com/ollama/ollama/issues/7978 、https://github.com/ollama/ollama/issues/10001

### 3.3 各端点结构化输出差异（JSON schema 支持）

| 保证级别 | 端点 | 形态 |
|---|---|---|
| schema 合约（解码期强制） | OpenAI（strict）、Anthropic（output_config）、Gemini（responseJsonSchema）、LM Studio、Ollama `/v1`（部分）、llama.cpp | `response_format` / `output_config.format` |
| 仅合法 JSON（字段由模型自定） | DeepSeek（json_object）、通义 | `response_format {type: json_object}` + prompt 内嵌 schema 示例 |
| 无显式模式 | 部分国产端点 | 靠 prompt 约束 + 客户端校验 |

要点：
- **DeepSeek 没有 OpenAI 式的 json_schema 合约**，只有 json_object（且要求 prompt 里带 "json" 字样，偶发空内容返回）；schema 级保证要走 strict function calling（`/beta`）。这决定了抽象不能假设所有云端端点都有 schema 模式。
- Anthropic 的 schema 合约是 2026-02 才 GA（此前是 beta），且走 Messages API 而非 chat completions。
- 统一策略：**两层降级**——优先发 `response_format: {type:"json_schema", json_schema:{schema, strict:true}}`（OpenAI/Gemini-compat/LM Studio/Ollama-v1 支持）；端点不支持时降级 `json_object` + prompt 内嵌 schema；**任何情况客户端都校验 JSON 并重试**（strict 也会因 max_tokens 截断而失败，墨菲定律）。

事实来源：
- JSON Mode vs Schema Mode 保证差异总述（各端点对照）：https://thepromptbench.com/structured-outputs/json-mode-vs-schema-mode/
- DeepSeek json_object 限制（prompt 要求、空内容）：https://api-docs.deepseek.com/guides/json_mode/ ；strict function calling beta：https://api-docs.deepseek.com/guides/tool_calls
- Anthropic 结构化输出 GA：https://claude.com/blog/structured-outputs-on-the-claude-developer-platform
- OpenAI strict 模式：https://platform.openai.com/docs/guides/structured-outputs

### 3.4 LiteLLM 是否有必要

**对 Trace 这类单应用桌面场景：不必要。** 事实依据：
- LiteLLM Proxy 的价值集中在多服务/多团队场景：虚拟 key、团队预算、VPC 内网网关；代价是 Postgres 依赖、频繁发版（每次升级要读 changelog）、运维面（"Skip LiteLLM when one service owns all the calls"——单一服务持有全部调用时用 SDK/直连即可）。
- LiteLLM 是 Python 生态；Trace 是 Electron/TypeScript 单进程应用，引入一个常驻 Python 网关进程对单个桌面应用是纯负担。
- 托管网关（OpenRouter 5.5% 平台费）对国内用户也无优势（数据出境 + 人民币结算问题）。
- 替代方案：直接实现 ~100 行的 provider 层（base_url + api_key + model + response_format 协商），或使用 `openai` npm SDK（支持自定义 base_url，官方维护、TypeScript 类型齐全）。OpenAI npm SDK 同时兼容 Ollama/LM Studio/DeepSeek/通义等全部 OpenAI 兼容端点（DeepSeek 官方文档即推荐用它）。

事实来源：
- LiteLLM 何时该用/不该用（Proxy vs SDK 决策表）：https://mpiv.ai/blog/litellm-in-production-architecture-tradeoffs-and-operational-reality-2026 、https://docs.litellm.ai/docs/learn/gateway_quickstart
- LiteLLM 定位（统一接口、虚拟 key、140+ provider）：https://www.litellm.ai/ 、https://docs.litellm.ai/docs/
- DeepSeek 官方用 OpenAI SDK 示例：https://api-docs.deepseek.com/quick_start/pricing/ ；通义 OpenAI 兼容用 OpenAI SDK：https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope

## 4. 与 Screenpipe 的关系（事实，不做决定）

- **Screenpipe 不是推理引擎，是上下文层**：它自己不做 LLM 推理（"does not run AI models"），职责是采集（屏幕 OCR/音频转录/窗口事件）+ SQLite 存储 + localhost:3030 REST + MCP server。它消费 LLM，而不是提供 LLM。
- **它的 AI 管线是"AI preset"模型**：桌面 app 的 preset 选择器支持 provider 类型 `screenpipe-cloud`（默认，经其云代理）、`openai`、`openai-chatgpt`、`anthropic`、`native-ollama`、`custom`；pipes（定时 AI 任务）的 frontmatter 里有 `provider` 字段，CLI 通过 `~/.screenpipe/.env` 配 `SCREENPIPE_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。**这与我们的"可配置 provider"是同一个问题的两种实现**。
- **Ollama 集成**：自动连 `localhost:11434`，自动检测已拉取模型；自定义端点自动探测 `/v1/models`（OpenAI 格式），回退 `/api/tags`（Ollama 格式）——即 Screenpipe 自身也是"OpenAI 兼容 + Ollama 兼容"双格式探测。
- **它不暴露"给自己的 LLM 端点"**：它的 REST API（/search 等）是数据查询面，不是 LLM 代理面。第三方应用不能拿 Screenpipe 当 LLM 网关用。
- **对 Trace 的含义（供 07 权衡）**：若 Trace 只用 Screenpipe 当事件数据底层，则 provider 抽象应**独立直连 LLM**（自己的 base_url/api_key/model 配置），不复用 Screenpipe 的 AI 管线——复用意味着把建议引擎的 prompt/JSON 合约耦合进 Screenpipe 的 chat/pipe 系统，失去可控性，也与"AI 无决定权、推断可解释"的铁律冲突（Trace 需要拿到完整请求/响应做记录与解释）。Screenpipe 的 pipe 系统可作对照参考（它的 provider 配置模型证明了"本地+云端可配置"的通用做法），但不必复用代码。
- 附带事实：Screenpipe 的 web search 工具只对 `screenpipe-cloud` preset 开放（隐私闸门，代码注释明说"避免在用户选择本地 provider 时把数据发到自家后端"）——佐证它把 LLM 配置视为用户隐私边界的一部分。

事实来源：
- Screenpipe + Ollama 集成与自定义端点探测：https://docs.screenpipe.com/ollama
- Screenpipe 定位（不是推理引擎、是 context layer）：https://screenpipe.com/blog/local-ai-assistant-private-2026 、https://screenpipe.com/blog/private-ai-assistant-no-cloud
- pipes provider 配置方案（CLI env + frontmatter）：https://github.com/screenpipe/screenpipe/issues/2224
- web search 仅 screenpipe-cloud（隐私闸门）：https://github.com/screenpipe/screenpipe/issues/4177

## 5. 推荐的最小 provider 抽象形态（给 07 的输入）

1. **线协议：OpenAI 兼容 `/v1/chat/completions`**。一个 `baseUrl + apiKey + model` 三元组即覆盖全部目标 provider：本地（`http://localhost:11434/v1` 等）与云端（DeepSeek/通义/智谱/Kimi/OpenAI/Gemini-compat）共用同一套请求构造与响应解析代码。这是所有候选端点（除 Anthropic 原生外）的共同分母，也是事实上的业界标准。
2. **结构化输出两层降级**：① 优先 `response_format: {type:"json_schema", json_schema:{schema, strict:true}}`；② 不支持则 `json_object`（DeepSeek/通义类）+ prompt 内嵌 schema 示例；③ 客户端永远做 JSON 解析校验 + 有限重试（strict 也会因 max_tokens 截断失败）。schema 由共享 Zod（或等价的 JSON Schema 定义）单源生成，同时用于请求与校验。
3. **不做 LiteLLM 网关、不引 Python 依赖**；用 `openai` npm SDK（支持自定义 base_url）或 ~100 行手写 fetch 层即可。provider 配置 = `{ id, baseUrl, apiKey?, model, kind: 'local'|'cloud' }`，加一个能力位 `supportsSchemaOutput`（默认 true，DeepSeek 类置 false）。
4. **本地默认模型：Qwen3-8B（8GB 档）/ Qwen3-14B（16GB 档）**，Q4_K_M，关 thinking 模式（任务识别重延迟）；云端默认 DeepSeek（最便宜、直连），质量敏感可上通义 qwen3.7-plus 或智谱 GLM-4.7（免费层 GLM-4.7-Flash 可做开发期零成本）。
5. **与 Screenpipe 独立**：Trace 直连 LLM，Screenpipe 只做数据源；但吸收它的配置模型经验（预设 provider 列表、密钥持久化、隐私边界），可把"检测本地 Ollama 是否在跑（探测 `/v1/models`）"作为 onboarding 体验（Screenpipe 同款做法）。
