# 40 — 聚类迁入 ActivityLedger

**What to build:** 聚类逻辑（触发游标、分段参数、归属、签名、忽略表）从建议引擎整体迁出为独立模块，产出活动（Activity）：应用集、窗口标题、活跃时长、剪贴板材料与归属目标，带签名与版本信息。活动是观察对象，不持久化；任何活动可回溯到构成它的事件。对算法路径行为零变化。

**Blocked by:** 39

**Status:** ready-for-agent

- [ ] Activity 形状符合契约（id / startAt / endAt / apps / clipboardRefs / attribution? / signature / classifierVersion / promptVersion? / sessionId?）
- [ ] 聚类输入来自证据时间线，输出活动可回溯（每个活动能查到构成它的事件）
- [ ] 分段参数（硬切分 / 瞬时并入 / 重叠率软切分）与现有行为一致（既有聚类测试迁移后全绿）
- [ ] classifierVersion 随活动记录；签名生成与忽略表逻辑原样迁移
- [ ] 建议引擎不再持有聚类实现（仅调用）
- [ ] vitest：既有聚类测试全绿 + 活动可回溯测试；typecheck + npm test 全绿

## 参考

spec 实现决策 3（Activity 契约内联）；既有聚类管线（分段参数 hardGapMs / transientMs / overlapThreshold）。
