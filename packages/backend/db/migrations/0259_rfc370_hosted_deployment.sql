CREATE TABLE `cs_event_inbox` (
	`installation_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`logical_id` text NOT NULL,
	`event_id` text NOT NULL,
	`producer_id` text NOT NULL,
	`event_type_id` text NOT NULL,
	`payload_digest` text NOT NULL,
	`payload_json` text NOT NULL,
	`received_at` integer NOT NULL,
	`last_attempt` integer NOT NULL,
	`conflicts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`installation_id`, `delivery_id`)
);
--> statement-breakpoint
CREATE TABLE `cs_event_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`producer_id` text NOT NULL,
	`event_id` text NOT NULL,
	`payload_digest` text NOT NULL,
	`envelope_json` text NOT NULL,
	`source_json` text NOT NULL,
	`source_revision` integer NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	`conflicts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cs_event_routes_identity` ON `cs_event_routes` (`installation_id`,`producer_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `cs_event_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`logical_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`binding_revision` integer NOT NULL,
	`mode` text NOT NULL,
	`stage` text NOT NULL,
	`delivery_id` text,
	`effect_id` text,
	`observations_json` text,
	`published_json` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cs_event_targets_identity` ON `cs_event_targets` (`logical_id`,`endpoint_id`);--> statement-breakpoint
CREATE INDEX `idx_cs_event_targets_pending` ON `cs_event_targets` (`stage`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `cs_webhook_verifications` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`transport_receipt_ref` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `development_object_artifacts` (
	`reference` text PRIMARY KEY NOT NULL,
	`object_id` text NOT NULL,
	`digest` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hosted_database_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL,
	`kind` text DEFAULT 'manual' NOT NULL,
	`state` text NOT NULL,
	`active_slot` text,
	`object_id` text,
	`sha256` text,
	`size_bytes` integer,
	`schema_digest` text,
	`source_generation_id` text,
	`contents_json` text,
	`snapshot_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_database_backups_kind_known" CHECK("hosted_database_backups"."kind" IN ('manual','scheduled')),
	CONSTRAINT "hosted_database_backups_state_known" CHECK("hosted_database_backups"."state" IN ('building','ready','failed','released')),
	CONSTRAINT "hosted_database_backups_slot_shape" CHECK(("hosted_database_backups"."state" = 'building' AND "hosted_database_backups"."active_slot" IS NOT NULL AND "hosted_database_backups"."active_slot" = 'global') OR ("hosted_database_backups"."state" != 'building' AND "hosted_database_backups"."active_slot" IS NULL)),
	CONSTRAINT "hosted_database_backups_ready_shape" CHECK("hosted_database_backups"."state" != 'ready' OR ("hosted_database_backups"."object_id" IS NOT NULL AND "hosted_database_backups"."sha256" IS NOT NULL AND "hosted_database_backups"."size_bytes" IS NOT NULL AND "hosted_database_backups"."schema_digest" IS NOT NULL AND "hosted_database_backups"."source_generation_id" IS NOT NULL AND "hosted_database_backups"."contents_json" IS NOT NULL AND "hosted_database_backups"."snapshot_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_database_backups_active_slot_unique` ON `hosted_database_backups` (`active_slot`);--> statement-breakpoint
CREATE INDEX `hosted_database_backups_state_idx` ON `hosted_database_backups` (`state`,`created_at`);--> statement-breakpoint
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
	`migration_operation_id` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_execution_control_id_fixed" CHECK("hosted_execution_control"."id" = 'global'),
	CONSTRAINT "hosted_execution_control_phase_known" CHECK("hosted_execution_control"."phase" IN ('frozen', 'preparing', 'active')),
	CONSTRAINT "hosted_execution_control_window_frozen" CHECK("hosted_execution_control"."migration_operation_id" IS NULL OR "hosted_execution_control"."phase" = 'frozen')
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
CREATE TABLE `hosted_node_event_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`first_id` integer NOT NULL,
	`last_id` integer NOT NULL,
	`row_count` integer NOT NULL,
	`digest` text NOT NULL,
	`size` integer NOT NULL,
	`state` text NOT NULL,
	`object_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "hosted_node_event_archives_state_known" CHECK("hosted_node_event_archives"."state" IN ('prepared', 'ready')),
	CONSTRAINT "hosted_node_event_archives_object_known" CHECK(("hosted_node_event_archives"."state" = 'prepared' AND "hosted_node_event_archives"."object_id" IS NULL) OR ("hosted_node_event_archives"."state" = 'ready' AND "hosted_node_event_archives"."object_id" IS NOT NULL)),
	CONSTRAINT "hosted_node_event_archives_range" CHECK("hosted_node_event_archives"."first_id" > 0 AND "hosted_node_event_archives"."last_id" >= "hosted_node_event_archives"."first_id" AND "hosted_node_event_archives"."row_count" > 0)
);
--> statement-breakpoint
CREATE INDEX `hosted_node_event_archives_run` ON `hosted_node_event_archives` (`task_id`,`node_run_id`,`last_id`);--> statement-breakpoint
CREATE INDEX `hosted_node_event_archives_pending` ON `hosted_node_event_archives` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `hosted_object_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`logical_key` text NOT NULL,
	`scope` text,
	`attempt` text NOT NULL,
	`state` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`object_id` text,
	`epoch` integer NOT NULL,
	`source_sealed` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`released_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_object_publications_state_known" CHECK("hosted_object_publications"."state" IN ('pending', 'ready', 'releasing', 'released')),
	CONSTRAINT "hosted_object_publications_shape_known" CHECK(("hosted_object_publications"."state" = 'pending' AND "hosted_object_publications"."released_at" IS NULL) OR ("hosted_object_publications"."state" = 'ready' AND "hosted_object_publications"."object_id" IS NOT NULL AND "hosted_object_publications"."released_at" IS NULL AND "hosted_object_publications"."source_sealed" IS NULL) OR ("hosted_object_publications"."state" IN ('releasing', 'released') AND "hosted_object_publications"."released_at" IS NOT NULL AND "hosted_object_publications"."source_sealed" IS NULL)),
	CONSTRAINT "hosted_object_publications_size_valid" CHECK("hosted_object_publications"."size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_object_publications_identity` ON `hosted_object_publications` (`owner`,`logical_key`);--> statement-breakpoint
CREATE INDEX `hosted_object_publications_work_idx` ON `hosted_object_publications` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `hosted_object_publications_scope_idx` ON `hosted_object_publications` (`owner`,`scope`,`state`);--> statement-breakpoint
CREATE TABLE `hosted_recovery_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`request_json` text NOT NULL,
	`business_task_id` text NOT NULL,
	`task_id` text,
	`actor_user_id` text,
	`state` text NOT NULL,
	`receipt_json` text,
	`reason` text,
	`epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_recovery_requests_state_known" CHECK("hosted_recovery_requests"."state" IN ('admitted', 'executing', 'succeeded', 'failed', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `hosted_recovery_requests_state` ON `hosted_recovery_requests` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `hosted_recovery_requests_task` ON `hosted_recovery_requests` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `hosted_task_archive_entries` (
	`path` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`parts_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_task_archive_entries_kind_known" CHECK("hosted_task_archive_entries"."kind" IN ('directory', 'file'))
);
--> statement-breakpoint
CREATE TABLE `hosted_task_artifacts` (
	`reference` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`object_id` text NOT NULL,
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
CREATE TABLE `hosted_workspace_commands` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`business_task_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_key` text NOT NULL,
	`request_json` text NOT NULL,
	`subtask_id` text,
	`attempt` integer,
	`last_cursor` text,
	`outcome_json` text,
	`state` text NOT NULL,
	`epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hosted_workspace_commands_state_known" CHECK("hosted_workspace_commands"."state" IN ('submitting', 'running', 'settled', 'abandoned'))
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_workspace_commands_state` ON `hosted_workspace_commands` (`state`);--> statement-breakpoint
CREATE INDEX `idx_hosted_workspace_commands_business_task` ON `hosted_workspace_commands` (`business_task_id`,`state`);--> statement-breakpoint
CREATE TABLE `node_execution_event_sources` (
	`source_key` text PRIMARY KEY NOT NULL,
	`node_run_id` text NOT NULL,
	FOREIGN KEY (`node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugin_artifact_generations` (
	`reference` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`spec` text NOT NULL,
	`state` text NOT NULL,
	`epoch` integer NOT NULL,
	`installed_json` text,
	`object_id` text,
	`digest` text,
	`size` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "plugin_artifact_generations_state_known" CHECK("plugin_artifact_generations"."state" IN ('installing', 'ready', 'releasing', 'retired')),
	CONSTRAINT "plugin_artifact_generations_ready_shape" CHECK("plugin_artifact_generations"."state" != 'ready' OR ("plugin_artifact_generations"."object_id" IS NOT NULL AND "plugin_artifact_generations"."digest" IS NOT NULL AND "plugin_artifact_generations"."size" IS NOT NULL))
);
