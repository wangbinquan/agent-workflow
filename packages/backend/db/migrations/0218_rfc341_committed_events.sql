CREATE TABLE `committed_event_aggregate_heads` (
	`producer` text NOT NULL,
	`family` text NOT NULL,
	`aggregate_kind` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`last_seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`producer`, `family`, `aggregate_kind`, `aggregate_id`),
	CONSTRAINT `committed_event_aggregate_heads_last_seq_positive` CHECK(`last_seq` > 0)
);
--> statement-breakpoint
CREATE TABLE `committed_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_group_id` text NOT NULL,
	`event_group_ordinal` integer NOT NULL,
	`producer` text NOT NULL,
	`family` text NOT NULL,
	`event_type` text NOT NULL,
	`schema_version` integer NOT NULL,
	`aggregate_kind` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`aggregate_seq` integer NOT NULL,
	`operation_ref` text NOT NULL,
	`correlation_ref` text,
	`causation_ref` text,
	`occurred_at` integer NOT NULL,
	`payload_json` text NOT NULL,
	`payload_digest` text NOT NULL,
	`delivery_mode` text NOT NULL,
	`producer_epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `committed_events_schema_v1` CHECK(`schema_version` = 1),
	CONSTRAINT `committed_events_group_ordinal_nonnegative` CHECK(`event_group_ordinal` >= 0),
	CONSTRAINT `committed_events_aggregate_seq_positive` CHECK(`aggregate_seq` > 0),
	CONSTRAINT `committed_events_producer_epoch_positive` CHECK(`producer_epoch` > 0),
	CONSTRAINT `committed_events_payload_json_valid` CHECK(json_valid(`payload_json`)),
	CONSTRAINT `committed_events_payload_digest_shape` CHECK(length(`payload_digest`) = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `committed_events_aggregate_seq_unique` ON `committed_events` (`producer`,`family`,`aggregate_kind`,`aggregate_id`,`aggregate_seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `committed_events_group_ordinal_unique` ON `committed_events` (`event_group_id`,`event_group_ordinal`);
--> statement-breakpoint
CREATE INDEX `idx_committed_events_operation` ON `committed_events` (`producer`,`family`,`operation_ref`);
--> statement-breakpoint
CREATE INDEX `idx_committed_events_aggregate` ON `committed_events` (`producer`,`family`,`aggregate_kind`,`aggregate_id`,`aggregate_seq`);
--> statement-breakpoint
CREATE TABLE `committed_event_deliveries` (
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
CREATE INDEX `idx_committed_event_deliveries_due` ON `committed_event_deliveries` (`state`,`next_attempt_at`,`claim_expires_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_committed_event_deliveries_consumer_state` ON `committed_event_deliveries` (`consumer_id`,`state`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `committed_event_family_cutovers` (
	`producer` text NOT NULL,
	`family` text NOT NULL,
	`mode` text NOT NULL,
	`epoch` integer NOT NULL,
	`changed_at` integer NOT NULL,
	`change_ref` text NOT NULL,
	PRIMARY KEY(`producer`, `family`),
	CONSTRAINT `committed_event_family_cutovers_epoch_positive` CHECK(`epoch` > 0)
);
--> statement-breakpoint
INSERT INTO `committed_event_family_cutovers` (`producer`, `family`, `mode`, `epoch`, `changed_at`, `change_ref`) VALUES
	('task-execution', 'task-lifecycle', 'legacy', 1, 1789488012066, 'rfc341:foundation'),
	('collaboration', 'review', 'legacy', 1, 1789488012066, 'rfc341:foundation'),
	('collaboration', 'clarify', 'legacy', 1, 1789488012066, 'rfc341:foundation'),
	('collaboration', 'questions', 'legacy', 1, 1789488012066, 'rfc341:foundation');
