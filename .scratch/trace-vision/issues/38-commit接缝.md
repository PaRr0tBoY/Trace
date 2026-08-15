# 38 — TaskStore.commit 接缝

**What to build:** 提案采纳的提交动作收进单一入口：`commit(proposal)` 只处理 new / update / merge（封装现有"新建 / 并入已有任务 / 更新"三连跳），不负责"何时切换"——切换时机由状态控制器决定。决策层调用它完成采纳，与"何时切换"解耦。

**Blocked by:** 35, 36

**Status:** ready-for-agent

- [ ] commit 三态（new / update / merge）各自行为正确
- [ ] merge 类型安全（图片并图片、文件并文件）
- [ ] 采纳命中已有任务 → 并入；否则新建；更新字段生效
- [ ] 采纳路径不再直接散落创建/合并逻辑（旧调用点全部收口到 commit）
- [ ] vitest：commit 三态 + 类型安全 + 既有采纳测试保持绿；typecheck + npm test 全绿

## 参考

spec 实现决策 4（commit 只处理 new/update/merge，不负责何时切换）；既有任务域核心实现。
