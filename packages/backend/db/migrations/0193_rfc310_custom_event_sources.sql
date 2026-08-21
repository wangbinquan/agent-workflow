-- RFC-310: global custom Event Source authoring. The executable draft keeps a
-- stable source id while every publish freezes an immutable exact revision.

CREATE TABLE `custom_event_source_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_json` text NOT NULL,
	`published_revision` integer,
	`owner_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_custom_event_sources_state` ON `custom_event_source_definitions` (`retired_at`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `custom_event_source_revisions` (
	`source_id` text NOT NULL REFERENCES `custom_event_source_definitions`(`id`),
	`revision` integer NOT NULL,
	`content_json` text NOT NULL,
	`content_digest` text NOT NULL,
	`validation_receipt_json` text NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text,
	PRIMARY KEY(`source_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `idx_custom_event_source_revisions` ON `custom_event_source_revisions` (`source_id`,`revision`);
