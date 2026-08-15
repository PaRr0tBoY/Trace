# 52 — 删除 Ollama 全链路

**What to build:** 移除 Ollama 集成的一切痕迹：provider 探测 / 预填、`ai:detect-ollama` 通道、preload / bridge 方法、设置页检测按钮与"添加本地"按钮、30 语言 i18n 键（addLocal / detectOllama / detecting / detectNotFound / detectFound）、ProviderConfig.kind、启动预填、相关测试。

**Blocked by:** 无

**Status:** ready-for-agent

- [ ] grep 无 Ollama / ollama 残留（历史文档说明除外）
- [ ] 四文件契约同步清理（通道声明与 handler 一并移除，不留孤儿声明）
- [ ] i18n 30 语言键清理干净
- [ ] typecheck + npm test 全绿；dev 冒烟设置页正常

## 参考

spec 实现决策 11（删除清单）；handoff「本地模型」删除清单。
