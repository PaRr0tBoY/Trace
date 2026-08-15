# 41 — traceStore（AI 依据数据层）

**What to build:** AI 决策全程记录的数据层：trace 表为唯一事实源，记录观察到（活动摘要）、召回（工具/查询/条数/预览）、决策（理由全文 + 评级 + 置信度）、结果（采纳/忽略回填），外加版本信息（agentVersion / policyVersion / classifierVersion / promptVersion）与检索命中路径；保留规则 = 已采纳随任务活、未采纳随推荐历史 30 天清（清理接口预留联动）。JSONL 降级为 crash-safe append / 诊断 / 导出输入，不再与 DB 平级。

**Blocked by:** 33

**Status:** ready-for-agent

- [ ] trace 写入 API：观察到 / 召回 / 决策 / 结果 / 隐私拦截 / 版本信息全字段可写可查
- [ ] 保留规则实现（采纳随任务、未采纳 30 天可调），清理接口暴露给推荐历史联动
- [ ] ai-log.jsonl 降级为诊断 / 导出用途（不再作为查询事实源）
- [ ] vitest：写入 / 查询 / 保留边界（注入时钟）；typecheck + npm test 全绿

## 参考

spec 实现决策 8（trace canonical、版本信息、保留规则）；aiLog 现状（JSONL append）。
