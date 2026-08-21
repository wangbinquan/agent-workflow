CREATE TABLE `event_response_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`event_type_id` text NOT NULL,
	`event_type_revision` integer NOT NULL,
	`subject_type` text NOT NULL,
	`subject_match` text DEFAULT 'all' NOT NULL,
	`subject_pattern` text,
	`target_json` text NOT NULL,
	`last_fired_at` integer,
	`last_status` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_event_response_rules_event` ON `event_response_rules` (`enabled`,`source_id`,`source_revision`,`event_type_id`,`event_type_revision`);
--> statement-breakpoint
CREATE INDEX `idx_event_response_rules_owner` ON `event_response_rules` (`owner_user_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_event_records_audit` ON `event_records` (`observed_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_event_records_source_audit` ON `event_records` (`source_id`,`observed_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_event_subscriptions_audit` ON `event_subscriptions` (`mode`,`updated_at`,`id`);
