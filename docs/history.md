# 仓库状态与历史决策

历史事实和已删除路径的记录——防止重蹈覆辙或恢复作废的设计。git 操作前看「仓库状态」。

## 仓库状态

- **单一 worktree**：`C:\Users\Acid\Documents\repo\Trace`（main）。feature/Animation、feature/tasks 分支已删除；animate/deslop 已 merge 入 main（2026-08-12），其 worktree（`C:\Users\Acid\.herdr\worktrees\Trace\animate-deslop`）待清理。
- **分支状态**：main = upstream 0.2.6 合并结果（merge 3741b70）+ 本地 100+ 提交（ADR-0001…0005、任务层、AI 层）未推送；upstream 同步按需手动做。

## upstream 同步（2026-08-09）

已合并 Deepender25/Edge-Drop 到 v0.2.6（63 提交 / 3 万行：i18n 30 语言、设置 3-tab 重构、Web Audio 音效、多显示器持久化、性能优化、vitest）。**自动更新（electron-updater）已整体剔除**——silent auto-update 会下载 upstream 的包覆盖 Trace，合并后删除了 updater.ts、相关 IPC 通道、设置 UI 与 i18n 键；保留 `app:get-releases`（What's New 视图，指向 PaRr0tBoY/Trace releases，离线回退静态 changelog）。品牌已全部替换为 Trace；ChangelogView.tsx 与 ipc.ts 的静态 changelog 保留 Edge-Drop 历史原文；AppX 证书身份（Deepender.EdgeDrop）保留（证书绑定）。

## feature/tasks 已删除（2026-08-09）

任务系统设计作废（上游大更新后决策推翻重建）。旧设计要点（Task 聚合根、四层面板、Alt-Tab 窗口切换、koffi 键盘轮询、C# 窗口枚举 helper）仅存于 git 历史（`3dc9b07`、`f146a96`），重建时可参考但不要恢复代码。**任务系统现已重建（2026-08-12，ADR-0001/0002/0003/0005 + animate/deslop 合并）：引导式 TaskEditor、窗口切换、restore、主题、双行导航。**

## t14 剪贴板自动归属已移除（2026-08-12）

任务关联内容只由显式操作变更（拖入绑定、task:link-item/unlink）。剪贴板事件仍带来源 app（sourceApp，ADR-0001）和 itemId 流向建议引擎（分段 + readItem），但不再自动 link 到任务；`decideClipboardAttribution`/`autoAttributionEnabled` 已删，剪贴板事件只在 attributor.ts 的 `buildClipboardEvent` 记录。

## tutorial IPC 死链已清（2026-08-13，t58）

`tutorial:step`（EventMap）/`tutorial:set-step`（SendMap）两端 main 均无对端，已从四文件删除；renderer 内部 `tutorialStep` 状态流保留（onboarding 过滤逻辑）。**`app:quit` 曾是无 handler 的活坏通道**（Settings 退出按钮 reject 被 void 吞），已补注册 `app.quit()`。

## 杂项

- `drag_debug.txt` 是 OLE 拖拽排障日志，已被 gitignore（upstream 加的），运行时生成不提交。
