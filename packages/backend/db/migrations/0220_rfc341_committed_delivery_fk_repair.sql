-- RFC-341 follow-up: normalize the delivery foreign key after the task-family
-- cutover.  Bun SQLite connections can enter an upgrade with
-- legacy_alter_table=ON; in that mode migration 0219's parent-table rename
-- leaves the delivery FK pointing at its temporary table name.  Rebuild only
-- the child table with an explicit canonical parent so fresh installs and
-- upgrades converge on byte-equivalent physical schema.
PRAGMA legacy_alter_table=OFF;
--> statement-breakpoint
CREATE TABLE `__rfc341_committed_event_deliveries_fk` (
	`event_id` text NOT NULL,
	`consumer_id` text NOT NULL,
	`delivery_class` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claimed_by` text,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`claim_expires_at` integer,
	`last_error_code` text,
	`last_error_summary` text,
	`replay_generation` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`accepted_at` integer,
	`dead_letter_at` integer,
	PRIMARY KEY(`event_id`, `consumer_id`),
	FOREIGN KEY (`event_id`) REFERENCES `committed_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `committed_event_deliveries_attempt_nonnegative` CHECK(`attempt_count` >= 0),
	CONSTRAINT `committed_event_deliveries_lease_epoch_nonnegative` CHECK(`lease_epoch` >= 0),
	CONSTRAINT `committed_event_deliveries_replay_generation_nonnegative` CHECK(`replay_generation` >= 0)
);
--> statement-breakpoint
INSERT INTO `__rfc341_committed_event_deliveries_fk`
SELECT * FROM `committed_event_deliveries`;
--> statement-breakpoint
DROP TABLE `committed_event_deliveries`;
--> statement-breakpoint
ALTER TABLE `__rfc341_committed_event_deliveries_fk` RENAME TO `committed_event_deliveries`;
--> statement-breakpoint
CREATE INDEX `idx_committed_event_deliveries_due` ON `committed_event_deliveries` (`state`,`next_attempt_at`,`claim_expires_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_committed_event_deliveries_consumer_state` ON `committed_event_deliveries` (`consumer_id`,`state`,`updated_at`);
