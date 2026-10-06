CREATE TABLE `task_execution_native_usage_root_heads` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`claim_fence` text,
	`protocol` text NOT NULL,
	`next_ordinal` text NOT NULL,
	`first_root_session_id` text NOT NULL,
	`last_root_session_id` text NOT NULL,
	`digest` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_root_results` (
	`invocation_id` text NOT NULL,
	`result_id` text NOT NULL,
	`root_session_id` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`invocation_id`, `result_id`, `root_session_id`),
	FOREIGN KEY (`invocation_id`) REFERENCES `task_execution_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_root_sets` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`next_ordinal` text NOT NULL,
	`root_digest` text NOT NULL,
	`process_watermark` text NOT NULL,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `task_execution_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_root_transitions` (
	`invocation_id` text NOT NULL,
	`ordinal_key` text NOT NULL,
	`root_session_id` text NOT NULL,
	`document` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`invocation_id`, `ordinal_key`),
	FOREIGN KEY (`invocation_id`) REFERENCES `task_execution_native_usage_root_heads`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `native_usage_root_identity_idx` ON `task_execution_native_usage_root_transitions` (`invocation_id`,`root_session_id`);