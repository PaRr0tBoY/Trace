# ADR-0008: 文件中转站与拖拽（Transfer Station & Drag Pipeline）

- 状态：已接受（2026-08-15，enhance/filedrop 合入后落文档）
- 关联：ADR-0001（sourceApp）；ADR-0006（摄取与可观测性——本 ADR 的 station 域是摄取阶梯"材料信号"的落点）；ADR-0009（任务资源模型——station 条目可 link 为任务 files 资源）

## 背景

**编号归位**：filedrop 分支开发时在代码注释中预占了 `ADR-0006`（station 域）/ `ADR-0007`（拖拽状态机、回收站）编号，但从未落文档；其后 ADR-0006 已被"数据摄取与可观测性改造"（grill 会话）、ADR-0007 已被"智能收起"（88dee25）占用——同一编号多个含义。本 ADR 把 filedrop 的架构落成文档，两处引用统一归位到本 ADR（0008）。

**文件域独立**（用户观察）：文件在剪贴板栈里与文本/图片混排，但生命周期语义不同——文件是路径引用（会失效、可搬移、可中转），文本/图片是内容快照。剪贴板栈（ItemStore）从此**只收 text/image**；文件复制 → 中转站（route = clipboard）；拖入 → 中转站（route = drag-in）；首次启动自动迁移 legacy 文件条目（id/capturedAt/pinned 保留），迁移的 id 从栈移除，用户无感。

## 决策

### 1. 中转站域（Station）

`stationStore` / `transferStation`（纯逻辑域模块，零 Electron 导入，vitest 测试）：条目 = 路径引用 + route + pinned + inTransit + capturedAt + stats。持久化 `station.json`（raw 条目列表——station 存的是**路径引用**不是内容，无需 DPAPI 信封；`station-content/` 下 app 写出的内容文件除外）。保留期复用剪贴板 `autoDeleteHours` 同一清扫，pinned/in-transit 条目豁免。

### 2. 拖拽检测（dragDetect）

OS 拖拽检测跑在 **utilityProcess**（dragHost.js）：`SetWinEventHook` 0x0F/0x10（OLE 拖拽开始/结束事件）+ DragWindow 轮询兜底（OLE 拖拽会捕获鼠标到 CLIPBRDWNDCLASS 窗口，0x0F 事件拿不到来源窗口）。与 keyboardHook 同一隔离理由：OS hook 回调不能跑在 Electron 主进程。

### 3. 拖拽会话状态机（dragSession）

由事实集 `{ isFileDrag, cursorInPanel, dragActive }` 驱动（ADR-0008 T4a 实测数据校准，阈值未经测量不得硬编码）：

- 面板关时文件拖拽 → **先出紧凑指示器，不弹面板**；光标进入检测区（面板展开会覆盖的屏幕空间）才展开（用户反馈 2026-08-14：拖拽不再直接弹面板）
- 拖拽中面板**锁 files 视图**——drag 是显式意图，restore 锚点与 landing 均不介入（ADR-0009 决策 5 的调取流程在其上展开）
- 拖拽期间心跳（heartbeat）暂停，避免自动收起打断会话

### 4. 拖出模式（stagedMove）

设置新增拖出模式：**复制（默认，现状）| 暂存搬移（M-a）**。搬移模式下拖出开始即把原件改名进 staging 区（`station-stage/`，与 tempDir 不同：**启动从不清理**——in-transit 条目持有这些文件直到搬移完成或条目删除），条目标记 in-transit；同卷 rename 原子，跨卷（EXDEV）copy+delete；任何失败回滚已暂存路径，调用方降级为原件直拖。两条方向都安全：取消 = 文件留在 station；误报成功最坏把暂存副本送回收站，**永不永久删除原件**。

### 5. 回收站安全网（recycleBin）

`SHFileOperationW`（koffi）：删除 in-transit 条目 / 完成暂存搬移 = 文件进回收站而非硬删。**station 域没有任何操作会永久删除文件**——失败时调用方保持状态不变（条目保留），toast 提示可重试。

### 6. 内容转文件（contentToFile）

文本/图片从外部拖入 → app 先在 `station-content/` 写出真实文件（文本 `text-<ts>.txt`，UTF-8 BOM 保证 Notepad/Word 识别编码）→ 走 `station:enter` 常规路径进 station。旧的拖入图片重新暂存路径删除。

### 7. 与任务系统接缝

`task:link-item` 与资源解析对 station 条目兜底（`stationClipboardItem`）：station 条目可 link 为任务的 **files 资源**；station 整条目拖拽（无显式路径）按条目路径构建文件包。文件归属空白（station 条目无来源应用）由 ADR-0009 决策 2 补齐。

## 后果

- **编号归位**：原注释 `ADR-0006`（station 域）/ `ADR-0007`（拖拽/回收站）统一指向本 ADR（0008）
- 剪贴板栈语义收窄（text/image only）；证据时间线的文件事件落 station 域
- 拖拽信号（面板外文件拖拽开始/结束 + 来源/目标窗口事实）是任务证据高价值源，比 OCR 便宜——进证据时间线的摄取补充见 ADR-0006 后续项
- 新 IPC 通道：`station:list/enter/enter-content/pin/delete`，四文件契约完整
