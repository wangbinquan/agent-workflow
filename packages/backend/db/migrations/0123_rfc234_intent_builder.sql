-- RFC-234 — intent-builder storage: sessions, turns, immutable draft
-- revisions, the bundle apply journal (idempotent clientMutationId claim +
-- crash convergence), and resource-side provenance. See
-- design/RFC-234-intent-driven-builder/design.md §2.
CREATE TABLE `intent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`context_revision` integer DEFAULT 0 NOT NULL,
	`context_manifest_json` text DEFAULT '[]' NOT NULL,
	`current_draft_id` text,
	`in_flight_turn_id` text,
	`turn_seq` integer DEFAULT 0 NOT NULL,
	`commit_seq` integer DEFAULT 0 NOT NULL,
	`budget_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_intent_sessions_owner` ON `intent_sessions` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_intent_sessions_owner_status` ON `intent_sessions` (`owner_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `intent_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`content_json` text DEFAULT '{}' NOT NULL,
	`context_revision` integer DEFAULT 0 NOT NULL,
	`envelope_nonce` text,
	`run_meta_json` text,
	`scratch_retained` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `intent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_turns_session_seq` ON `intent_turns` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_intent_turns_session` ON `intent_turns` (`session_id`);--> statement-breakpoint
CREATE TABLE `intent_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`changeset_json` text NOT NULL,
	`validation_json` text DEFAULT '[]' NOT NULL,
	`draft_hash` text NOT NULL,
	`produced_by_turn_id` text,
	`context_revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `intent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_drafts_session_revision` ON `intent_drafts` (`session_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_intent_drafts_session` ON `intent_drafts` (`session_id`);--> statement-breakpoint
CREATE TABLE `intent_apply_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`client_mutation_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`draft_hash` text NOT NULL,
	`state` text DEFAULT 'prepared' NOT NULL,
	`prepared_artifacts_json` text DEFAULT '[]' NOT NULL,
	`receipt_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `intent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_apply_journal_mutation` ON `intent_apply_journal` (`session_id`,`client_mutation_id`);--> statement-breakpoint
CREATE INDEX `idx_intent_apply_journal_session` ON `intent_apply_journal` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_intent_apply_journal_state` ON `intent_apply_journal` (`state`);--> statement-breakpoint
CREATE TABLE `intent_provenance` (
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`commit_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`resource_type`, `resource_id`, `commit_id`)
);--> statement-breakpoint
CREATE INDEX `idx_intent_provenance_resource` ON `intent_provenance` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_intent_provenance_session` ON `intent_provenance` (`session_id`);
