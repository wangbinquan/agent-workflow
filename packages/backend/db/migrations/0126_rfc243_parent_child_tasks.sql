-- RFC-242 PR-2 — parent/child task linkage for node-invoked executions.
-- Zero backfill: NULL / 0 on every existing row is the correct semantics
-- ("not a child task"). space_kind gains the 'inherited' value at the
-- TypeScript boundary only (the column is plain TEXT — no CHECK to migrate).
ALTER TABLE `tasks` ADD COLUMN `parent_task_id` text REFERENCES `tasks`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `parent_node_run_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `invocation_depth` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `ref_closure_json` text;--> statement-breakpoint
CREATE INDEX `idx_tasks_parent` ON `tasks` (`parent_task_id`);--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `child_task_id` text;--> statement-breakpoint
CREATE INDEX `idx_node_runs_child_task` ON `node_runs` (`child_task_id`);
