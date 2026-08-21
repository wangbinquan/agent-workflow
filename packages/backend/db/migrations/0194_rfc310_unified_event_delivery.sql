-- RFC-310 T173-T176: Event Center is the one durable publish/subscribe/delivery
-- mechanism. Exact Attention subscriptions and filtered automation rules share
-- one transport contract; priority belongs to each subscriber's business queue.

ALTER TABLE `event_subscriptions` ADD `mode` text NOT NULL DEFAULT 'exact';
--> statement-breakpoint
ALTER TABLE `event_subscriptions` ADD `origin_kind` text;
--> statement-breakpoint
ALTER TABLE `event_subscriptions` ADD `origin_ref` text;
--> statement-breakpoint
ALTER TABLE `event_subscriptions` ADD `definition_revision` text;
--> statement-breakpoint
ALTER TABLE `event_subscriptions` ADD `display_name_json` text;
--> statement-breakpoint
ALTER TABLE `event_subscriptions` ADD `selector_kind` text;
--> statement-breakpoint
ALTER TABLE `event_subscriptions` ADD `selector_json` text;
--> statement-breakpoint
CREATE INDEX `idx_event_subscriptions_mode` ON `event_subscriptions` (`mode`,`state`,`updated_at`);
--> statement-breakpoint

-- SQLite cannot drop the historical priority column in place. Rebuild the
-- transport table and add a real delivery lease/retry/dead-letter lifecycle.
CREATE TABLE `__new_event_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL REFERENCES `event_records`(`id`),
	`subscription_id` text NOT NULL REFERENCES `event_subscriptions`(`id`),
	`subscriber_kind` text NOT NULL,
	`subscriber_ref` text NOT NULL,
	`delivery_class` text NOT NULL,
	`state` text NOT NULL DEFAULT 'pending',
	`attempt_count` integer NOT NULL DEFAULT 0,
	`next_attempt_at` integer NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	`dead_letter_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_event_deliveries` (
	`id`,`event_id`,`subscription_id`,`subscriber_kind`,`subscriber_ref`,
	`delivery_class`,`state`,`attempt_count`,`next_attempt_at`,`created_at`,`accepted_at`
)
SELECT
	`id`,`event_id`,`subscription_id`,`subscriber_kind`,`subscriber_ref`,
	`delivery_class`,`state`,`attempt_count`,`created_at`,`created_at`,`accepted_at`
FROM `event_deliveries`;
--> statement-breakpoint
DROP TABLE `event_deliveries`;
--> statement-breakpoint
ALTER TABLE `__new_event_deliveries` RENAME TO `event_deliveries`;
--> statement-breakpoint
CREATE UNIQUE INDEX `event_deliveries_event_subscription_unique` ON `event_deliveries` (`event_id`,`subscription_id`);
--> statement-breakpoint
CREATE INDEX `idx_event_deliveries_pending` ON `event_deliveries` (`subscriber_kind`,`subscriber_ref`,`state`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_event_deliveries_due` ON `event_deliveries` (`subscriber_kind`,`state`,`next_attempt_at`,`claim_expires_at`);
