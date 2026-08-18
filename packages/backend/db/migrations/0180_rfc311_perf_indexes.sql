-- RFC-311 PR-1 T1 — 性能索引批 + tasks.branch_started_at 物化列 + maintenance_state。
--
-- 背景（证据档 design/RFC-311-database-performance-and-scalability/audit-2026-08-18.md）：
-- 单条同步 bun:sqlite 连接上，多处周期扫描/徽章计数因缺索引退化为全表扫；
-- /api/tasks/page 的树排序键 branch_started_at 是聚合值，无物化列时每页请求都要
-- 全量递归聚合。partial index 只收活跃/未决行，把「表增长」与「索引写放大」解耦。

ALTER TABLE `tasks` ADD COLUMN `branch_started_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- 回填：每行 = 以该行为根的子树内 max(started_at)（深度限 64，与运行时 MAX_TREE_DEPTH 一致）。
-- 用 TEMP 聚合表避免「UPDATE 相关子查询内嵌 CTE」的引擎兼容坑；temp 表不进物理 schema。
CREATE TEMP TABLE `_rfc311_branch_backfill` AS
  WITH RECURSIVE sub(root, id, depth) AS (
    SELECT `id`, `id`, 0 FROM `tasks`
    UNION ALL
    SELECT sub.root, c.`id`, sub.depth + 1
    FROM `tasks` c JOIN sub ON c.`parent_task_id` = sub.id
    WHERE sub.depth < 64
  )
  SELECT sub.root AS root, MAX(t2.`started_at`) AS bsa
  FROM sub JOIN `tasks` t2 ON t2.`id` = sub.id
  GROUP BY sub.root;
--> statement-breakpoint
UPDATE `tasks` SET `branch_started_at` = COALESCE(
  (SELECT bsa FROM `_rfc311_branch_backfill` WHERE root = `tasks`.`id`),
  `started_at`
);
--> statement-breakpoint
DROP TABLE `_rfc311_branch_backfill`;
--> statement-breakpoint
CREATE INDEX `idx_tasks_branch_started_id` ON `tasks` (`branch_started_at`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_cached_repo` ON `tasks` (`cached_repo_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status_finished` ON `tasks` (`status`, `finished_at`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_source_agent` ON `tasks` (`source_agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_code_round` ON `tasks` (`code_round_id`);
--> statement-breakpoint
-- 注意：不能写成 partial（WHERE status IN …）——SQLite 的蕴含判断不认
-- 「status='running' ⊂ status IN (…)」，等值谓词会退回全表扫。
CREATE INDEX `idx_node_runs_status_active` ON `node_runs` (`status`, `started_at`);
--> statement-breakpoint
CREATE INDEX `idx_doc_versions_pending_created` ON `doc_versions` (`created_at`) WHERE `decision` = 'pending';
--> statement-breakpoint
CREATE INDEX `idx_memories_created` ON `memories` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_skill_versions_fusion` ON `skill_versions` (`fusion_id`);
--> statement-breakpoint
CREATE INDEX `idx_code_findings_external_created` ON `code_findings` (`created_at`) WHERE `external_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_code_work_items_created` ON `code_work_items` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_code_work_rounds_started` ON `code_work_rounds` (`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_code_ai_attempts_started` ON `code_ai_attempts` (`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_code_artifacts_released` ON `code_artifacts` (`released_at`) WHERE `ref_count` = 0;
--> statement-breakpoint
CREATE INDEX `idx_development_missions_created` ON `development_missions` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_development_missions_fenced` ON `development_missions` (`id`) WHERE `transition_fence` != 'none';
--> statement-breakpoint
CREATE INDEX `idx_dev_mr_claims_lookup` ON `development_mr_claims` (`code_host_endpoint_ref`, `stable_project_ref`, `mr_iid`);
--> statement-breakpoint
CREATE INDEX `idx_dev_wake_hints_unconsumed` ON `development_wake_hints` (`mission_id`) WHERE `consumed_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_dev_deferred_wakes_due` ON `development_deferred_wakes` (`resume_at`) WHERE `state` = 'armed';
--> statement-breakpoint
CREATE INDEX `idx_dev_agent_attempts_execution_ref` ON `development_agent_attempts` (`execution_ref`);
--> statement-breakpoint
CREATE INDEX `idx_dev_effects_prepared` ON `development_effects` (`created_at`) WHERE `state` = 'prepared';
--> statement-breakpoint
CREATE TABLE `maintenance_state` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` integer NOT NULL
);
