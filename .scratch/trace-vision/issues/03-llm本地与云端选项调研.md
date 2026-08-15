# LLM 本地与云端选项调研

Type: research
Status: resolved

## Question

可配置 AI provider（本地 + 云端）的选项事实，供 07（建议引擎与 provider 抽象）使用：

- **本地推理**：Ollama、llama.cpp server、LM Studio 作为 provider 的成熟度；对"任务识别 / 上下文总结 / 聚类"这类任务的推荐模型（qwen 系 / llama 系 / gemma 系）与质量、显存/内存要求（用户机器规格未知，按主流 8-16GB 显存档位评估）。
- **云端 API**：OpenAI 兼容端点生态（OpenAI / DeepSeek / Anthropic / Gemini 等）对结构化输出（JSON）的支持、价格、**中国网络可达性**（用户在中国，DeepSeek 等国产端点的可用性优先）。
- **统一抽象最佳实践**：OpenAI 兼容协议（/v1/chat/completions）作为统一接口是否够用（Ollama 的 /v1 兼容性）？LiteLLM 这类网关是否有必要？结构化输出（JSON schema）在各端点的支持差异。
- **与 Screenpipe 的关系**：Screenpipe 自带 AI 管线（本地+云端可配置）——我们的 provider 抽象是复用 Screenpipe 的 AI 能力，还是独立调用 LLM？（给 07 提供事实，不做决定）

## Answer

- OpenAI 兼容 `/v1/chat/completions` 是所有目标端点（Ollama / llama.cpp / LM Studio / DeepSeek / 通义 / 智谱 / Kimi / OpenAI / Gemini-compat）的共同分母，一个 baseUrl+apiKey+model 三元组即可覆盖本地与云端；本地默认 Ollama（Qwen3-8B @8GB / Qwen3-14B @16GB 档，关 thinking），云端默认 DeepSeek（¥1-3/¥2-6 每百万 token，原生直连）。
- 结构化输出必须两层降级：schema 合约（OpenAI/Gemini/LM Studio/Ollama-v1 支持）→ json_object+prompt（DeepSeek/通义），客户端永远校验+重试；LiteLLM 网关对单应用桌面场景不必要（Python 依赖 + Postgres + 运维面）。
- 中国大陆可达性两极：OpenAI/Anthropic/Gemini 被墙且账号/ToS 受限（仅可选高级项），国产五家全部 OpenAI 兼容且人民币直连。
- Screenpipe 是上下文层不是推理引擎，不暴露 LLM 网关端点；建议 Trace 独立直连 LLM，只吸收其 provider 配置与隐私边界经验。
- 完整事实与来源见 [research/03-llm本地与云端选项调研.md](../research/03-llm本地与云端选项调研.md)
