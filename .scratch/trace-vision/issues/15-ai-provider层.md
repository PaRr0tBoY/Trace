# 15 — AI Provider 层

**What to build:** 设置页可配置 provider 链（本地 Ollama + 云端 OpenAI 兼容端点），主备自动降级，测试连接显示状态；结构化输出两层降级 + 客户端校验重试；onboarding 时检测本机 Ollama 并预填本地 provider。

**Blocked by:** None — can start immediately

**Status:** resolved

- [ ] Provider 配置模型 `{id, baseUrl, apiKey?, model, kind:'local'|'cloud', supportsSchemaOutput?}`；线协议 OpenAI 兼容 `/v1/chat/completions`；openai npm SDK（自定义 base_url）或 ~100 行 fetch 层，无 LiteLLM
- [ ] 主备链：按用户配置顺序为优先级，失败自动切备（仅限已配置链内）；全链失败返回明确失败结果，由调用方决定降级
- [ ] 结构化输出两层降级：① response_format json_schema+strict → ② json_object + prompt 内嵌 schema；客户端永远做 JSON 校验 + 有限重试（含 max_tokens 截断等畸形响应）；schema 单源定义同时用于请求与校验
- [ ] 设置 UI：provider 列表 + 优先级排序 + 测试连接 + 状态显示（含全链失败）；新文案走 i18n（zh 必填）
- [ ] onboarding 检测：探测本地 Ollama `/v1/models`，在跑则预填本地 provider（默认模型 Qwen3-8B/14B，关 thinking）
- [ ] vitest（fake fetch，无网络）：两层降级、校验失败重试、主备切换、全链失败、畸形响应；typecheck + npm test 全绿

## 参考

规格《实现决策 6》AI Provider 抽象、《实现决策 10》设置登记。

## Resolution

Implemented 5bc26a4 (15 = 15-ai-provider层); wave-verified by coordinator (typecheck + vitest green). t12 additionally got a koffi OpenProcess fix (a5fe873, runtime smoke-test catch). t20 split across t20a (MemoryStore, c307870) + t20b (integration, 7510a92). Final regression: 308 tests pass, build ok, startup smoke clean.
