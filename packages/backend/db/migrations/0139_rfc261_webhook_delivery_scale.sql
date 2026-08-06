-- RFC-261 — webhook_deliveries 规模化收口（部署基准：10 万投递/天 × 90 天保留 ≈ 900 万行）。
-- ① 表重建：body_json（≤256KiB）挪到末列——SQLite 行内只存前几 KB，其余走 overflow
--    链；原布局里 replayed_from_delivery_id / received_at 排在 body_json 之后，列表
--    投影每行都要走完整条 overflow 链（50 行/页 × 64 页链）。表 2026-08-04 才上线、
--    存量极小，这是唯一低成本的重排窗口。webhook_deliveries 无 FK 进出
--   （fires.delivery_id 是软链），DROP+RENAME 安全。晚升级的部署若已积累大表，
--    本迁移是一次性整表复制（瞬时双倍磁盘占用、分钟级），属已接受成本。
-- ② 查询索引组：每个过滤维度 ×received_at 组合索引（过滤前缀 + 时间序游走 + LIMIT
--    早停，杜绝百万行子集全排序）；单列 status 索引被 (status,received_at) 取代。
-- ③ body-retention 部分索引：30 天置空 body 的小时级 GC 只触待清行（置空后行自动
--    退出该索引），不再逐小时扫全部 30 天以外的行。
CREATE TABLE `webhook_deliveries_v2` (
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
	`body_json` text
);--> statement-breakpoint
INSERT INTO `webhook_deliveries_v2` (`id`,`endpoint_id`,`event_uuid`,`attempt_count`,`gitlab_event_header`,`object_kind`,`event_type`,`repo_path`,`stream_hint`,`status`,`status_reason`,`replayed_from_delivery_id`,`received_at`,`body_json`)
	SELECT `id`,`endpoint_id`,`event_uuid`,`attempt_count`,`gitlab_event_header`,`object_kind`,`event_type`,`repo_path`,`stream_hint`,`status`,`status_reason`,`replayed_from_delivery_id`,`received_at`,`body_json` FROM `webhook_deliveries`;--> statement-breakpoint
DROP TABLE `webhook_deliveries`;--> statement-breakpoint
ALTER TABLE `webhook_deliveries_v2` RENAME TO `webhook_deliveries`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_deliveries_dedupe` ON `webhook_deliveries` (`endpoint_id`,`event_uuid`)
	WHERE `event_uuid` IS NOT NULL AND `status` NOT IN ('rejected','failed');--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_endpoint_time` ON `webhook_deliveries` (`endpoint_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_received_at` ON `webhook_deliveries` (`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_status_time` ON `webhook_deliveries` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_event_time` ON `webhook_deliveries` (`event_type`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_repo_time` ON `webhook_deliveries` (`repo_path`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_body_retention` ON `webhook_deliveries` (`received_at`) WHERE `body_json` IS NOT NULL;
