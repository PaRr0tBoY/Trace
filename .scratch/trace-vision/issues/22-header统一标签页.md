# 22 — Header 统一标签页（任务并入 Select）

**What to build:** 任务视图不再替换掉剪贴板 5 个 filter chips；"任务"作为第 6 个 chip 并入，统一用滑动 pill（Select）切换。右侧任务图标按钮退役，徽标迁到 chip 上。顺带真机复现并修复用户报告的 pill 偏移（"越往右越偏，几乎没框住文件"）。

**Blocked by:** 无

**Status:** open

- [ ] Header FILTERS 增加 `tasks` 项（label i18n：zh 必填）；view==='tasks' 与 typeFilter 统一由 activeIndex 驱动 pill
- [ ] pill 位置 = activeIndex × (chipWidth + gap)，chip 宽度固定，多语言下不偏移（真机：逐个点 6 个 chip，pill 都框住对应标签，最右的"任务"也必须框住）
- [ ] 点任务 chip → view='tasks'（清 preview/styleFlyout，逻辑沿用现状）；点回剪贴板 chip → view='clipboard' 且恢复上次 typeFilter
- [ ] 任务 chip 显示 Paused+Waiting 徽标（现状 header 右侧 badge 逻辑迁移）；suggestions 橙色角标一并迁移或按用户意见处理
- [ ] 若真机确认 pill 偏移存在：定位根因修复（不糊补丁）；若为上游遗留或不存在，记录结论
- [ ] typecheck + npm test 全绿；真机：6 chip 切换、badge 显示、切任务视图再切回 filter 状态保持

## 参考

Header.tsx 现状（tasks 分支 + FILTERS + pill animate）、appStore view/typeFilter、CONTEXT.md。规格《实现决策 8》V1 交互如有冲突，实现后同步改 spec.md。
