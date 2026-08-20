-- RFC-311 —— 三条索引，全部由新的性能防护网（tests/rfc311-perf-guards.test.ts）实测指出。
-- 判据不是"看着该加"，而是防护网在 EXPLAIN QUERY PLAN 里拿到了 `USE TEMP B-TREE`
-- 或裸表 `SCAN`：两者都随数据量线性变慢，而且都跑在 daemon 唯一的同步连接上。

-- ① mission 列表的 keyset 排序键是 (created_at DESC, id DESC)，而既有索引只有
--    单列 created_at ⇒ 同一时间戳内的次序要临时排序。常态（毫秒时间戳、并列少）
--    影响小，但最坏情况（大量行共享同一 created_at）退化成全排序，因此在补上它
--    之前不能声称"最坏 O(页)"。此项此前被登记为受阻（journal 里有未追踪条目），
--    现已解禁。
CREATE INDEX `idx_development_missions_created_id` ON `development_missions` (`created_at`,`id`);--> statement-breakpoint

-- ② /repos 的 facets 里有一格「子模块同步失败」计数，谓词是两列等值，而两列都没有
--    索引 ⇒ 每次翻页都对 cached_repos 做一次**裸表扫描**。复合索引让它变成一次
--    覆盖索引 seek。
CREATE INDEX `idx_cached_repos_submodule_health` ON `cached_repos` (`has_submodules`,`last_submodule_sync_ok`);--> statement-breakpoint

-- ③ /repos 页内富化按 cached_repo_id 分组数 distinct task_id。既有索引只有
--    cached_repo_id 单列，GROUP BY 拿不到有序输入 ⇒ TEMP B-TREE。把 task_id 并进去
--    之后分组沿索引顺序完成，顺带成为覆盖索引（不必回表读行）。
CREATE INDEX `idx_task_repos_cached_repo_task` ON `task_repos` (`cached_repo_id`,`task_id`);
