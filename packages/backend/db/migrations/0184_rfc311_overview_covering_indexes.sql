-- RFC-311 G2 — 首页与徽章计数的**覆盖索引**。
--
-- bench-results §G2 记下的方向就是这条：不要把 9 条 count 合并成 1 条 SQL（那会
-- 把几次索引 seek 换成一次全表扫描，在真实分布下反而更慢），要给小基数视图补
-- 覆盖索引。这里补的两条都指向同一个根因：**谓词里的列不在索引里，于是每条候选
-- 都要回表一次只为读一个字段**。
--
-- ① 首页四张卡片（running / awaiting / done7d / failed7d）都带
--    `parent_task_id IS NULL`（子执行不上首页），而既有索引 (status, finished_at)
--    不含 parent_task_id ⇒ 命中该状态的每一行都要回表判断父指针。加上它之后
--    四条计数都能在索引内完成（SQLite 的 NULL 排在最前，`IS NULL` 是索引前缀上
--    的一段连续范围）。
-- ② 工作组待办徽章扫的是「有 workgroup_id 且状态属于活跃四态」，同样为了读
--    workgroup_id 而回表。(status, workgroup_id) 让筛选阶段留在索引内，只有真正
--    的候选行才回表读 owner/config。
CREATE INDEX `idx_tasks_status_parent_finished` ON `tasks` (`status`,`parent_task_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_workgroup` ON `tasks` (`status`,`workgroup_id`);
