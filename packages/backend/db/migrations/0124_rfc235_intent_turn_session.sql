-- RFC-235 — persist each Intent agent turn's normalized runtime conversation
-- independently from task node_run_events, then project it through the shared
-- SessionTree parser/renderer.
ALTER TABLE `intent_turns` ADD `capture_state` text;--> statement-breakpoint
ALTER TABLE `intent_turns` ADD `capture_last_event_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `intent_turns` ADD `capture_event_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `intent_turns` ADD `capture_root_session_id` text;--> statement-breakpoint
ALTER TABLE `intent_turns` ADD `capture_incomplete_reason` text;--> statement-breakpoint
CREATE TABLE `intent_turn_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` text NOT NULL,
	`event_seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`session_id` text,
	`parent_session_id` text,
	`source` text NOT NULL,
	`external_event_id` text,
	FOREIGN KEY (`turn_id`) REFERENCES `intent_turns`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_turn_events_turn_seq` ON `intent_turn_events` (`turn_id`,`event_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_turn_events_external` ON `intent_turn_events` (`turn_id`,`source`,`external_event_id`) WHERE `external_event_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_intent_turn_events_turn` ON `intent_turn_events` (`turn_id`,`event_seq`);
