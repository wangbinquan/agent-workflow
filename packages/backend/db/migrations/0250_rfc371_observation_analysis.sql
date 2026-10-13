CREATE TABLE `observation_anomaly_history` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`task_id` text,
	`observed_at` integer NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observation_anomaly_task_time` ON `observation_anomaly_history` (`task_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE TABLE `observation_anomaly_states` (
	`key` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`document` text NOT NULL,
	`source_revision` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_invocation_price_audit` (
	`operation_id` text NOT NULL,
	`invocation_id` text NOT NULL,
	`document` text NOT NULL,
	`fingerprint` text NOT NULL,
	PRIMARY KEY(`operation_id`, `invocation_id`)
);
--> statement-breakpoint
CREATE TABLE `observation_invocation_price_policies` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_invocation_price_records` (
	`invocation_id` text NOT NULL,
	`source_id` text NOT NULL,
	`record_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`invocation_id`, `source_id`, `record_id`)
);
--> statement-breakpoint
CREATE TABLE `observation_maintenance_members` (
	`operation_id` text NOT NULL,
	`key` text NOT NULL,
	`document` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	PRIMARY KEY(`operation_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `observation_maintenance_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_scope` text NOT NULL,
	`actor_document` text NOT NULL,
	`state` text NOT NULL,
	`source_revision` text NOT NULL,
	`created_at` integer NOT NULL,
	`document` text NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_maintenance_actor_request` ON `observation_maintenance_operations` (`actor_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `observation_projection_descriptors` (
	`key` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_projection_indexed_versions` (
	`revision` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_projection_query_scope_members` (
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`identity` text NOT NULL,
	PRIMARY KEY(`scope`, `kind`, `identity`)
);
--> statement-breakpoint
CREATE TABLE `observation_projection_query_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`ready` integer DEFAULT false NOT NULL
);
