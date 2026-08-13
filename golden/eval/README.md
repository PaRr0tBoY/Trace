# Golden Eval — 基线记录

Golden Dataset 首次跑分基线（票 58 验收项 1，spec §13）。

## 基线数据

| 文件 | 说明 |
| --- | --- |
| `baseline-2026-08-13.json` | 首次跑分 system-output（181 条 `{id, labels}` 预测） |
| `seed-golden.json`（`../dev/`） | golden 种子（181 条，七标签） |

## 五项指标（2026-08-13）

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| precision | 1.0000 | 153 TP / (153 TP + 0 FP) |
| recall | 0.9935 | 153 TP / (153 TP + 1 FN) |
| false positive | 0 | 绝对数 |
| duplicate rate | 0.0000 | 0 / 181 |
| switch accuracy | 1.0000 | 2 / 2（golden 侧仅 2 条带布尔 switch） |

detail：`{"tp":153,"fp":0,"fn":1,"duplicates":0,"total":181,"unmatched":0,"switchCorrect":2,"switchTotal":2}`。

**唯一的 FN**：`a1786541205685-s_msq4i8qb-erjveyh0`（golden `merge: true`，预测 `false`）——算法决策者
（`createAlgorithmDecisionProvider`）只产出 continue/switch/new，不产 merge；该记录是旧引擎
"并入既有任务"的 accept。这是当前决策层与 golden 行为的真实差距，后续 Agent/本地模型路径接入
merge 后可重跑对比。

## 生成命令

```sh
node scripts/golden-runner.cjs                          # 读 golden/dev/seed-golden.json → golden/eval/baseline-<date>.json
node scripts/eval-golden.cjs golden/dev golden/eval/baseline-2026-08-13.json
```

- runner 幂等：同一 seed 输入 → 字节一致输出（标签不含随机量；会话/决策 id 为随机
  `createId` 但不进标签、trace 未接线）。
- seed 完整性：181/181 id 命中，无多余、无重复（runner 内建校验，失败退出码 1）。

## 回放方式（golden-baseline.ts）

每条 seed 记录 = 一次独立回放（fresh TaskStore + fresh `CurrentTaskController`，零跨记录状态）：

1. **输入构造**：segment → `Activity`（startAt = `ts − durationMs`，`attribution` 取
   `segment.taskId`，zone/confidence/windowTitles 原样）；`ActivityDetail.evidence` 的
   `overlappingTasks` = 与段共享应用集的任务（**排除归属胜者**，与 `clusterEvents` 同语义，
   封顶 8）。
2. **种子任务**：归属任务（running）+ 全部候选建议（waiting，作为任务池）。归属任务标题
   seed 未携带 `[INFERENCE]`：段窗口标题/应用名兜底——只进 ctx/理由字符串，不进任何标签。
3. **时钟**：now 从记录 `input.ts` 起步；第二次观察前进 `switchDwellSeconds(45s)+1ms`。
4. **决策者**：`mode === 'algorithm'` → 真实算法决策者；`mode === 'llm'` → 脚本决策者
   （按记录 `output.suggestion` 脚本化——记录本身就是该分析时刻的真实 LLM 产出）。
5. **两次观察**让候选驱动触发（new-cluster / competition）的 pending 窗口成熟为恰好一次
   决策调用（spec 决策 5：候选持续满 dwell 才调用；单次观察只开窗不决策）。

## 七标签映射

| 标签 | 映射 | 备注 |
| --- | --- | --- |
| activityBoundary | 末次观察 triggers 含 `new-cluster` / `session-boundary` | 与 golden 的 `zone==='new'` 定义同源（new-cluster 即由 zone new 触发）；本回放 153 true / 28 false 与 golden 全同 |
| currentTask | continue/switch/merge 的目标任务；new/ignore → null；无决策 → 控制器跟踪的 RUNNING 任务 | 181/181 与 golden 一致 |
| candidateRanking | 决策目标任务在预填候选（`ctx.candidates`，[0]=归属胜者）中的 1-based 名次 | **INFERENCE**：golden 是旧引擎建议列表名次（1..20），控制器候选空间不同（≤3 确定性候选）——可比性有限，未计分 |
| switch | 有决策 ? `action==='switch'` : null | golden 侧仅 2 条布尔（均 false），预测均 false |
| merge | 有决策 ? `action==='merge'` : null | 唯一 FN 来源（见上） |
| suggestionLevel | 有决策 ? `decidedBy==='algorithm' ? 'algorithm' : 'llm'` : null | 与 golden 语义一致（标题出处）；llm 模式经脚本决策者复现 |
| reason | 有决策 ? `decision.reason` : null | golden 仅 1 条非 null（accepted Agentic 记录），脚本决策者按 suggestion.reason 精确复现 |

## 已知局限

- **候选驱动触发依赖任务池**：回放把旧引擎的候选建议全部种子为 waiting 任务（它们在当时
  就是已知任务），`overlappingTasks` 语义与 ledger 对齐（排除归属胜者）。因此 continuation
  记录靠 competition 触发决策；2 条记录（`a1786461421609-s_msot01a8-3z7iwwlh`、
  `a1786543743229-s_msq60mpm-9fsqua7b`）无 ≥2 重叠任务 → 稳态 noop（不变量 E 行为），
  switch/merge/suggestionLevel/reason 预测为 null（golden 对应值未计分）。
- **`margin` 置 0** `[INFERENCE]`：seed 未携带聚类相似分差。本回放中归属恒等于运行任务，
  candidate-ahead 触发与切换滞回门不参与，不影响任何标签。
- **candidateRanking / suggestionLevel(null) 不可比**：见上表；二者未进入五项指标计分
  （golden-metrics 只对布尔标签计分）。
- **llm 模式为脚本化 oracle**：16 条 llm 记录用真实 LLM 产出脚本化决策者，不代表当前
  Agent 决策链的真实行为（后者未接线 LLM，见已知局限下条）。
- **阈值/参数**：使用测试同款缺省（dwell 45s、θ_low 0.45、margin 0.1、idle 15min），
  非生产 Settings 投影；对结果影响面见上文（candidate-ahead/switch 门未参与）。
- 基线是**系统行为**基线：golden 的 switch/merge/reason 只在"用户采纳/忽略"时非 null
  （null = 无决策观察），预测侧非 null 表示"控制器做出了决策"——语义差异由计分规则天然
  吸收（golden null 的行不计分）。
