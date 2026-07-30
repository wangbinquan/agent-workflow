-- RFC-238 — persistent private multi-turn MCP runtime playground.
CREATE TABLE `mcp_runtime_test_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`mcp_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`client_create_id` text NOT NULL,
	`client_create_digest` text NOT NULL,
	`status` text NOT NULL,
	`end_reason` text,
	`mcp_config_hash` text NOT NULL,
	`runtime_row_id` text NOT NULL,
	`runtime_name` text NOT NULL,
	`runtime_protocol` text NOT NULL,
	`runtime_snapshot_json` text NOT NULL,
	`runtime_fingerprint` text NOT NULL,
	`runtime_binary_path` text NOT NULL,
	`runtime_binary_digest` text,
	`mcp_execution_digest` text,
	`session_contract_digest` text,
	`runtime_session_id` text,
	`native_session_state` text DEFAULT 'pending' NOT NULL,
	`in_flight_turn_id` text,
	`turn_seq` integer DEFAULT 0 NOT NULL,
	`session_version` integer DEFAULT 0 NOT NULL,
	`idle_deadline_at` integer,
	`continuation_blocked_reason` text,
	`scratch_root` text NOT NULL,
	`session_store_root` text NOT NULL,
	`session_store_db_path` text,
	`cleanup_state` text DEFAULT 'not-started' NOT NULL,
	`cleanup_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`mcp_id`) REFERENCES `mcps`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `mcp_runtime_test_sessions_status_shape` CHECK (
		(
			`status` = 'active' AND `end_reason` IS NULL AND `ended_at` IS NULL
			AND ((`in_flight_turn_id` IS NOT NULL AND `idle_deadline_at` IS NULL)
				OR (`in_flight_turn_id` IS NULL AND `idle_deadline_at` IS NOT NULL
					AND `native_session_state` = 'ready'
					AND `continuation_blocked_reason` IS NULL))
		)
		OR (`status` = 'ending' AND `end_reason` IS NOT NULL AND `ended_at` IS NULL
			AND `idle_deadline_at` IS NULL)
		OR (`status` = 'ended' AND `end_reason` IS NOT NULL AND `ended_at` IS NOT NULL
			AND `in_flight_turn_id` IS NULL AND `idle_deadline_at` IS NULL)
	),
	CONSTRAINT `mcp_runtime_test_sessions_hash_shape` CHECK (
		length(`client_create_digest`) = 64
		AND `client_create_digest` NOT GLOB '*[^0-9a-f]*'
		AND length(`mcp_config_hash`) = 64
		AND `mcp_config_hash` NOT GLOB '*[^0-9a-f]*'
		AND length(`runtime_fingerprint`) = 64
		AND `runtime_fingerprint` NOT GLOB '*[^0-9a-f]*'
	),
	CONSTRAINT `mcp_runtime_test_sessions_enum_shape` CHECK (
		`status` IN ('active', 'ending', 'ended')
		AND `runtime_protocol` IN ('opencode', 'claude-code')
		AND `native_session_state` IN ('pending', 'ready', 'unusable')
		AND `cleanup_state` IN ('not-started', 'pending', 'complete', 'quarantined')
		AND (
			`end_reason` IS NULL
			OR `end_reason` IN (
				'user', 'idle-timeout', 'mcp-deleted', 'mcp-disabled',
				'mcp-config-changed', 'access-revoked', 'runtime-disabled',
				'runtime-deleted', 'runtime-profile-changed',
				'runtime-identity-changed', 'capture-truncated',
				'capture-incomplete', 'session-unusable'
			)
		)
		AND (
			`continuation_blocked_reason` IS NULL
			OR `continuation_blocked_reason` IN (
				'mcp-config-changed', 'runtime-profile-changed',
				'runtime-identity-changed', 'mcp-execution-changed',
				'capture-truncated', 'capture-incomplete',
				'session-root-mismatch', 'session-store-missing'
			)
		)
		AND `turn_seq` >= 0
		AND `session_version` >= 0
	),
	CONSTRAINT `mcp_runtime_test_sessions_digest_shape` CHECK (
		(`runtime_binary_digest` IS NULL AND `mcp_execution_digest` IS NULL
			AND `session_contract_digest` IS NULL)
		OR (`runtime_binary_digest` IS NOT NULL
			AND `mcp_execution_digest` IS NOT NULL
			AND `session_contract_digest` IS NOT NULL
			AND length(`runtime_binary_digest`) = 64
			AND `runtime_binary_digest` NOT GLOB '*[^0-9a-f]*'
			AND length(`mcp_execution_digest`) = 64
			AND `mcp_execution_digest` NOT GLOB '*[^0-9a-f]*'
			AND length(`session_contract_digest`) = 64
			AND `session_contract_digest` NOT GLOB '*[^0-9a-f]*')
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_sessions_owner_mcp_live`
	ON `mcp_runtime_test_sessions` (`mcp_id`,`owner_user_id`)
	WHERE `status` IN ('active','ending');--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_sessions_create`
	ON `mcp_runtime_test_sessions` (`mcp_id`,`owner_user_id`,`client_create_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_sessions_owner_mcp_updated`
	ON `mcp_runtime_test_sessions` (`owner_user_id`,`mcp_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_sessions_idle`
	ON `mcp_runtime_test_sessions` (`status`,`idle_deadline_at`);--> statement-breakpoint
CREATE TABLE `mcp_runtime_test_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`client_message_id` text NOT NULL,
	`prompt_text` text NOT NULL,
	`status` text NOT NULL,
	`hard_deadline_at` integer NOT NULL,
	`capture_state` text DEFAULT 'live' NOT NULL,
	`capture_incomplete_reason` text,
	`capture_first_event_seq` integer,
	`capture_last_event_seq` integer DEFAULT 0 NOT NULL,
	`capture_event_bytes` integer DEFAULT 0 NOT NULL,
	`cancel_requested_at` integer,
	`pid` integer,
	`spawned_at` integer,
	`spawn_binary_path` text,
	`raw_command_digest` text,
	`spawn_command_digest` text,
	`exit_code` integer,
	`failure_code` text,
	`stderr_tail` text,
	`duration_ms` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `mcp_runtime_test_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `mcp_runtime_test_turns_enum_shape` CHECK (
		`status` IN (
			'queued', 'running', 'succeeded', 'failed',
			'canceled', 'timed_out', 'interrupted'
		)
		AND `capture_state` IN ('live', 'complete', 'truncated', 'incomplete')
		AND (
			`capture_incomplete_reason` IS NULL
			OR `capture_incomplete_reason` IN (
				'stream-persist-failed', 'stream-frame-limit-exceeded',
				'child-capture-failed', 'post-exit-flush-timeout'
			)
		)
	),
	CONSTRAINT `mcp_runtime_test_turns_counter_shape` CHECK (
		`seq` > 0
		AND `hard_deadline_at` >= `created_at`
		AND `capture_last_event_seq` >= 0
		AND `capture_event_bytes` >= 0
		AND (`capture_first_event_seq` IS NULL OR `capture_first_event_seq` > 0)
		AND (`duration_ms` IS NULL OR `duration_ms` >= 0)
	),
	CONSTRAINT `mcp_runtime_test_turns_lifecycle_shape` CHECK (
		(`status` = 'queued' AND `started_at` IS NULL AND `finished_at` IS NULL)
		OR (`status` = 'running' AND `started_at` IS NOT NULL AND `finished_at` IS NULL)
		OR (`status` IN (
				'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted'
			) AND `finished_at` IS NOT NULL)
	),
	CONSTRAINT `mcp_runtime_test_turns_digest_shape` CHECK (
		(
			`raw_command_digest` IS NULL
			OR (
				length(`raw_command_digest`) = 64
				AND `raw_command_digest` NOT GLOB '*[^0-9a-f]*'
			)
		)
		AND (
			(
				`spawned_at` IS NULL
				AND `spawn_binary_path` IS NULL
				AND `spawn_command_digest` IS NULL
			)
			OR (
				`spawned_at` IS NOT NULL
				AND `spawn_binary_path` IS NOT NULL
				AND `spawn_command_digest` IS NOT NULL
				AND length(`spawn_command_digest`) = 64
				AND `spawn_command_digest` NOT GLOB '*[^0-9a-f]*'
			)
		)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_turns_session_seq`
	ON `mcp_runtime_test_turns` (`session_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_turns_message`
	ON `mcp_runtime_test_turns` (`session_id`,`client_message_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_turns_session`
	ON `mcp_runtime_test_turns` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_turns_status`
	ON `mcp_runtime_test_turns` (`status`,`hard_deadline_at`);--> statement-breakpoint
CREATE TABLE `mcp_runtime_test_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_session_id` text NOT NULL,
	`first_seen_turn_id` text NOT NULL,
	`event_seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`session_id` text,
	`parent_session_id` text,
	`source` text NOT NULL,
	`external_event_key` text,
	FOREIGN KEY (`test_session_id`) REFERENCES `mcp_runtime_test_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `mcp_runtime_test_events_shape` CHECK (
		`event_seq` > 0
		AND `ts` >= 0
		AND `source` IN ('stream', 'live-child', 'post-run-child')
		AND (
			`external_event_key` IS NULL
			OR (
				length(`external_event_key`) = 64
				AND `external_event_key` NOT GLOB '*[^0-9a-f]*'
			)
		)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_events_session_seq`
	ON `mcp_runtime_test_events` (`test_session_id`,`event_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_events_external`
	ON `mcp_runtime_test_events` (`test_session_id`,`external_event_key`)
	WHERE `external_event_key` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_events_session`
	ON `mcp_runtime_test_events` (`test_session_id`,`event_seq`);--> statement-breakpoint
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
CREATE TABLE `opencode_mcp_test_session_owners` (
	`runtime_session_id` text PRIMARY KEY NOT NULL,
	`test_session_id` text NOT NULL,
	`created_turn_id` text NOT NULL,
	`current_turn_id` text NOT NULL,
	`identity_digest` text NOT NULL,
	`runtime_binary_digest` text NOT NULL,
	`session_contract_digest` text NOT NULL,
	`session_store_key` text NOT NULL,
	`project_id` text NOT NULL,
	`protocol_codec` text NOT NULL,
	`reported_version` text,
	`lease_turn_id` text,
	`lease_acquired_at` integer,
	`lease_nonce_digest` text,
	FOREIGN KEY (`test_session_id`) REFERENCES `mcp_runtime_test_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_turn_id`) REFERENCES `mcp_runtime_test_turns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_turn_id`) REFERENCES `mcp_runtime_test_turns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lease_turn_id`) REFERENCES `mcp_runtime_test_turns`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `opencode_mcp_test_owners_lease_all_or_none` CHECK (
		(`lease_turn_id` IS NULL AND `lease_acquired_at` IS NULL AND `lease_nonce_digest` IS NULL)
		OR (`lease_turn_id` IS NOT NULL AND `lease_acquired_at` IS NOT NULL
			AND `lease_nonce_digest` IS NOT NULL)
	),
	CONSTRAINT `opencode_mcp_test_owners_digest_shape` CHECK (
		length(`identity_digest`) = 64
		AND `identity_digest` NOT GLOB '*[^0-9a-f]*'
		AND length(`runtime_binary_digest`) = 64
		AND `runtime_binary_digest` NOT GLOB '*[^0-9a-f]*'
		AND length(`session_contract_digest`) = 64
		AND `session_contract_digest` NOT GLOB '*[^0-9a-f]*'
		AND (
			`lease_nonce_digest` IS NULL
			OR (
				length(`lease_nonce_digest`) = 64
				AND `lease_nonce_digest` NOT GLOB '*[^0-9a-f]*'
			)
		)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_opencode_mcp_test_owners_session`
	ON `opencode_mcp_test_session_owners` (`test_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_opencode_mcp_test_owners_store_key`
	ON `opencode_mcp_test_session_owners` (`session_store_key`);
