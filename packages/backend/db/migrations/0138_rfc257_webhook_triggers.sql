-- RFC-257 — 代码平台 webhook 触发器：五张新表 + tasks 归属两列。
-- deliveries（HTTP 投递一行）与 fires（delivery × trigger 命中一行）分层；
-- 去重部分唯一索引排除 rejected/failed（multica 教训：secret 配错的一次失败
-- 不得永久占位，修正后 Resend 必须能落地），received/processing 在途态占位
-- 挡重复分发（设计门 F-4 三段式）。
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`url_token` text NOT NULL,
	`secret_enc` text NOT NULL,
	`enabled` integer NOT NULL DEFAULT 1,
	`preferred_clone_protocol` text NOT NULL DEFAULT 'http',
	`last_delivery_at` integer,
	`created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_endpoints_url_token` ON `webhook_endpoints` (`url_token`);--> statement-breakpoint
CREATE TABLE `webhook_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`endpoint_id` text NOT NULL REFERENCES `webhook_endpoints`(`id`),
	`owner_user_id` text NOT NULL,
	`enabled` integer NOT NULL DEFAULT 1,
	`repo_scope` text NOT NULL,
	`event_types` text NOT NULL,
	`branch_filter` text,
	`command_prefix` text,
	`ignore_usernames` text NOT NULL DEFAULT '[]',
	`launch_kind` text NOT NULL,
	`launch_ref_id` text NOT NULL,
	`launch_payload` text NOT NULL,
	`max_consecutive_fires` integer NOT NULL DEFAULT 3,
	`auto_register_repos` integer NOT NULL DEFAULT 1,
	`last_fired_at` integer,
	`last_status` text,
	`last_error` text,
	`last_task_id` text,
	`consecutive_failures` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);--> statement-breakpoint
CREATE INDEX `idx_webhook_triggers_endpoint_enabled` ON `webhook_triggers` (`endpoint_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `idx_webhook_triggers_owner` ON `webhook_triggers` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
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
	`body_json` text,
	`replayed_from_delivery_id` text,
	`received_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_deliveries_dedupe` ON `webhook_deliveries` (`endpoint_id`,`event_uuid`)
	WHERE `event_uuid` IS NOT NULL AND `status` NOT IN ('rejected','failed');--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_endpoint_time` ON `webhook_deliveries` (`endpoint_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_status` ON `webhook_deliveries` (`status`);--> statement-breakpoint
CREATE TABLE `webhook_trigger_fires` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`trigger_id` text NOT NULL REFERENCES `webhook_triggers`(`id`) ON DELETE CASCADE,
	`stream_key` text NOT NULL,
	`outcome` text NOT NULL,
	`superseded_task_id` text,
	`task_id` text,
	`error` text,
	`fired_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);--> statement-breakpoint
CREATE INDEX `idx_webhook_fires_trigger_time` ON `webhook_trigger_fires` (`trigger_id`,`fired_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_fires_delivery` ON `webhook_trigger_fires` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_fires_stream` ON `webhook_trigger_fires` (`trigger_id`,`stream_key`,`fired_at`);--> statement-breakpoint
CREATE TABLE `webhook_trigger_streams` (
	`trigger_id` text NOT NULL REFERENCES `webhook_triggers`(`id`) ON DELETE CASCADE,
	`stream_key` text NOT NULL,
	`consecutive_fires` integer NOT NULL DEFAULT 0,
	`last_fire_at` integer,
	`reset_at` integer,
	`reset_by` text,
	PRIMARY KEY (`trigger_id`, `stream_key`)
);--> statement-breakpoint
ALTER TABLE `tasks` ADD `webhook_trigger_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `webhook_fire_id` text;--> statement-breakpoint
CREATE INDEX `idx_tasks_webhook_trigger` ON `tasks` (`webhook_trigger_id`);
