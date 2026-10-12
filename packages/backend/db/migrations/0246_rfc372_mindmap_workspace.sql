CREATE TABLE `clarify_mindmap_command_receipts` (
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`command_json` text NOT NULL,
	`result_json` text NOT NULL,
	`metadata_json` text NOT NULL,
	`session_revision` integer NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `request_id`),
	FOREIGN KEY (`session_id`) REFERENCES `clarify_mindmap_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mindmap_receipts_history` ON `clarify_mindmap_command_receipts` (`session_id`,`session_revision`);--> statement-breakpoint
CREATE TABLE `clarify_mindmap_node_revisions` (
	`node_id` text NOT NULL,
	`session_revision` integer NOT NULL,
	`body_json` text NOT NULL,
	`actor_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `session_revision`),
	FOREIGN KEY (`node_id`) REFERENCES `clarify_mindmap_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `clarify_mindmap_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`parent_id` text,
	`sort_order` integer NOT NULL,
	`body_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `clarify_mindmap_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mindmap_nodes_parent` ON `clarify_mindmap_nodes` (`session_id`,`parent_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `clarify_mindmap_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`round_id` text NOT NULL,
	`entry_ref` text NOT NULL,
	`revision` integer NOT NULL,
	`metadata_json` text NOT NULL,
	`source_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`round_id`) REFERENCES `clarify_rounds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mindmap_sessions_round` ON `clarify_mindmap_sessions` (`round_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mindmap_sessions_entry` ON `clarify_mindmap_sessions` (`task_id`,`entry_ref`);--> statement-breakpoint
CREATE TABLE `clarify_mindmap_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`digest` text NOT NULL,
	`content_json` text NOT NULL,
	`markdown` text NOT NULL,
	`plan_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`finalized_at` integer,
	`finalized_by` text,
	FOREIGN KEY (`session_id`) REFERENCES `clarify_mindmap_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mindmap_snapshots_session` ON `clarify_mindmap_snapshots` (`session_id`,`revision`);