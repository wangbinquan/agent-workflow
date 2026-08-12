-- RFC-293 — persistent working-context handoff and continuous draft iteration.
-- Additive only: existing Intent turns/drafts/commits keep their wire and data.
ALTER TABLE `intent_turns` ADD `client_mutation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_turns_session_mutation`
  ON `intent_turns` (`session_id`,`client_mutation_id`)
  WHERE `client_mutation_id` IS NOT NULL;--> statement-breakpoint

CREATE TABLE `intent_draft_resolutions` (
	`draft_id` text PRIMARY KEY NOT NULL REFERENCES `intent_drafts`(`id`) ON DELETE cascade,
	`session_id` text NOT NULL REFERENCES `intent_sessions`(`id`) ON DELETE cascade,
	`reason` text NOT NULL CHECK (`reason` IN ('superseded','discarded')),
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_intent_draft_resolutions_session`
  ON `intent_draft_resolutions` (`session_id`,`created_at`);--> statement-breakpoint

CREATE TABLE `intent_working_set_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL REFERENCES `intent_sessions`(`id`) ON DELETE cascade,
	`client_mutation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`expected_turn_seq` integer NOT NULL,
	`expected_context_revision` integer NOT NULL,
	`mode` text NOT NULL CHECK (`mode` IN ('after-current','interrupt')),
	`delta_json` text NOT NULL,
	`state` text NOT NULL CHECK (`state` IN ('queued','applying','applied','failed','canceled')),
	`error` text,
	`resulting_context_revision` integer,
	`resulting_turn_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_working_set_mutation`
  ON `intent_working_set_changes` (`session_id`,`client_mutation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_working_set_unresolved`
  ON `intent_working_set_changes` (`session_id`)
  WHERE `state` IN ('queued','applying','failed');--> statement-breakpoint
CREATE INDEX `idx_intent_working_set_session`
  ON `intent_working_set_changes` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_intent_working_set_state`
  ON `intent_working_set_changes` (`state`,`updated_at`);
