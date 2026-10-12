DROP TABLE `task_clarify_consumptions`;
--> statement-breakpoint
DROP TABLE `task_clarify_materials`;
--> statement-breakpoint
DROP TABLE `task_clarify_entries`;
--> statement-breakpoint
DROP TABLE `task_clarify_channels`;
--> statement-breakpoint
DROP TABLE `task_clarify_host_runs`;
--> statement-breakpoint
DROP TABLE `clarify_mindmap_node_revisions`;
--> statement-breakpoint
DROP TABLE `clarify_mindmap_command_receipts`;
--> statement-breakpoint
DROP TABLE `clarify_mindmap_nodes`;
--> statement-breakpoint
DROP TABLE `clarify_mindmap_snapshots`;
--> statement-breakpoint
DROP TABLE `clarify_mindmap_sessions`;
--> statement-breakpoint
CREATE TABLE `observation_projection_bindings` (
	`kind` text NOT NULL,
	`identity` text NOT NULL,
	`contribution_key` text NOT NULL,
	`component` text NOT NULL,
	PRIMARY KEY(`kind`, `identity`, `contribution_key`)
);

--> statement-breakpoint
CREATE INDEX `observation_projection_binding_component` ON `observation_projection_bindings` (`component`);
--> statement-breakpoint
CREATE INDEX `observation_projection_binding_contribution` ON `observation_projection_bindings` (`contribution_key`);
--> statement-breakpoint
CREATE TABLE `observation_projection_bootstrap` (
	`generation` text NOT NULL,
	`channel` text NOT NULL,
	`cursor` text,
	`done` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`generation`, `channel`)
);

--> statement-breakpoint
CREATE TABLE `observation_projection_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`entity_key` text NOT NULL,
	`operation` text NOT NULL,
	`previous_route` text,
	`next_route` text,
	`created_at` integer NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE INDEX `observation_projection_changes_pending` ON `observation_projection_changes` (`completed`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `observation_projection_components` (
	`component` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL
);

--> statement-breakpoint
CREATE TABLE `observation_projection_current` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`component` text,
	`revision` text NOT NULL,
	`document` text NOT NULL,
	`section` text,
	`original_key` text,
	`parent` text,
	`task_id` text,
	`cohort_at` integer,
	PRIMARY KEY(`kind`, `key`)
);

--> statement-breakpoint
CREATE INDEX `observation_projection_current_component` ON `observation_projection_current` (`kind`,`component`,`key`);
--> statement-breakpoint
CREATE TABLE `observation_projection_dependencies` (
	`source` text NOT NULL,
	`entity_key` text NOT NULL,
	`component` text NOT NULL,
	PRIMARY KEY(`source`, `entity_key`, `component`)
);

--> statement-breakpoint
CREATE INDEX `observation_projection_dependencies_component` ON `observation_projection_dependencies` (`component`);
--> statement-breakpoint
CREATE TABLE `observation_projection_heads` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`as_of` integer NOT NULL
);

--> statement-breakpoint
CREATE TABLE `observation_projection_history` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`component` text,
	`from_revision` text NOT NULL,
	`to_revision` text,
	`document` text NOT NULL,
	`section` text,
	`original_key` text,
	`parent` text,
	`task_id` text,
	`cohort_at` integer,
	PRIMARY KEY(`kind`, `key`, `from_revision`)
);

--> statement-breakpoint
CREATE INDEX `observation_projection_history_component` ON `observation_projection_history` (`kind`,`component`,`key`);
--> statement-breakpoint
CREATE INDEX `observation_projection_history_section` ON `observation_projection_history` (`kind`,`section`,`cohort_at`,`key`);
--> statement-breakpoint
CREATE INDEX `observation_projection_history_task` ON `observation_projection_history` (`kind`,`task_id`,`section`,`parent`,`key`);
--> statement-breakpoint
CREATE INDEX `observation_projection_history_day` ON `observation_projection_history` (`kind`,`section`,`task_id`,`cohort_at`,`key`);
--> statement-breakpoint
CREATE TABLE `observation_projection_memberships` (
	`aggregate` text NOT NULL,
	`key` text NOT NULL,
	`from_revision` text NOT NULL,
	`to_revision` text,
	PRIMARY KEY(`aggregate`, `key`, `from_revision`)
);

--> statement-breakpoint
CREATE INDEX `observation_projection_memberships_key` ON `observation_projection_memberships` (`key`,`from_revision`);
--> statement-breakpoint
CREATE TABLE `observation_projection_prepared` (
	`work_id` text NOT NULL,
	`key` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`work_id`, `key`),
	FOREIGN KEY (`work_id`) REFERENCES `observation_projection_work`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE TABLE `observation_projection_versions` (
	`revision` text PRIMARY KEY NOT NULL,
	`as_of` integer NOT NULL,
	`bootstrap_complete` integer DEFAULT false NOT NULL
);

--> statement-breakpoint
CREATE TABLE `observation_projection_views` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_scope` text NOT NULL,
	`document` text NOT NULL
);

--> statement-breakpoint
CREATE TABLE `observation_projection_work` (
	`id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`fingerprint` text NOT NULL,
	`completed_revision` text,
	`prepared` text,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`failure` text,
	`applied_revision` text,
	`retry_count` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE INDEX `observation_projection_work_pending` ON `observation_projection_work` (`completed_revision`,`retry_at`,`lease_until`,`id`);
--> statement-breakpoint
CREATE TABLE `observation_projection_work_components` (
	`work_id` text NOT NULL,
	`component` text NOT NULL,
	PRIMARY KEY(`work_id`, `component`),
	FOREIGN KEY (`work_id`) REFERENCES `observation_projection_work`(`id`) ON UPDATE no action ON DELETE no action
);

