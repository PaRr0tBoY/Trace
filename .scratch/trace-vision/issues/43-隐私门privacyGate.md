# 43 — 隐私门 privacyGate

**What to build:** 隐私政策的纯逻辑模块：三个出口函数（captureAllowed / aiAllowed / memoryAllowed）+ 政策五维（AI 开关、拒绝应用清单、内容类型、时间范围、剪贴板访问、记忆访问）+ 记忆写入主开关；证据深度（L0–L4）与隐私敏感度两维正交。默认全开显式可见。

**Blocked by:** 无

**Status:** done（vitest 全绿；typecheck + npm test 由 coordinator 全量验证）

- [x] 三纯函数按政策各维判定，边界测试覆盖（清单命中 / 类型排除 / 时间窗外 / 开关关闭）
- [x] 深度 × 敏感度正交可表达（如"L3 深度但 denied"）
- [x] 拒绝输出含原因，供上层记录
- [x] 默认值全开；与现状唯一行为变化（剪贴板内容可出本机，仅预览、可关）语义明确
- [ ] vitest：政策纯函数全维；typecheck + npm test 全绿（vitest 已绿 30 条；全量 typecheck/test 待 coordinator）

## 参考

spec 实现决策 7（PrivacyPolicy 契约）；CONTEXT.md 证据分级词条（正交维度）。
