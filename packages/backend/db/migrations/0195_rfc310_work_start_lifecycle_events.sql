-- RFC-310 T177-T180: event-started orchestration and Digital Employee work
-- share source-neutral delivery provenance. Task and EmployeeCase lifecycle
-- facts are published from owner-transaction outboxes into the Event Center.

ALTER TABLE `tasks` ADD `lifecycle_event_revision` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `webhook_trigger_fires` ADD `employee_case_id` text;
--> statement-breakpoint

CREATE TABLE `employee_case_event_origins` (
	`case_id` text PRIMARY KEY NOT NULL REFERENCES `employee_cases`(`id`),
	`event_subscription_id` text NOT NULL,
	`event_delivery_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_case_event_origins_delivery_unique` ON `employee_case_event_origins` (`event_delivery_id`);
--> statement-breakpoint
CREATE INDEX `idx_employee_case_event_origins_subscription` ON `employee_case_event_origins` (`event_subscription_id`,`created_at`);
--> statement-breakpoint

CREATE TABLE `task_lifecycle_event_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `tasks`(`id`),
	`task_revision` integer NOT NULL,
	`observation_json` text NOT NULL,
	`state` text NOT NULL DEFAULT 'pending',
	`attempt_count` integer NOT NULL DEFAULT 0,
	`next_attempt_at` integer NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`dead_letter_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_lifecycle_event_outbox_task_revision_unique` ON `task_lifecycle_event_outbox` (`task_id`,`task_revision`);
--> statement-breakpoint
CREATE INDEX `idx_task_lifecycle_event_outbox_due` ON `task_lifecycle_event_outbox` (`state`,`next_attempt_at`,`claim_expires_at`);
