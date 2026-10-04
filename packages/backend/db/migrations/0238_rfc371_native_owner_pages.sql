CREATE TABLE `task_execution_native_usage_emissions` (
	`invocation_id` text NOT NULL,
	`event_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`source_row_id` integer NOT NULL,
	`document` text NOT NULL,
	`ack` text NOT NULL,
	PRIMARY KEY(`invocation_id`, `event_id`),
	FOREIGN KEY (`invocation_id`) REFERENCES `task_execution_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `native_usage_emission_source_idx` ON `task_execution_native_usage_emissions` (`source_row_id`);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_pass_heads` (
	`key` text PRIMARY KEY NOT NULL,
	`pass_id` text NOT NULL,
	FOREIGN KEY (`pass_id`) REFERENCES `task_execution_native_usage_passes`(`pass_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_pass_pages` (
	`pass_id` text NOT NULL,
	`ordinal` text NOT NULL,
	`payload_digest` text NOT NULL,
	`cumulative_digest` text NOT NULL,
	`document` text NOT NULL,
	`ack` text NOT NULL,
	PRIMARY KEY(`pass_id`, `ordinal`),
	FOREIGN KEY (`pass_id`) REFERENCES `task_execution_native_usage_passes`(`pass_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_passes` (
	`pass_id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`head_key` text NOT NULL,
	`owner_receipt_id` text NOT NULL,
	`identity` text NOT NULL,
	`initial_cursor` text NOT NULL,
	`admission` text NOT NULL,
	`root_created_at` integer,
	`state` text NOT NULL,
	`next_ordinal` text NOT NULL,
	`next_cursor` text,
	`digest` text NOT NULL,
	`position` text NOT NULL,
	`counts` text NOT NULL,
	`last_ack` text,
	`interruption` text,
	FOREIGN KEY (`invocation_id`) REFERENCES `task_execution_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "native_usage_pass_state_ck" CHECK("task_execution_native_usage_passes"."state" IN ('open','eof','interrupted','superseded'))
);
--> statement-breakpoint
CREATE INDEX `native_usage_pass_invocation_idx` ON `task_execution_native_usage_passes` (`invocation_id`,`pass_id`);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_preparations` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`owner_receipt_id` text NOT NULL,
	`fence` text NOT NULL,
	`document` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "native_usage_preparation_state_ck" CHECK("task_execution_native_usage_preparations"."state" IN ('open','sealed'))
);
--> statement-breakpoint
CREATE INDEX `native_usage_preparation_task_idx` ON `task_execution_native_usage_preparations` (`task_id`,`invocation_id`);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_revision_heads` (
	`invocation_id` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`invocation_id`, `record_id`),
	FOREIGN KEY (`invocation_id`) REFERENCES `task_execution_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_session_parents` (
	`pass_id` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_session_id` text,
	`ordinal` text NOT NULL,
	`path_digest` text NOT NULL,
	`depth` text NOT NULL,
	PRIMARY KEY(`pass_id`, `session_id`),
	FOREIGN KEY (`pass_id`) REFERENCES `task_execution_native_usage_passes`(`pass_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_execution_native_usage_step_members` (
	`pass_id` text NOT NULL,
	`step_id` text NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`pass_id`, `step_id`),
	FOREIGN KEY (`pass_id`) REFERENCES `task_execution_native_usage_passes`(`pass_id`) ON UPDATE no action ON DELETE cascade
);
