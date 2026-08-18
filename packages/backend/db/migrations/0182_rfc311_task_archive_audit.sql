-- RFC-311 T19 — 终态任务归档的审计行。
-- 归档 = 导出到 ~/.agent-workflow/archive/tasks/ 后从库里删行，被归档任务的
-- task_id 事后不再存在，所以这张表刻意**不建 tasks 外键**、也不进任务级联族：
-- 它必须比被它记录的任务活得久，否则「谁在什么时候归档了多少」当场随归档一起消失。
CREATE TABLE `task_archive_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`actor_user_id` text,
	`retention_days` integer NOT NULL,
	`tree_count` integer NOT NULL,
	`task_count` integer NOT NULL,
	`skipped_count` integer NOT NULL,
	`root_task_ids_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_archive_audit_created` ON `task_archive_audit` (`created_at`);
