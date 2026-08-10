-- RFC-278 — converge the observed long-lived database onto the canonical
-- full-replay schema without preserving retired product state.

-- Recovery events remain active audit history. The legacy 0052 shape has the
-- same columns but persisted inline SQL comments and missed two indexes. Copy
-- every explicit column inside the migration transaction, then restore the
-- canonical definition and indexes without deleting audit rows.
CREATE TABLE `__new_recovery_events` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text,
  `node_run_id` text,
  `actor` text NOT NULL,
  `kind` text NOT NULL,
  `reason` text,
  `before_json` text,
  `after_json` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_recovery_events` (
  `id`, `task_id`, `node_run_id`, `actor`, `kind`, `reason`,
  `before_json`, `after_json`, `created_at`
)
SELECT
  `id`, `task_id`, `node_run_id`, `actor`, `kind`, `reason`,
  `before_json`, `after_json`, `created_at`
FROM `recovery_events`;--> statement-breakpoint
DROP TABLE `recovery_events`;--> statement-breakpoint
ALTER TABLE `__new_recovery_events` RENAME TO `recovery_events`;--> statement-breakpoint
CREATE INDEX `idx_recovery_events_task`
  ON `recovery_events` (`task_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `idx_recovery_events_kind`
  ON `recovery_events` (`kind`, `created_at`);--> statement-breakpoint

-- Create receipts are a 24-hour idempotency cache. RFC-276 resets the native
-- sessions they reference, so retaining a legacy receipt would replay a new
-- request into a terminated session. Recreate the empty canonical table.
DROP TABLE IF EXISTS `mcp_runtime_test_create_receipts`;--> statement-breakpoint
CREATE TABLE `mcp_runtime_test_create_receipts` (
	`mcp_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`client_create_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`session_id` text NOT NULL,
	`accepted_turn_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY (`mcp_id`,`owner_user_id`,`client_create_id`),
	FOREIGN KEY (`mcp_id`) REFERENCES `mcps`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `mcp_runtime_test_create_receipts_shape` CHECK (
		length(`request_digest`) = 64
		AND `request_digest` NOT GLOB '*[^0-9a-f]*'
		AND `created_at` >= 0
		AND `expires_at` > `created_at`
	)
);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_create_receipts_expiry`
	ON `mcp_runtime_test_create_receipts` (`expires_at`);--> statement-breakpoint

-- RFC-165 retired recent_repos in favor of cached_repos. A historical WIP
-- receipt left it behind in the live schema; it has no production readers.
DROP TABLE IF EXISTS `recent_repos`;--> statement-breakpoint

-- RFC-276's archive was a one-migration rollback aid. The mandatory
-- pre-migration backup is the recovery authority after this forward repair.
DROP TABLE IF EXISTS `rfc276_legacy_runtime_archive`;
