# 58 — 九项阶段不变量验收矩阵 + 残留复查

验收范围：spec.md:340-349 九项阶段不变量（A/B/C/I/D/G/F/H/E）+ 票 58 残留复查项。
验证方式：实现位置（代码实证）+ 测试证据（vitest）+ 全量回归（44 文件 / 896 测试全绿，typecheck node+web 全绿）。
运行环境：Windows 11，2026-08-13，`npx vitest run`（896/896 pass，6.6s）+ `npm run typecheck`（0 error）。

## 一、九项不变量逐项结论

| # | 不变量 | 结论 | 实现位置 | 测试证据 | 缺口 |
|---|--------|------|----------|----------|------|
| A | 现有功能不变（建议/任务/剪贴板行为保持） | **成立** | 旧职责迁移后引擎行为不变：suggestionEngine.ts（t19 建议/接受/忽略/剪贴板引用）+ TaskStore.ts（任务状态机）+ ItemStore.ts（剪贴板）均原地保留；聚类迁 activityLedger.ts（t40）、决策迁 decisionProvider.ts（t55/56），suggestionEngine 只做胶水 | 全量回归：44 测试文件 896 用例全绿（含既有行为套件 clusterer/attributor/eventBus/suggestionEngine/taskGroups/taskEditorModel/appOptions/restore/ocr 等）；typecheck:node + typecheck:web 0 error。决策链端到端 decisionChainE2E.test.ts:237「事件→活动→决策→提案→采纳→任务/会话/记忆/trace 全链」证明新旧路径并存不回归 | 无 |
| B | TaskSession 可解释当前 RUNNING（开/结算原子） | **成立** | TaskStore.ts:899-912 openSession（进 RUNNING 必开）、:919-926 settleSession（离 RUNNING 必结）、:827-835 makeRunning 原子结算旧+开新（previousTaskId 链接）、:372-382 load() 孤儿修复（非 RUNNING 的开会话按最后状态变更结算）+ RUNNING 无会话回填；持久层 sessionStore.ts（sqlite task_sessions 表 + 内存实现） | taskSessions.test.ts:56-122（create RUNNING 开会话/confidence 记录/paused/activity_lost/completed/archived 各 settle 原因/resume 开新会话）、:126-209（原子 switch：结算旧 + previousTaskId 单调用完成）、:210-250（merge/delete RUNNING 任务结会话）、:291-399（重启水合 + 孤儿修复）、:433-515（sqlite 持久化跨实例回读） | 无 |
| C | 任何 Activity 可回溯至 Event | **成立** | activityLedger.ts:710 eventsOf(activityId)（最近一趟分析的事件集）；Activity 文档（:586-595）：旧活动按 [startAt,endAt] 时间窗从证据时间线重建（分段划分批次故窗口精确）；evidenceStore.ts:38-49 事件行（capturedAt/source/payload）持久化于 events 表（db.ts:40-49 canonical timeline） | activityLedger.test.ts:169-199「eventsOf 恰好返回活动窗口内事件」（含剪贴板行随段携带、未知 id 空数组）、:201-211「[startAt,endAt] 窗口是可达的重建查询条件」（window query 与 eventsOf 事件集一致）、:267-268（205 事件大段回溯） | 无（eventsOf 只覆盖最近一趟分析，旧活动走时间窗重建——文档明示，属设计语义） |
| I | 任何 Agent decision 可追溯 | **成立** | traceStore.ts:23 五 kind（observed/recall/decision/result/privacy）共享 decisionId 分组；currentTaskController.ts:380-426 recordDecision（observed+decision 同链，decisionId 在调用前创建 :538）；suggestionEngine.ts:1094-1100/1145-1150 accept/ignore 回填 result 行（同 decisionId）；db.ts:113-126 trace 表 decisionId NOT NULL + 索引 | traceStore.test.ts:43-71 fullChain 五 kind 满字段共享 decisionId、:102-116 链内排序、:118-126 listByTaskId、:229-234 sqlite 同语义；currentTaskController.test.ts:194-196（observed+decision 同链断言）、:546-548（continue 决策链）；decisionChainE2E.test.ts（采纳/忽略 result 回填同链） | 无 |
| D | 被拒数据绝不进 Agent | **成立** | decisionProvider.ts:313-360 applyPrefillPrivacy（denied 应用剥离 apps/窗口标题/appCombination、memoryAccess 关清预填记忆、aiEnabled/时间窗关整趟停 → 算法兜底）；:244-252 gateToolCall（clipboardAccess 关 → search_clipboard 空结果行 + 拦截记录）；:275-278 filterClipboardHitsByType；state.ts:802-872 buildAgentTools（search_tasks/search_activities 结果格再过 deniedApps 过滤）；suggestionEngine.ts:599-603 引擎候选也按隐私过滤 | decisionProvider.test.ts:252-258（null policy 透传）、:261-288（denied 应用三处全剥离 + 拦截块）、:298-310（memoryAccess 关）、:312-323（aiEnabled/时间窗关）、:508-524（clipboardAccess 关 → 空结果 + privacy 记录 + 提示词无剪贴板）、:565-588（denied 应用不进升级路径：查询串与 Tool results 均无被拒应用键）；privacyGate.test.ts（aiAllowed 各维度） | 无 |
| G | 同类建议不重复打扰（冷却/忽略/升降级） | **成立** | recommendationHistory.ts:47-51 分级冷却（L1 24h/L2 48h/L3 7d）、:133-137 accepted 永久抑制、:123-157 pattern 学习得分（采纳增强/忽略按原因衰减）；activityLedger.ts:883 冷却门（recommendationFingerprint）；suggestionEngine.ts accept/ignore 记录点（:1074-1091/:1128-1143）+ 决策路径 ignore 落 L3（currentTaskController.ts:503-512） | recommendationHistory.test.ts:52-77（指纹稳定/时段桶/应用集区分）、:92-144（三级冷却边界 + 重叠记录取较新 + accepted Infinity）、:153-186（record 回填/终态）、:214-277（pattern 权重：采纳增强、user-edit 最强、忽略按原因衰减、下限 0.05）、:607-620（忽略后同指纹下一趟被冷却门压空）、:622-631（accepted 同桶永不重推）、:634-645（冷却结束可再建议）；t47 升降级：suggestionEngine.test.ts 分级测试 | 无 |
| F | 任何长期记忆可回溯到 Episode | **成立** | memoryGraph.ts:89 facts.episodeId（来源链）、db.ts:76-94 facts 表 episodeId 列 + idx_facts_episodeId；episodeConsolidator.ts:247-251 提取强制来源链（episodeId 不在批次内 → 丢弃，绝不虚构来源）；memoryGraph.ts:1266-1313 createMemoryIndexAdapter（面板记忆经 facts 表读写）；:301-320 同 episode 扩散边 | memoryGraph.test.ts:111-126「facts 携带 episode 来源链与实体边」、:159-169（episodeId 过滤契约）；episodeConsolidator.test.ts（批次提取 + 来源链完整性丢弃分支）；memoryIntegration.test.ts | 部分成立注：用户自建/任务反馈类事实（非提取路径）episodeId 为 null——非提取来源，无 episode 可锚，属设计语义而非缺口 |
| H | 本地模型关/失败 = 纯算法等价 | **成立** | localModelOptimizer.ts:112-137 失败路径全返回 null（绝不半成品列表）、:162 createCandidateOptimizer 注入缝；decisionProvider.ts:569-606 createLocalModelDecisionProvider（null/空/抛错 → 内层算法原样，:577-596）；suggestionEngine.ts:773-774 优化器未接线/降级 → 算法候选原样 | localModelOptimizer.test.ts:102-110（抛错/畸形回复 → null）、:65-67（空列表 null，模型不能静音管线）；suggestionEngineLocalModel.test.ts:96-106（未接线原样）、:163-184（null/抛错降级，标题与顺序与纯算法一致）、:186-192（空列表降级）、:194-207（归因分数不被本地模型覆盖）；decisionProvider.test.ts:220-247（本地模型失败 → 算法候选原样）；localModelProvider.test.ts:72-81（infer 失败 ok:false + 错误透传） | 无 |
| E | 99% 普通状态不触发 LLM（六触发门控） | **成立** | currentTaskController.ts:273-310 detectTriggers 六触发（score-drop/candidate-ahead/new-cluster/idle-resume/competition/session-boundary）；:613-617 无触发 → decisionCalls 0 稳态；:639-656 pending 窗口 dwell（switchDwellSeconds）+ lastDecidedKey 同候选抑制（决策过不重复开窗）；:626-637 离散事件（边界/恢复）即时一次；:212-215 switchHysteresisOk（threshold+margin+dwell 三条件） | currentTaskController.test.ts:150-160「稳定连续活动 → 决策者 0 次调用」（5 次观察全部 triggers=[] / decisionCalls=0 / calls 长度 0）、:163-170（稳定低置信归属也 0 次）、:176-213（跌破阈值 → 窗口开启不调用 → dwell 满恰好 1 次 → 同候选不再调用）、:226-244（候选领先 dwell 门控）、:275-325（margin/threshold 门拒绝 → 重开窗）、:337-382（new-cluster/competition 触发）、:391-453（boundary/idle-resume 即时一次） | 无 |

## 二、残留复查结果

| 复查项 | 判定 | grep 证据 |
|--------|------|----------|
| 旧引擎职责（聚类/决策/suggestTitle 不在 suggestionEngine 内） | 干净 | `grep clusterEvents\|segmentEvents\|suggestTitle\|evaluateTaskContext\|buildSegments` in electron/main/suggestionEngine.ts → 0 命中；聚类在 electron/store/activityLedger.ts（segmentEvents:370 / clusterEvents:422），决策在 decisionProvider.ts（createAgentDecisionProvider:484 / createTitleSuggester:678 / suggestTitle 用例 decisionProvider.test.ts:595-643），控制器在 currentTaskController.ts。suggestionEngine 仅 import activityLedger/decisionProvider 胶水 |
| 旧记忆 JSON（memories.json 迁移后无写入残留） | 干净 | `grep memories\.json` → 仅 4 处代码引用，全部是迁移/降级路径：state.ts:171-243（load + verify-then-delete 一次性迁移）、state.ts:632-636（`memoryGraph ? memoryIndexAdapter.save : saveMemoriesFile`——图健康时保存走 facts 表，JSON 只在 DB 故障降级时写）、memoryGraph.ts:444 ingestLegacyMemories、paths.ts:24 路径声明。golden/dev/seed-golden.json 为跑分种子内容（合法数据） |
| Ollama 痕迹 | 干净 | `grep ollama`（全库，case-sensitive）→ 0 命中（票 52 删除确认） |
| 孤儿声明：IPC 四文件声明 vs handler 注册一致性 | **2 处孤儿通道** | 见下表 |

### IPC 四文件核对表（shared/ipc.ts 声明 ↔ preload 暴露 ↔ main 注册）

四文件：`shared/ipc.ts`（InvokeMap/SendMap/EventMap 声明）、`shared/bridge.ts`（EdgeApi 类型）、`electron/preload/index.ts`（桥暴露，`const _bridge: EdgeApi = api` 编译期校验）、`electron/main/ipc.ts`（`handle`/`on` 类型化注册，channel 名漂移编译期即错）。

| 方向 | 声明数 | 注册数 | 核对结果 |
|------|--------|--------|----------|
| Invoke（renderer→main，handle） | 52 | 51 | 51/52 一一对应，无重复注册、无无声明注册；**缺失 1：`app:quit`** |
| Send（renderer→main，fire-and-forget） | 5 | 4 | 4/5 一一对应；**缺失 1：`tutorial:set-step`** |
| Event（main→renderer，send） | 12 | 11 发送点 | 11/12 有发送点；**缺失 1：`tutorial:step` 在 main 无任何发送点**（preload 有监听 onTutorialStep，App.tsx:81 订阅，永不触发） |

#### 孤儿通道详情

1. **`app:quit`**（InvokeMap，shared/ipc.ts:116）：preload 暴露 `quitApp`（preload/index.ts:119），渲染层活跃使用（Settings.tsx:245「退出登录」按钮 `void window.edge.quitApp()`）——**main 侧无任何 `ipcMain.handle('app:quit')`**。调用即 reject（"No handler registered"），`void` 吞掉未处理拒绝，按钮实际无效。真实退出路径为托盘菜单（tray.ts:184 `app.quit()`）。属**活着的坏通道**，非纯死代码。
2. **`tutorial:set-step`**（SendMap，shared/ipc.ts）：preload 暴露 `broadcastTutorialStep`（preload/index.ts:135），渲染层使用（appStore.ts:419 `edge.broadcastTutorialStep(step)`）——**main 侧无 `ipcMain.on`**。fire-and-forget 发进虚空，静默无副作用。
3. **`tutorial:step`**（EventMap）：preload 监听（onTutorialStep），App.tsx:81-83 订阅——**main 侧无任何 send 点**。渲染层教程步进实为纯客户端状态（appStore.setTutorialStep 本地驱动），该通道整条往返（set-step + step）已死。

结论：IPC 体系 66/69 通道有完整对端（invoke 51/52、send 4/5、event 11/12），**3 个通道无对端：app:quit（无 handler）、tutorial:set-step（无 handler）、tutorial:step（无发送点）——共 2 项功能 4 处声明残留**（tutorial 往返 3 处 + quit 1 处），建议清理（移除声明/暴露/调用，或补回 handler 恢复功能）。

## 三、验证方式与复现命令

- 全量测试：`npx vitest run` → 44 files / 896 tests 全绿（2026-08-13 实测）
- 类型检查：`npm run typecheck`（node + web 双工程）→ 0 error
- 不变量逐项证据：上表「测试证据」列均为对应测试文件内断言位置（vitest 直跑，纯逻辑零 Electron import）
- Golden seed 完整性：golden/dev/seed-golden.json = 181 条（与票 58「181 条」一致）；跑分基线与用户抽查见 Ticket58EvalRunner 报告（本文档不替代 N4 抽查决议）
- 残留复查为 grep 实证（grep 工具，全库范围），非人工目测
