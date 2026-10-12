CREATE TABLE `task_clarify_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`logical_key` text NOT NULL,
	`asking_node_id` text NOT NULL,
	`clarify_node_id` text NOT NULL,
	`binding_digest` text NOT NULL,
	`host_json` text NOT NULL,
	`head_entry_ref` text,
	`entry_revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_clarify_channel_key` ON `task_clarify_channels` (`task_id`,`logical_key`);--> statement-breakpoint
CREATE TABLE `task_clarify_consumptions` (
	`node_run_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`material_id` text NOT NULL,
	`acceptance_ref` text NOT NULL,
	`source_context_digest` text NOT NULL,
	`snapshot_set_digest` text NOT NULL,
	`finalized_prompt_digest` text NOT NULL,
	`accepted_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `task_clarify_materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_clarify_consumption_acceptance` ON `task_clarify_consumptions` (`acceptance_ref`);--> statement-breakpoint
CREATE INDEX `idx_task_clarify_consumption_material` ON `task_clarify_consumptions` (`material_id`);--> statement-breakpoint
CREATE TABLE `task_clarify_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`entry_revision` integer NOT NULL,
	`host_entry_key` text NOT NULL,
	`host_json` text NOT NULL,
	`source_asking_run_id` text NOT NULL,
	`source_context_digest` text NOT NULL,
	`source_context_json` text NOT NULL,
	`config_snapshot_ref` text NOT NULL,
	`trigger_json` text NOT NULL,
	`request_id` text,
	`request_json` text,
	`previous_snapshot_id` text,
	`disposition` text NOT NULL,
	`round_id` text,
	`gate_node_run_id` text,
	`snapshot_id` text,
	`completion_operation_id` text,
	`delivery_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `task_clarify_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_clarify_entry_request` ON `task_clarify_entries` (`channel_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_clarify_entry_round` ON `task_clarify_entries` (`round_id`);--> statement-breakpoint
CREATE INDEX `idx_task_clarify_entry_source` ON `task_clarify_entries` (`source_asking_run_id`);--> statement-breakpoint
CREATE TABLE `task_clarify_host_runs` (
	`node_run_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`occurrence_ref` text NOT NULL,
	`slot_key` text NOT NULL,
	`inherited_from_run_id` text,
	`shard_instance_ref` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_clarify_host_occurrence` ON `task_clarify_host_runs` (`task_id`,`occurrence_ref`);--> statement-breakpoint
CREATE INDEX `idx_task_clarify_host_slot` ON `task_clarify_host_runs` (`task_id`,`slot_key`);--> statement-breakpoint
CREATE TABLE `task_clarify_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`entry_scope_ref` text NOT NULL,
	`consumer_node_id` text NOT NULL,
	`material_revision` integer NOT NULL,
	`plan_id` text NOT NULL,
	`source_context_digest` text NOT NULL,
	`snapshot_set_digest` text NOT NULL,
	`material_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_scope_ref`) REFERENCES `task_clarify_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_clarify_material_version` ON `task_clarify_materials` (`entry_scope_ref`,`consumer_node_id`,`material_revision`);--> statement-breakpoint
CREATE INDEX `idx_task_clarify_material_consumer` ON `task_clarify_materials` (`task_id`,`consumer_node_id`);