# 33 — SQLite 基建（migration 框架 + 建表 + FTS5）

**What to build:** trace.db 本地库的骨架：打开/关闭、顺序 migration（user_version）、全部 7 张表与 FTS5 索引、WAL 模式。业务模块（事件、会话、记忆、trace、推荐历史）各自填充逻辑，本票只保证表结构存在且可迁移。

**Blocked by:** 32

**Status:** ready-for-agent

- [ ] migration 框架：空库按顺序建表，重复打开不重复执行，版本号正确推进
- [ ] 7 张表全部建出：events / episodes / entities / facts / task_sessions / trace / recommendation_history，列符合 spec 契约（时间字段统一 epoch ms）
- [ ] FTS5 索引就位（事件与记忆检索用）
- [ ] WAL 模式开启；db 文件位于 userData 并登记进集中路径定义，与现有 JSON 存储并列
- [ ] 纯逻辑可注入（测试用临时文件/in-memory），vitest 覆盖：空库建表、幂等打开、版本迁移
- [ ] typecheck + npm test 全绿；dev 冒烟启动正常

## 参考

spec 实现决策 2（证据时间线 SQLite）；handoff「A 阶段落地顺序」。
