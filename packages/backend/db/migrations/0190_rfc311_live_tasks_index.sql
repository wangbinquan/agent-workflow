-- RFC-311 —— 生命周期不变量巡检的起手式是 `SELECT id FROM tasks WHERE deleted_at IS NULL`，
-- 而 `deleted_at` 上没有任何索引 ⇒ 每小时一次**裸全表扫描**，读的是 tasks 的宽行。
-- 部分索引只收录活任务的 id，既是覆盖索引（不必回表）、体积又远小于表本身。
-- 判据来自 tests/rfc311-perf-guards.test.ts 把 sweep 纳入计划审计后的实测。
--
-- 注意：不去改已经发布的 0189——迁移一旦落进共享树就当它已上线，改内容会让别人的库
-- 与代码永久分叉（本仓 admission preflight 会因哈希不符拒绝启动，见 docs/dev-gotchas.md）。
CREATE INDEX `idx_tasks_live` ON `tasks` (`id`) WHERE `deleted_at` IS NULL;
