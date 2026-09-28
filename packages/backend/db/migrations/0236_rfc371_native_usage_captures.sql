CREATE TABLE `observation_usage_captures` (
  `invocation_id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `source_id` text NOT NULL,
  `source_cursor` text NOT NULL,
  `native_root_key` text,
  `prior_revision_gap` integer DEFAULT 0 NOT NULL,
  `repair_pending` integer DEFAULT 0 NOT NULL,
  `document` text NOT NULL,
  `summary` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observation_capture_task_idx` ON `observation_usage_captures` (`task_id`, `invocation_id`);
--> statement-breakpoint
CREATE INDEX `observation_capture_root_gap_idx` ON `observation_usage_captures` (`native_root_key`, `prior_revision_gap`);
--> statement-breakpoint
CREATE INDEX `observation_capture_pending_idx` ON `observation_usage_captures` (`repair_pending`, `invocation_id`);
--> statement-breakpoint
CREATE TABLE `observation_usage_native_records` (
  `id` text PRIMARY KEY NOT NULL,
  `native_source` text NOT NULL,
  `native_root` text NOT NULL,
  `record_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observation_usage_native_step_idx` ON `observation_usage_native_records` (`native_source`, `native_root`, `record_id`);
