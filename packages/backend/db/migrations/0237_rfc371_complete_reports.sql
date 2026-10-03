CREATE TABLE `observation_report_counts` (
	`report_id` text NOT NULL,
	`section` text NOT NULL,
	`parent` text NOT NULL,
	`total` text DEFAULT '0' NOT NULL,
	`actual` text DEFAULT '0' NOT NULL,
	`declared` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`report_id`, `section`, `parent`),
	FOREIGN KEY (`report_id`) REFERENCES `observation_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `observation_report_pages` (
	`report_id` text NOT NULL,
	`ordinal` text NOT NULL,
	`previous_digest` text NOT NULL,
	`digest` text NOT NULL,
	`items_count` integer NOT NULL,
	PRIMARY KEY(`report_id`, `ordinal`),
	FOREIGN KEY (`report_id`) REFERENCES `observation_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "observation_report_page_size_ck" CHECK("observation_report_pages"."items_count" BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE `observation_report_receipts` (
	`report_id` text NOT NULL,
	`key` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`report_id`, `key`),
	FOREIGN KEY (`report_id`) REFERENCES `observation_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `observation_report_rows` (
	`report_id` text NOT NULL,
	`ordinal` text NOT NULL,
	`section` text NOT NULL,
	`parent` text NOT NULL,
	`key` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`report_id`, `ordinal`),
	FOREIGN KEY (`report_id`) REFERENCES `observation_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_report_row_identity_idx` ON `observation_report_rows` (`report_id`,`section`,`parent`,`key`);--> statement-breakpoint
CREATE INDEX `observation_report_row_page_idx` ON `observation_report_rows` (`report_id`,`section`,`parent`,`ordinal`);--> statement-breakpoint
CREATE TABLE `observation_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`generation` text NOT NULL,
	`owner` text NOT NULL,
	`actor_scope` text NOT NULL,
	`request` text NOT NULL,
	`state` text NOT NULL,
	`report` text NOT NULL,
	`manifest` text,
	`progress` text NOT NULL,
	`lease_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "observation_report_state_ck" CHECK("observation_reports"."state" IN ('building','not-ready','failed','ready'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_report_request_idx` ON `observation_reports` (`request_key`);--> statement-breakpoint
CREATE INDEX `observation_report_recovery_idx` ON `observation_reports` (`state`,`lease_until`);