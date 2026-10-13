CREATE TABLE `observation_report_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`request_key` text,
	`revision` text,
	`expires_at` integer NOT NULL,
	`retiring` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_report_lease_request` ON `observation_report_leases` (`request_key`);--> statement-breakpoint
CREATE INDEX `observation_report_lease_expiry` ON `observation_report_leases` (`retiring`,`expires_at`);--> statement-breakpoint
CREATE TABLE `observation_scope_refs` (
	`view_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`view_id`, `scope`)
);
--> statement-breakpoint
CREATE INDEX `observation_scope_reference` ON `observation_scope_refs` (`scope`);--> statement-breakpoint
CREATE TABLE `observation_storage_samples` (
	`day` text PRIMARY KEY NOT NULL,
	`sampled_at` integer NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_storage_state` (
	`key` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_work_retention` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` text,
	`queued_at` integer DEFAULT 0 NOT NULL
);
