# 35 — Suggestion → TaskProposal 全仓改名

**What to build:** 内部类型名从 Suggestion 改为 TaskProposal 的机械性全仓改名（shared 类型/契约、main 引擎与图标附着、preload、renderer store 与任务组件）。IPC 通道名（`suggestion:*`、`state:suggestions`）与 UI 文案"候选任务"一律不动——这是对外契约。

**Blocked by:** 无

**Status:** ready-for-agent

- [ ] 类型名 Suggestion → TaskProposal 全仓一致（grep 无残留 Suggestion 类型引用）
- [ ] IPC 通道名、EdgeApi 方法名、`state:suggestions` 推送名不变
- [ ] UI 文案"候选任务"不变
- [ ] typecheck（node + web）全绿 + npm test 全绿
- [ ] dev 冒烟：任务视图候选卡正常显示与交互

## 参考

spec 实现决策 1（通道与文案不动、内部类型改名）；CONTEXT.md 歧义区（2026-08-12 确认：UI 固定"候选任务"，代码类型名 TaskProposal）。
