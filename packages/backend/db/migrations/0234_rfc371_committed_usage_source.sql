CREATE TABLE `task_execution_observation_sources` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks` (`id`) ON DELETE CASCADE,
  `node_run_id` text NOT NULL REFERENCES `node_runs` (`id`) ON DELETE CASCADE,
  `evidence_json` text NOT NULL,
  `pending` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_observation_pending` ON `task_execution_observation_sources` (`pending`, `node_run_id`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_task_observation_node` ON `task_execution_observation_sources` (`node_run_id`, `id`);
