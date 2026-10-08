CREATE TABLE `system_agent_observation_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`original_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_task_id` text,
	`owner_user_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_preparations` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`owner_receipt_id` text NOT NULL,
	`fence` text NOT NULL,
	`document` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `system_agent_observation_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `system_native_usage_preparation_state_ck` CHECK("system_agent_native_usage_preparations"."state" IN ('open','sealed'))
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_emissions` (
	`invocation_id` text NOT NULL,
	`event_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`source_row_id` integer NOT NULL,
	`document` text NOT NULL,
	`ack` text NOT NULL,
	PRIMARY KEY(`invocation_id`, `event_id`),
	FOREIGN KEY (`invocation_id`) REFERENCES `system_agent_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_passes` (
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
	FOREIGN KEY (`invocation_id`) REFERENCES `system_agent_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `system_native_usage_pass_state_ck` CHECK("system_agent_native_usage_passes"."state" IN ('open','eof','interrupted','superseded'))
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_pass_heads` (
	`key` text PRIMARY KEY NOT NULL,
	`pass_id` text NOT NULL,
	FOREIGN KEY (`pass_id`) REFERENCES `system_agent_native_usage_passes`(`pass_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_pass_pages` (
	`pass_id` text NOT NULL,
	`ordinal` text NOT NULL,
	`payload_digest` text NOT NULL,
	`cumulative_digest` text NOT NULL,
	`document` text NOT NULL,
	`ack` text NOT NULL,
	PRIMARY KEY(`pass_id`, `ordinal`),
	FOREIGN KEY (`pass_id`) REFERENCES `system_agent_native_usage_passes`(`pass_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_revision_heads` (
	`invocation_id` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`invocation_id`, `record_id`),
	FOREIGN KEY (`invocation_id`) REFERENCES `system_agent_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_root_heads` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`claim_fence` text,
	`protocol` text NOT NULL,
	`next_ordinal` text NOT NULL,
	`first_root_session_id` text NOT NULL,
	`last_root_session_id` text NOT NULL,
	`digest` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `system_agent_observation_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_root_results` (
	`invocation_id` text NOT NULL,
	`result_id` text NOT NULL,
	`root_session_id` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`invocation_id`, `result_id`, `root_session_id`),
	FOREIGN KEY (`invocation_id`) REFERENCES `system_agent_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_root_sets` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`next_ordinal` text NOT NULL,
	`root_digest` text NOT NULL,
	`process_watermark` text NOT NULL,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `system_agent_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_root_transitions` (
	`invocation_id` text NOT NULL,
	`ordinal_key` text NOT NULL,
	`root_session_id` text NOT NULL,
	`document` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`invocation_id`, `ordinal_key`),
	FOREIGN KEY (`invocation_id`) REFERENCES `system_agent_native_usage_root_heads`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_session_parents` (
	`pass_id` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_session_id` text,
	`ordinal` text NOT NULL,
	`path_digest` text NOT NULL,
	`depth` text NOT NULL,
	PRIMARY KEY(`pass_id`, `session_id`),
	FOREIGN KEY (`pass_id`) REFERENCES `system_agent_native_usage_passes`(`pass_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_step_members` (
	`pass_id` text NOT NULL,
	`step_id` text NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`pass_id`, `step_id`),
	FOREIGN KEY (`pass_id`) REFERENCES `system_agent_native_usage_passes`(`pass_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_native_usage_store_bindings` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`before_owner_receipt_id` text NOT NULL,
	`source_generation` text NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `system_agent_native_usage_preparations`(`invocation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_observation_owners` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`original_attempt` text NOT NULL,
	`agent_id` text,
	`agent_name` text NOT NULL,
	`agent_revision` integer,
	`purpose` text NOT NULL,
	`runtime` text NOT NULL,
	`owner_nonce` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	FOREIGN KEY (`group_id`) REFERENCES `system_agent_observation_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `system_agent_observation_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`evidence_json` text NOT NULL,
	`pending` integer NOT NULL DEFAULT true,
	FOREIGN KEY (`task_id`) REFERENCES `system_agent_observation_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_run_id`) REFERENCES `system_agent_observation_owners`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `system_native_usage_emission_source_idx` ON `system_agent_native_usage_emissions` (`source_row_id`);
--> statement-breakpoint
CREATE INDEX `system_native_usage_pass_invocation_idx` ON `system_agent_native_usage_passes` (`invocation_id`,`pass_id`);
--> statement-breakpoint
CREATE INDEX `system_native_usage_preparation_task_idx` ON `system_agent_native_usage_preparations` (`task_id`,`invocation_id`);
--> statement-breakpoint
CREATE INDEX `system_native_usage_root_identity_idx` ON `system_agent_native_usage_root_transitions` (`invocation_id`,`root_session_id`);
--> statement-breakpoint
CREATE INDEX `system_observation_group_attempt_idx` ON `system_agent_observation_owners` (`group_id`,`id`);
--> statement-breakpoint
CREATE INDEX `system_observation_pending_idx` ON `system_agent_observation_sources` (`pending`,`node_run_id`,`id`);
--> statement-breakpoint
CREATE INDEX `system_observation_node_idx` ON `system_agent_observation_sources` (`node_run_id`,`id`);
