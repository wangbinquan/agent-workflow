-- RFC-244 — composite indexes for keyset-paged task operations queries.
CREATE INDEX `idx_tasks_list_started_id` ON `tasks` (`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_list_status_started_id` ON `tasks` (`status`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_list_parent_started_id` ON `tasks` (`parent_task_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_list_owner_started_id` ON `tasks` (`owner_user_id`,`started_at`,`id`);--> statement-breakpoint
DROP INDEX `idx_tasks_status`;--> statement-breakpoint
DROP INDEX `idx_tasks_parent`;--> statement-breakpoint
DROP INDEX `idx_tasks_owner`;
