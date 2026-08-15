# ADR-0001: 剪贴板条目的来源应用归属

- 状态：已接受（2026-08-11，grill-with-docs 会话）
- 关联：ADR-0002（任务创建引导流依赖此归属）

## 背景

任务创建引导流要求"选中进程图标后，显示该应用所属的剪贴板项目"。但现有 `ClipboardItem`
**没有来源应用字段**：t14 只在捕获瞬间构造 `ClipboardEvent`（appName/exePath/pid）发到内存
事件总线用于 task 自动链接，事件有界且重启清空，不落到条目上。没有持久归属，"按进程筛剪贴板"
就无从谈起。

## 决策

`ClipboardItem` 增加可选字段：

```ts
sourceApp?: { name: string; exePath?: string }
```

- 捕获时读前台快照（`queryForegroundSnapshot`），与 t14 的 `ClipboardEvent` **同一来源、
  同一隐私门控**：`taskCaptureEnabled && l0CaptureEnabled` 关闭时不记录；incognito 期间
  捕获的条目同样无归属。
- 随 items.json 一起 DPAPI 加密持久化，与条目同生命周期，删除/trim 时自然消失。
- 旧条目与无归属条目：正常显示、可正常使用，只是列表里不出现来源图标、不参与进程过滤。
- DTO 透传 `sourceApp`；图标不在推送时批量 attach（条目多、缓存小会抖动），改由按需
  IPC（`app:icons`，复用 appIconService 的 128 项缓存）取。

## 后果

- 进程过滤的候选集有稳定、持久的数据源。
- 无新持久化文件、无第二个来源：归属与事件总线本就是前台跟踪这一套的两个视图
  （见 ADR-0002 的进程集合决策）。
- 隐私语义与现有 t12/t14 完全一致，无新增泄露面。
