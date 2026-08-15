# 34 — Golden Dataset 基建

**What to build:** 质量基准的两层数据集与评估脚本：从 ai-log 历史决策导出种子（golden/dev），用户抽查修正后抽出 golden/eval；评估脚本对给定输出算五项指标。本票只建基建与流程，真实跑分在收尾票接入主 seam。

**Blocked by:** 无

**Status:** ready-for-agent

- [ ] golden/dev 与 golden/eval 目录分层就位，种子记录含七项一级标签字段（activity boundary / current task / candidate ranking / switch / merge / suggestion level / reason）
- [ ] 导出脚本幂等：从 `%APPDATA%\Trace\ai-log.jsonl` 读历史建议/采纳/忽略决策生成种子，重复跑不产生重复记录
- [ ] 评估脚本（可独立 CLI）输入 golden 数据 + 系统输出，输出 precision / recall / false positive / duplicate rate / switch accuracy 五项指标
- [ ] 种子导出完成后提醒用户抽查修正（协作决议）
- [ ] vitest：指标计算正确性测试（构造小 fixture）；typecheck + npm test 全绿

## 参考

spec 实现决策 13（目录分层/七标签/五指标）；aiLog 现状（JSONL 条目含 ts 与字段）。
