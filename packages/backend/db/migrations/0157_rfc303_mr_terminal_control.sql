-- RFC-303 — durable MR/PR terminal-control policy, stream linearization,
-- pre-commit launch guards, task-owned fences, and recoverable stop effects.
-- All task/trigger/delivery ids in the new ledgers are soft references: deleting
-- a UI resource must never cascade away an unfinished resource-release intent.

ALTER TABLE `webhook_triggers`
ADD COLUMN `cancel_on_mr_terminal` integer NOT NULL DEFAULT 0
CHECK (`cancel_on_mr_terminal` IN (0, 1));--> statement-breakpoint

ALTER TABLE `tasks`
ADD COLUMN `source_termination_binding` text;--> statement-breakpoint
ALTER TABLE `tasks`
ADD COLUMN `source_termination_launch_rev` integer
CHECK (`source_termination_launch_rev` IS NULL OR `source_termination_launch_rev` >= 0);--> statement-breakpoint
ALTER TABLE `tasks`
ADD COLUMN `source_termination_fence` text
CHECK (`source_termination_fence` IS NULL OR `source_termination_fence` IN ('closed','merged'));--> statement-breakpoint
ALTER TABLE `tasks`
ADD COLUMN `source_termination_effect_rev` integer
CHECK (`source_termination_effect_rev` IS NULL OR `source_termination_effect_rev` >= 1);--> statement-breakpoint
CREATE INDEX `idx_tasks_source_termination`
ON `tasks` (`source_termination_binding`,`source_termination_launch_rev`);--> statement-breakpoint

-- body_json remains the physical last column. Large retained payloads therefore
-- stay off the hot list/detail prefix exactly as required by RFC-261.
CREATE TABLE `webhook_deliveries_v3` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`event_uuid` text,
	`attempt_count` integer NOT NULL DEFAULT 1,
	`gitlab_event_header` text,
	`object_kind` text,
	`event_type` text,
	`repo_path` text,
	`stream_hint` text,
	`status` text NOT NULL,
	`status_reason` text,
	`replayed_from_delivery_id` text,
	`received_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	`mr_fact_key` text,
	`mr_stream_key` text,
	`mr_stream_revision` integer CHECK (`mr_stream_revision` IS NULL OR `mr_stream_revision` >= 1),
	`mr_state_after` text CHECK (`mr_state_after` IS NULL OR `mr_state_after` IN ('open','closed','merged')),
	`body_json` text
);--> statement-breakpoint
INSERT INTO `webhook_deliveries_v3` (
	`id`,`endpoint_id`,`event_uuid`,`attempt_count`,`gitlab_event_header`,`object_kind`,
	`event_type`,`repo_path`,`stream_hint`,`status`,`status_reason`,
	`replayed_from_delivery_id`,`received_at`,`body_json`
)
SELECT
	`id`,`endpoint_id`,`event_uuid`,`attempt_count`,`gitlab_event_header`,`object_kind`,
	`event_type`,`repo_path`,`stream_hint`,`status`,`status_reason`,
	`replayed_from_delivery_id`,`received_at`,`body_json`
FROM `webhook_deliveries`;--> statement-breakpoint
DROP TABLE `webhook_deliveries`;--> statement-breakpoint
ALTER TABLE `webhook_deliveries_v3` RENAME TO `webhook_deliveries`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_deliveries_dedupe`
ON `webhook_deliveries` (`endpoint_id`,`event_uuid`)
WHERE `event_uuid` IS NOT NULL AND `status` NOT IN ('rejected','failed');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_deliveries_mr_fact`
ON `webhook_deliveries` (`endpoint_id`,`mr_fact_key`)
WHERE `mr_fact_key` IS NOT NULL
  AND `replayed_from_delivery_id` IS NULL
  AND `status` NOT IN ('rejected','failed');--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_endpoint_time`
ON `webhook_deliveries` (`endpoint_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_received_at`
ON `webhook_deliveries` (`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_status_time`
ON `webhook_deliveries` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_event_time`
ON `webhook_deliveries` (`event_type`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_repo_time`
ON `webhook_deliveries` (`repo_path`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_body_retention`
ON `webhook_deliveries` (`received_at`) WHERE `body_json` IS NOT NULL;--> statement-breakpoint

CREATE TABLE `webhook_mr_stream_states` (
	`endpoint_id` text NOT NULL,
	`stream_key` text NOT NULL,
	`project_id` text NOT NULL,
	`mr_iid` text NOT NULL,
	`state` text NOT NULL CHECK (`state` IN ('open','closed','merged')),
	`revision` integer NOT NULL CHECK (`revision` >= 1),
	`last_terminal_revision` integer CHECK (`last_terminal_revision` IS NULL OR `last_terminal_revision` >= 1),
	`last_delivery_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`endpoint_id`,`stream_key`)
);--> statement-breakpoint
CREATE INDEX `idx_webhook_mr_stream_endpoint_state`
ON `webhook_mr_stream_states` (`endpoint_id`,`state`);--> statement-breakpoint

CREATE TABLE `webhook_mr_launch_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`stream_key` text NOT NULL,
	`binding` text NOT NULL,
	`launch_revision` integer NOT NULL CHECK (`launch_revision` >= 0),
	`delivery_id` text NOT NULL,
	`fire_id` text NOT NULL UNIQUE,
	`trigger_id` text,
	`trigger_name_snapshot` text NOT NULL,
	`task_id` text,
	`launch_owner_key` text,
	`status` text NOT NULL CHECK (`status` IN (
		'reserved','launching','revoking-terminal','task-committed',
		'launch-settled','aborted-terminal','failed'
	)),
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_webhook_mr_guard_stream_revision`
ON `webhook_mr_launch_guards` (`endpoint_id`,`stream_key`,`launch_revision`);--> statement-breakpoint
CREATE INDEX `idx_webhook_mr_guard_task`
ON `webhook_mr_launch_guards` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_mr_guard_status`
ON `webhook_mr_launch_guards` (`status`,`updated_at`);--> statement-breakpoint

CREATE TABLE `webhook_mr_control_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL UNIQUE,
	`endpoint_id` text NOT NULL,
	`stream_key` text NOT NULL,
	`binding` text NOT NULL,
	`revision` integer NOT NULL CHECK (`revision` >= 1),
	`observed_event_type` text NOT NULL CHECK (`observed_event_type` IN ('mr_opened','mr_closed','mr_merged')),
	`kind` text NOT NULL CHECK (`kind` IN ('fence-closed','fence-merged','clear-closed')),
	`status` text NOT NULL CHECK (`status` IN ('pending','leased','waiting-launches','retryable','succeeded')),
	`lease_owner` text,
	`lease_expires_at` integer,
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	UNIQUE (`endpoint_id`,`stream_key`,`revision`)
);--> statement-breakpoint
CREATE INDEX `idx_webhook_mr_effect_due`
ON `webhook_mr_control_effects` (`status`,`next_attempt_at`);--> statement-breakpoint

CREATE TABLE `webhook_mr_control_targets` (
	`effect_id` text NOT NULL,
	`task_id` text NOT NULL,
	`prior_status` text,
	`fence_outcome` text NOT NULL CHECK (`fence_outcome` IN ('fenced-closed','fenced-merged','cleared-closed','unchanged')),
	`cancel_outcome` text NOT NULL CHECK (`cancel_outcome` IN ('canceled','already-terminal','not-applicable')),
	`release_outcome` text NOT NULL CHECK (`release_outcome` IN ('pending','no-active-owner','released','unreaped')),
	`error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`effect_id`,`task_id`)
);--> statement-breakpoint
CREATE INDEX `idx_webhook_mr_target_task`
ON `webhook_mr_control_targets` (`task_id`);
