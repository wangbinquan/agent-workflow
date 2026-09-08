-- RFC-359 T19h / W18: preserve the existing overview and repository queries,
-- including their separate read points, while covering the columns they count.
-- Existing indexes stay available to their other consumers.
CREATE INDEX `idx_tasks_overview_counts` ON `tasks` (`status`,`parent_task_id`,`catalog_visibility`,`finished_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_cached_repo_task` ON `tasks` (`cached_repo_id`,`id`);
