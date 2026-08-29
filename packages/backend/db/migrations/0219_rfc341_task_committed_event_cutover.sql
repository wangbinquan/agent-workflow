-- RFC-341 task lifecycle cutover.
--
-- Unresolved RFC-310 publication rows keep their stable event id, lifecycle
-- revision, retry count and diagnostic state. Completed rows already have an
-- idempotent Event Center record and need no second delivery receipt.

-- Rebuild the parent and delivery table together so this migration is safe
-- even for direct replays that keep foreign_keys=ON.  Steady-state events keep
-- their compact 64-character digest; migrated legacy rows carry a reversible
-- digest whose CHECK proves it is the exact UTF-8 payload rather than a
-- truncated or connection-specific hash.
CREATE TABLE `__rfc341_committed_events` (
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
	CONSTRAINT `committed_events_payload_digest_shape` CHECK(
		length(`payload_digest`) = 64 OR
		`payload_digest` = 'canonical-hex-v1:' || lower(hex(`payload_json`))
	)
);
--> statement-breakpoint
INSERT INTO `__rfc341_committed_events` SELECT * FROM `committed_events`;
--> statement-breakpoint
CREATE TABLE `__rfc341_committed_event_deliveries` (
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
	FOREIGN KEY (`event_id`) REFERENCES `__rfc341_committed_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `committed_event_deliveries_attempt_nonnegative` CHECK(`attempt_count` >= 0),
	CONSTRAINT `committed_event_deliveries_lease_epoch_nonnegative` CHECK(`lease_epoch` >= 0),
	CONSTRAINT `committed_event_deliveries_replay_generation_nonnegative` CHECK(`replay_generation` >= 0)
);
--> statement-breakpoint
INSERT INTO `__rfc341_committed_event_deliveries` SELECT * FROM `committed_event_deliveries`;
--> statement-breakpoint
DROP TABLE `committed_event_deliveries`;
--> statement-breakpoint
DROP TABLE `committed_events`;
--> statement-breakpoint
ALTER TABLE `__rfc341_committed_events` RENAME TO `committed_events`;
--> statement-breakpoint
ALTER TABLE `__rfc341_committed_event_deliveries` RENAME TO `committed_event_deliveries`;
--> statement-breakpoint
CREATE UNIQUE INDEX `committed_events_aggregate_seq_unique` ON `committed_events` (`producer`,`family`,`aggregate_kind`,`aggregate_id`,`aggregate_seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `committed_events_group_ordinal_unique` ON `committed_events` (`event_group_id`,`event_group_ordinal`);
--> statement-breakpoint
CREATE INDEX `idx_committed_events_operation` ON `committed_events` (`producer`,`family`,`operation_ref`);
--> statement-breakpoint
CREATE INDEX `idx_committed_events_aggregate` ON `committed_events` (`producer`,`family`,`aggregate_kind`,`aggregate_id`,`aggregate_seq`);
--> statement-breakpoint
CREATE INDEX `idx_committed_event_deliveries_due` ON `committed_event_deliveries` (`state`,`next_attempt_at`,`claim_expires_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_committed_event_deliveries_consumer_state` ON `committed_event_deliveries` (`consumer_id`,`state`,`updated_at`);
--> statement-breakpoint

WITH `legacy_task_events` AS (
	SELECT
		o.*,
		CASE
			WHEN o.`task_revision` = 1 AND json_extract(json_extract(o.`observation_json`, '$.routingFactsJson'), '$.previousStatus') IS NULL
				THEN 'task.created.v1'
			ELSE 'task.lifecycle-transitioned.v1'
		END AS `event_type`,
		CASE
			WHEN o.`task_revision` = 1 AND json_extract(json_extract(o.`observation_json`, '$.routingFactsJson'), '$.previousStatus') IS NULL THEN
				json_object(
					'aggregate', json_object('id', o.`task_id`, 'kind', 'task', 'seq', o.`task_revision`),
					'causationRef', NULL,
					'correlationRef', NULL,
					'eventGroupId', 'committed-event-group:task-execution:' || o.`id`,
					'eventGroupOrdinal', 0,
					'eventId', o.`id`,
					'family', 'task-lifecycle',
					'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', o.`created_at` / 1000.0, 'unixepoch'),
					'operationRef', o.`id`,
					'payload', json_object(
						'createdAt', strftime('%Y-%m-%dT%H:%M:%fZ', o.`created_at` / 1000.0, 'unixepoch'),
						'errorSummary', NULL,
						'lifecycleRevision', 1,
						'previousStatus', NULL,
						'status', json_extract(json_extract(o.`observation_json`, '$.routingFactsJson'), '$.status'),
						'taskId', o.`task_id`
					),
					'producer', 'task-execution',
					'schemaVersion', 1,
					'type', 'task.created.v1'
				)
			ELSE
				json_object(
					'aggregate', json_object('id', o.`task_id`, 'kind', 'task', 'seq', o.`task_revision`),
					'causationRef', NULL,
					'correlationRef', NULL,
					'eventGroupId', 'committed-event-group:task-execution:' || o.`id`,
					'eventGroupOrdinal', 0,
					'eventId', o.`id`,
					'family', 'task-lifecycle',
					'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', o.`created_at` / 1000.0, 'unixepoch'),
					'operationRef', o.`id`,
					'payload', json_object(
						'errorSummary', NULL,
						'lifecycleRevision', o.`task_revision`,
						'nodeChanges', json_array(),
						'previousStatus', json_extract(json_extract(o.`observation_json`, '$.routingFactsJson'), '$.previousStatus'),
						'sourceTerminationEffectRef', NULL,
						'status', json_extract(json_extract(o.`observation_json`, '$.routingFactsJson'), '$.status'),
						'taskId', o.`task_id`,
						'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', o.`created_at` / 1000.0, 'unixepoch'),
						'workspacePruneClaim', NULL
					),
					'producer', 'task-execution',
					'schemaVersion', 1,
					'type', 'task.lifecycle-transitioned.v1'
				)
		END AS `canonical_payload_json`
	FROM `task_lifecycle_event_outbox` o
	WHERE o.`state` <> 'completed'
)
INSERT INTO `committed_events` (
	`id`, `event_group_id`, `event_group_ordinal`, `producer`, `family`, `event_type`,
	`schema_version`, `aggregate_kind`, `aggregate_id`, `aggregate_seq`, `operation_ref`,
	`correlation_ref`, `causation_ref`, `occurred_at`, `payload_json`, `payload_digest`,
	`delivery_mode`, `producer_epoch`, `created_at`
)
SELECT
	o.`id`,
	'committed-event-group:task-execution:' || o.`id`,
	0,
	'task-execution',
	'task-lifecycle',
	o.`event_type`,
	1,
	'task',
	o.`task_id`,
	o.`task_revision`,
	o.`id`,
	NULL,
	NULL,
	o.`created_at`,
	o.`canonical_payload_json`,
	-- SQLite core does not expose SHA-256 on every supported host.  Preserve an
	-- exact, collision-free digest for migrated bytes without requiring a
	-- connection-local migration function; steady-state appends remain SHA-256.
	'canonical-hex-v1:' || lower(hex(o.`canonical_payload_json`)),
	'dispatchable',
	2,
	o.`created_at`
FROM `legacy_task_events` o;
--> statement-breakpoint

INSERT INTO `committed_event_aggregate_heads` (
	`producer`, `family`, `aggregate_kind`, `aggregate_id`, `last_seq`, `updated_at`
)
SELECT
	'task-execution', 'task-lifecycle', 'task', e.`aggregate_id`, MAX(e.`aggregate_seq`), MAX(e.`created_at`)
FROM `committed_events` e
WHERE e.`producer` = 'task-execution' AND e.`family` = 'task-lifecycle'
GROUP BY e.`aggregate_id`
ON CONFLICT (`producer`, `family`, `aggregate_kind`, `aggregate_id`) DO UPDATE SET
	`last_seq` = MAX(`last_seq`, excluded.`last_seq`),
	`updated_at` = MAX(`updated_at`, excluded.`updated_at`);
--> statement-breakpoint

-- Completed legacy outbox rows are intentionally not replayed, but their task
-- revisions still seed the aggregate high-water so the first post-cutover
-- event cannot move sequence backwards. Node-only events then advance this
-- independent event sequence without fabricating a task status revision.
INSERT INTO `committed_event_aggregate_heads` (
	`producer`, `family`, `aggregate_kind`, `aggregate_id`, `last_seq`, `updated_at`
)
SELECT
	'task-execution', 'task-lifecycle', 'task', t.`id`, t.`lifecycle_event_revision`,
	COALESCE(t.`finished_at`, t.`started_at`, 1789574412066)
FROM `tasks` t
WHERE t.`lifecycle_event_revision` > 0
ON CONFLICT (`producer`, `family`, `aggregate_kind`, `aggregate_id`) DO UPDATE SET
	`last_seq` = MAX(`last_seq`, excluded.`last_seq`),
	`updated_at` = MAX(`updated_at`, excluded.`updated_at`);
--> statement-breakpoint

INSERT INTO `committed_event_deliveries` (
	`event_id`, `consumer_id`, `delivery_class`, `state`, `attempt_count`, `next_attempt_at`,
	`claimed_by`, `lease_epoch`, `claim_expires_at`, `last_error_code`, `last_error_summary`,
	`replay_generation`, `created_at`, `updated_at`, `accepted_at`, `dead_letter_at`
)
SELECT
	o.`id`,
	'event-center.task-lifecycle',
	'critical',
	CASE WHEN o.`state` = 'dead-letter' THEN 'dead-letter' ELSE 'pending' END,
	o.`attempt_count`,
	o.`next_attempt_at`,
	NULL,
	0,
	NULL,
	CASE WHEN o.`last_error` IS NULL THEN NULL ELSE 'legacy-task-lifecycle-publication' END,
	o.`last_error`,
	0,
	o.`created_at`,
	COALESCE(o.`dead_letter_at`, o.`created_at`),
	NULL,
	o.`dead_letter_at`
FROM `task_lifecycle_event_outbox` o
WHERE o.`state` <> 'completed';
--> statement-breakpoint

UPDATE `committed_event_family_cutovers`
SET `mode` = 'dispatchable',
	`epoch` = 2,
	`changed_at` = 1789574412066,
	`change_ref` = 'rfc341:task-lifecycle-cutover'
WHERE `producer` = 'task-execution'
	AND `family` = 'task-lifecycle'
	AND `mode` = 'legacy'
	AND `epoch` = 1;
--> statement-breakpoint

DROP TABLE `task_lifecycle_event_outbox`;
