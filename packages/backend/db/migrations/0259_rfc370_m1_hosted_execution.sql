CREATE TABLE `hosted_execution_bindings` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_run_id` text,
	`kind` text NOT NULL,
	`business_task_id` text NOT NULL,
	`request_key` text NOT NULL,
	`request_json` text NOT NULL,
	`subtask_id` text,
	`attempt` integer,
	`material_digest` text,
	`last_cursor` text,
	`result_json` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`state` text NOT NULL,
	`epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_execution_bindings_kind_known" CHECK("hosted_execution_bindings"."kind" IN ('agent', 'command')),
	CONSTRAINT "hosted_execution_bindings_state_known" CHECK("hosted_execution_bindings"."state" IN ('submitting', 'running', 'settled'))
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_execution_bindings_state` ON `hosted_execution_bindings` (`state`);--> statement-breakpoint
CREATE INDEX `idx_hosted_execution_bindings_task` ON `hosted_execution_bindings` (`task_id`);--> statement-breakpoint
CREATE TABLE `hosted_execution_control` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL,
	`owner` text,
	`phase` text NOT NULL,
	`lease_id` text,
	`expires_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_execution_control_id_fixed" CHECK("hosted_execution_control"."id" = 'global'),
	CONSTRAINT "hosted_execution_control_phase_known" CHECK("hosted_execution_control"."phase" IN ('frozen', 'preparing', 'active'))
);
--> statement-breakpoint
CREATE TABLE `hosted_execution_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` text NOT NULL,
	`cursor` text NOT NULL,
	`event_json` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `hosted_execution_bindings`(`execution_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hosted_execution_event_cursor` ON `hosted_execution_events` (`execution_id`,`cursor`);--> statement-breakpoint
CREATE INDEX `idx_hosted_execution_event_replay` ON `hosted_execution_events` (`execution_id`,`id`);--> statement-breakpoint
CREATE TABLE `hosted_task_artifacts` (
	`reference` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`object_id` text NOT NULL,
	`revision` integer NOT NULL,
	`digest` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hosted_task_workspaces` (
	`task_id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`business_task_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_task_workspaces_state_known" CHECK("hosted_task_workspaces"."state" IN ('creating', 'ready', 'closing', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_task_workspaces_business_task_unique` ON `hosted_task_workspaces` (`business_task_id`);--> statement-breakpoint
CREATE TABLE `node_execution_event_sources` (
	`source_key` text PRIMARY KEY NOT NULL,
	`node_run_id` text NOT NULL,
	FOREIGN KEY (`node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
