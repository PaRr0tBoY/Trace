# IPC 合约

`shared/ipc.ts` 用三个类型映射定义全部通道，`shared/bridge.ts` 的 `EdgeApi` 是 preload 实现与 renderer 消费的接口。**新增通道必须改四个文件**，漏一个就类型或运行时报错：

1. `shared/ipc.ts` — 契约：InvokeMap / EventMap / SendMap 之一
2. `shared/bridge.ts` — EdgeApi 接口方法签名
3. `electron/preload/index.ts` — 实现（`invoke()` / `send()` / `on()` 类型安全助手）
4. `electron/main/ipc.ts` — handler 注册（`handle()` / `on()` 编译期校验助手）

- `InvokeMap` — renderer invoke → main 返回 Promise（`state:load`、`item:merge`、`app:get-releases`…）
- `EventMap` — main → renderer 推送（`state:items`、`window:cursor-edge`、`ui:toast`…）
- `SendMap` — 即发即弃（`item:start-drag`、`ui:input-focus`、`panel:expand`…）

## 通道清单

任务层通道：`task:load/merge/update/delete/link-*`、`task:suggest-title`（t56 迁入决策模块）、`suggestion:accept`（带 opts：title/note/apps/clipboardItemIds）、`suggestion:accept-with-resource`、`suggestion:ignore`（带 reason）、`task:app-options`（ADR-0002 编辑器应用网格）、`app:icons`（on-demand 图标）、`app:open-linked-window`（ADR-0005 窗口切换）。

AI 管道通道（t42/t51/t54）：`trace:list-by-decision/list-by-task/get-by-id/clear/export-report`（AI 依据）、`memory:list/act`、`memory-graph:list/set-state/adjudicate`（记忆面板）、`local-model:status/start-download/remove/set-source/set-path/pick-path`。

## 领域模型

`shared/types.ts`：`ItemData`（text/image/image-collection/files 判别联合）、`ClipboardItem`/`ClipboardItemDto`、`Settings`、`MAX_STACK = 10`、`DragRequest`。

## 教训：声明 ≠ 注册

- **0.2.6 合并丢失了三个 IPC handler（2026-08-11 恢复）**：`file:reveal`、`displays:list`、`window:set-preview-mode` 在 `shared/ipc.ts`/preload 有声明但 main 从未注册（真机报 `No handler registered`）。已恢复并注释。
- 四文件契约靠 typecheck 校验签名，但「声明了没注册」typecheck 查不出——新增通道后跑一次真机或 grep 确认 `handle('channel'` 存在。
