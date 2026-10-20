CREATE TABLE `node_run_seq_allocations` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`allocated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `node_runs` ADD `seq` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_node_runs_task_seq` ON `node_runs` (`task_id`,`seq`);
