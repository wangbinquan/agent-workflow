-- RFC-276 — remove runtime-hardening persistence from active product tables.
-- Every removed value and every in-flight state changed at cutover is copied
-- into a generic rollback/audit archive first. Application code never reads
-- this archive; it exists only to keep the forward migration recoverable.

-- Optional Claude CLI compatibility marker. Despite the upstream variable
-- name, this is not a platform sandbox switch. Natural execution is the
-- default; administrators may opt a claude-code runtime profile in explicitly.
ALTER TABLE `runtimes` ADD COLUMN `is_sandbox` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE `rfc276_legacy_runtime_archive` (
  `kind` text NOT NULL,
  `legacy_key` text NOT NULL,
  `payload_json` text NOT NULL,
  `archived_at` integer NOT NULL,
  PRIMARY KEY (`kind`, `legacy_key`)
);--> statement-breakpoint

INSERT INTO `rfc276_legacy_runtime_archive`
  (`kind`, `legacy_key`, `payload_json`, `archived_at`)
SELECT 'agent-network', `id`, json_object('network', `network`), unixepoch() * 1000
FROM `agents`
WHERE `network` IS NOT NULL;--> statement-breakpoint

INSERT INTO `rfc276_legacy_runtime_archive`
  (`kind`, `legacy_key`, `payload_json`, `archived_at`)
SELECT 'workflow-definition', `id`, json_object('definition', json(`definition`)), unixepoch() * 1000
FROM `workflows`
WHERE json_valid(`definition`)
  AND json_type(`definition`, '$.nodes') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(`workflows`.`definition`, '$.nodes')
    WHERE json_type(`value`, '$.network') IS NOT NULL
  );--> statement-breakpoint

INSERT INTO `rfc276_legacy_runtime_archive`
  (`kind`, `legacy_key`, `payload_json`, `archived_at`)
SELECT 'task-workflow-snapshot', `id`,
  json_object('workflowSnapshot', json(`workflow_snapshot`)), unixepoch() * 1000
FROM `tasks`
WHERE json_valid(`workflow_snapshot`)
  AND json_type(`workflow_snapshot`, '$.nodes') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(`tasks`.`workflow_snapshot`, '$.nodes')
    WHERE json_type(`value`, '$.network') IS NOT NULL
  );--> statement-breakpoint

INSERT INTO `rfc276_legacy_runtime_archive`
  (`kind`, `legacy_key`, `payload_json`, `archived_at`)
SELECT 'business-session-owner', `session_id`, json_object(
  'sessionId', `session_id`, 'taskId', `task_id`, 'nodeId', `node_id`,
  'createdNodeRunId', `created_node_run_id`, 'identityDigest', `identity_digest`,
  'runtimeBinaryDigest', `runtime_binary_digest`,
  'sessionContractDigest', `session_contract_digest`,
  'sessionStoreKey', `session_store_key`, 'projectId', `project_id`,
  'protocolCodec', `protocol_codec`, 'reportedVersion', `reported_version`,
  'leaseNodeRunId', `lease_node_run_id`, 'leaseNonceDigest', `lease_nonce_digest`,
  'leasedAt', `leased_at`
), unixepoch() * 1000
FROM `opencode_session_owners`;--> statement-breakpoint

INSERT INTO `rfc276_legacy_runtime_archive`
  (`kind`, `legacy_key`, `payload_json`, `archived_at`)
SELECT 'mcp-session-owner', `runtime_session_id`, json_object(
  'runtimeSessionId', `runtime_session_id`, 'testSessionId', `test_session_id`,
  'createdTurnId', `created_turn_id`, 'currentTurnId', `current_turn_id`,
  'identityDigest', `identity_digest`, 'runtimeBinaryDigest', `runtime_binary_digest`,
  'sessionContractDigest', `session_contract_digest`,
  'sessionStoreKey', `session_store_key`, 'projectId', `project_id`,
  'protocolCodec', `protocol_codec`, 'reportedVersion', `reported_version`,
  'leaseTurnId', `lease_turn_id`, 'leaseAcquiredAt', `lease_acquired_at`,
  'leaseNonceDigest', `lease_nonce_digest`
), unixepoch() * 1000
FROM `opencode_mcp_test_session_owners`;--> statement-breakpoint

INSERT INTO `rfc276_legacy_runtime_archive`
  (`kind`, `legacy_key`, `payload_json`, `archived_at`)
SELECT 'mcp-session-removed-state', `id`, json_object(
  'status', `status`, 'endReason', `end_reason`,
  'runtimeFingerprint', `runtime_fingerprint`,
  'runtimeBinaryDigest', `runtime_binary_digest`,
  'mcpExecutionDigest', `mcp_execution_digest`,
  'sessionContractDigest', `session_contract_digest`,
  'runtimeSessionId', `runtime_session_id`,
  'nativeSessionState', `native_session_state`,
  'inFlightTurnId', `in_flight_turn_id`,
  'idleDeadlineAt', `idle_deadline_at`,
  'continuationBlockedReason', `continuation_blocked_reason`,
  'sessionStoreRoot', `session_store_root`,
  'sessionStoreDbPath', `session_store_db_path`,
  'cleanupState', `cleanup_state`, 'cleanupErrorCode', `cleanup_error_code`,
  'updatedAt', `updated_at`, 'endedAt', `ended_at`
), unixepoch() * 1000
FROM `mcp_runtime_test_sessions`;--> statement-breakpoint

INSERT INTO `rfc276_legacy_runtime_archive`
  (`kind`, `legacy_key`, `payload_json`, `archived_at`)
SELECT 'mcp-turn-removed-state', `id`, json_object(
  'status', `status`, 'captureState', `capture_state`,
  'captureIncompleteReason', `capture_incomplete_reason`,
  'pid', `pid`, 'rawCommandDigest', `raw_command_digest`,
  'spawnCommandDigest', `spawn_command_digest`, 'failureCode', `failure_code`,
  'durationMs', `duration_ms`, 'finishedAt', `finished_at`
), unixepoch() * 1000
FROM `mcp_runtime_test_turns`
WHERE `raw_command_digest` IS NOT NULL
   OR `spawn_command_digest` IS NOT NULL
   OR `status` IN ('queued', 'running');--> statement-breakpoint

ALTER TABLE `agents` DROP COLUMN `network`;--> statement-breakpoint

UPDATE `workflows`
SET `definition` = json_set(
  `definition`, '$.nodes', json(COALESCE((
    SELECT json_group_array(json(json_remove(`value`, '$.network')))
    FROM json_each(`workflows`.`definition`, '$.nodes')
  ), '[]'))
)
WHERE json_valid(`definition`)
  AND json_type(`definition`, '$.nodes') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(`workflows`.`definition`, '$.nodes')
    WHERE json_type(`value`, '$.network') IS NOT NULL
  );--> statement-breakpoint

UPDATE `tasks`
SET `workflow_snapshot` = json_set(
  `workflow_snapshot`, '$.nodes', json(COALESCE((
    SELECT json_group_array(json(json_remove(`value`, '$.network')))
    FROM json_each(`tasks`.`workflow_snapshot`, '$.nodes')
  ), '[]'))
)
WHERE json_valid(`workflow_snapshot`)
  AND json_type(`workflow_snapshot`, '$.nodes') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(`tasks`.`workflow_snapshot`, '$.nodes')
    WHERE json_type(`value`, '$.network') IS NOT NULL
  );--> statement-breakpoint

DROP TABLE `opencode_mcp_test_session_owners`;--> statement-breakpoint
DROP TABLE `opencode_session_owners`;--> statement-breakpoint

CREATE TABLE `runtime_session_leases` (
  `protocol` text NOT NULL,
  `session_id` text NOT NULL,
  `task_id` text NOT NULL,
  `node_id` text NOT NULL,
  `created_node_run_id` text NOT NULL,
  `lease_node_run_id` text,
  `lease_nonce_digest` text,
  `leased_at` integer,
  PRIMARY KEY (`protocol`, `session_id`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `runtime_session_leases_all_or_none` CHECK (
    (`lease_node_run_id` IS NULL AND `lease_nonce_digest` IS NULL AND `leased_at` IS NULL)
    OR (`lease_node_run_id` IS NOT NULL AND `lease_nonce_digest` IS NOT NULL AND `leased_at` IS NOT NULL)
  ),
  CONSTRAINT `runtime_session_leases_protocol_shape`
    CHECK (`protocol` IN ('opencode', 'claude-code'))
);--> statement-breakpoint
CREATE INDEX `idx_runtime_session_leases_task`
  ON `runtime_session_leases` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_session_leases_created_run`
  ON `runtime_session_leases` (`created_node_run_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_session_leases_lease_run`
  ON `runtime_session_leases` (`lease_node_run_id`);--> statement-breakpoint

CREATE TABLE `__new_mcp_runtime_test_sessions` (
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
  `runtime_binary_path` text NOT NULL,
  `runtime_session_id` text,
  `native_session_state` text DEFAULT 'pending' NOT NULL,
  `in_flight_turn_id` text,
  `turn_seq` integer DEFAULT 0 NOT NULL,
  `session_version` integer DEFAULT 0 NOT NULL,
  `idle_deadline_at` integer,
  `continuation_blocked_reason` text,
  `scratch_root` text NOT NULL,
  `cleanup_state` text DEFAULT 'not-started' NOT NULL,
  `cleanup_error_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `ended_at` integer,
  FOREIGN KEY (`mcp_id`) REFERENCES `mcps`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `mcp_runtime_test_sessions_status_shape` CHECK (
    (`status` = 'active' AND `end_reason` IS NULL AND `ended_at` IS NULL
      AND ((`in_flight_turn_id` IS NOT NULL AND `idle_deadline_at` IS NULL)
        OR (`in_flight_turn_id` IS NULL AND `idle_deadline_at` IS NOT NULL
          AND `native_session_state` = 'ready' AND `continuation_blocked_reason` IS NULL)))
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
  ),
  CONSTRAINT `mcp_runtime_test_sessions_enum_shape` CHECK (
    `status` IN ('active', 'ending', 'ended')
    AND `runtime_protocol` IN ('opencode', 'claude-code')
    AND `native_session_state` IN ('pending', 'ready', 'unusable')
    AND `cleanup_state` IN ('not-started', 'pending', 'complete', 'quarantined')
    AND (`end_reason` IS NULL OR `end_reason` IN (
      'user', 'idle-timeout', 'mcp-deleted', 'mcp-disabled',
      'mcp-config-changed', 'access-revoked', 'runtime-disabled',
      'runtime-deleted', 'runtime-profile-changed', 'runtime-session-reset',
      'capture-truncated', 'capture-incomplete', 'session-unusable'
    ))
    AND (`continuation_blocked_reason` IS NULL OR `continuation_blocked_reason` IN (
      'mcp-config-changed', 'runtime-profile-changed',
      'capture-truncated', 'capture-incomplete'
    ))
    AND `turn_seq` >= 0
    AND `session_version` >= 0
  )
);--> statement-breakpoint

INSERT INTO `__new_mcp_runtime_test_sessions` (
  `id`, `mcp_id`, `owner_user_id`, `client_create_id`, `client_create_digest`,
  `status`, `end_reason`, `mcp_config_hash`, `runtime_row_id`, `runtime_name`,
  `runtime_protocol`, `runtime_snapshot_json`, `runtime_binary_path`,
  `runtime_session_id`, `native_session_state`, `in_flight_turn_id`, `turn_seq`,
  `session_version`, `idle_deadline_at`, `continuation_blocked_reason`,
  `scratch_root`, `cleanup_state`, `cleanup_error_code`, `created_at`,
  `updated_at`, `ended_at`
)
SELECT
  `id`, `mcp_id`, `owner_user_id`, `client_create_id`, `client_create_digest`,
  CASE WHEN `status` IN ('active', 'ending') THEN 'ended' ELSE `status` END,
  CASE
    WHEN `status` IN ('active', 'ending') THEN 'runtime-session-reset'
    WHEN `end_reason` = 'runtime-identity-changed' THEN 'runtime-profile-changed'
    ELSE `end_reason`
  END,
  `mcp_config_hash`, `runtime_row_id`, `runtime_name`, `runtime_protocol`,
  `runtime_snapshot_json`, `runtime_binary_path`,
  CASE WHEN `status` IN ('active', 'ending') THEN NULL ELSE `runtime_session_id` END,
  CASE WHEN `status` IN ('active', 'ending') THEN 'unusable' ELSE `native_session_state` END,
  CASE WHEN `status` IN ('active', 'ending') THEN NULL ELSE `in_flight_turn_id` END,
  `turn_seq`,
  CASE WHEN `status` IN ('active', 'ending') THEN `session_version` + 1 ELSE `session_version` END,
  CASE WHEN `status` IN ('active', 'ending') THEN NULL ELSE `idle_deadline_at` END,
  CASE
    WHEN `status` IN ('active', 'ending') THEN NULL
    WHEN `continuation_blocked_reason` IN (
      'runtime-identity-changed', 'mcp-execution-changed',
      'session-root-mismatch', 'session-store-missing'
    ) THEN NULL
    ELSE `continuation_blocked_reason`
  END,
  `scratch_root`,
  CASE
    WHEN `status` IN ('active', 'ending') AND EXISTS (
      SELECT 1 FROM `mcp_runtime_test_turns` AS `t`
      WHERE `t`.`session_id` = `mcp_runtime_test_sessions`.`id`
        AND (`t`.`status` = 'running' OR `t`.`pid` IS NOT NULL)
    ) THEN 'quarantined'
    WHEN `status` IN ('active', 'ending') THEN 'pending'
    ELSE `cleanup_state`
  END,
  CASE
    WHEN `status` IN ('active', 'ending') AND EXISTS (
      SELECT 1 FROM `mcp_runtime_test_turns` AS `t`
      WHERE `t`.`session_id` = `mcp_runtime_test_sessions`.`id`
        AND (`t`.`status` = 'running' OR `t`.`pid` IS NOT NULL)
    ) THEN 'mcp-test-runtime-session-reset-reap-required'
    ELSE `cleanup_error_code`
  END,
  `created_at`,
  CASE WHEN `status` IN ('active', 'ending') THEN unixepoch() * 1000 ELSE `updated_at` END,
  CASE WHEN `status` IN ('active', 'ending') THEN unixepoch() * 1000 ELSE `ended_at` END
FROM `mcp_runtime_test_sessions`;--> statement-breakpoint

CREATE TABLE `__new_mcp_runtime_test_turns` (
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
  `exit_code` integer,
  `failure_code` text,
  `stderr_tail` text,
  `duration_ms` integer,
  `started_at` integer,
  `finished_at` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `__new_mcp_runtime_test_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `mcp_runtime_test_turns_enum_shape` CHECK (
    `status` IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted')
    AND `capture_state` IN ('live', 'complete', 'truncated', 'incomplete')
    AND (`capture_incomplete_reason` IS NULL OR `capture_incomplete_reason` IN (
      'stream-persist-failed', 'stream-frame-limit-exceeded',
      'child-capture-failed', 'post-exit-flush-timeout'
    ))
  ),
  CONSTRAINT `mcp_runtime_test_turns_counter_shape` CHECK (
    `seq` > 0 AND `hard_deadline_at` >= `created_at`
    AND `capture_last_event_seq` >= 0 AND `capture_event_bytes` >= 0
    AND (`capture_first_event_seq` IS NULL OR `capture_first_event_seq` > 0)
    AND (`duration_ms` IS NULL OR `duration_ms` >= 0)
  ),
  CONSTRAINT `mcp_runtime_test_turns_lifecycle_shape` CHECK (
    (`status` = 'queued' AND `started_at` IS NULL AND `finished_at` IS NULL)
    OR (`status` = 'running' AND `started_at` IS NOT NULL AND `finished_at` IS NULL)
    OR (`status` IN ('succeeded', 'failed', 'canceled', 'timed_out', 'interrupted')
      AND `finished_at` IS NOT NULL)
  )
);--> statement-breakpoint

INSERT INTO `__new_mcp_runtime_test_turns` (
  `id`, `session_id`, `seq`, `client_message_id`, `prompt_text`, `status`,
  `hard_deadline_at`, `capture_state`, `capture_incomplete_reason`,
  `capture_first_event_seq`, `capture_last_event_seq`, `capture_event_bytes`,
  `cancel_requested_at`, `pid`, `spawned_at`, `spawn_binary_path`, `exit_code`,
  `failure_code`, `stderr_tail`, `duration_ms`, `started_at`, `finished_at`, `created_at`
)
SELECT
  `id`, `session_id`, `seq`, `client_message_id`, `prompt_text`,
  CASE
    WHEN `status` IN ('queued', 'running') AND `session_id` IN (
      SELECT `id` FROM `mcp_runtime_test_sessions` WHERE `status` IN ('active', 'ending')
    ) THEN 'interrupted'
    ELSE `status`
  END,
  `hard_deadline_at`,
  CASE
    WHEN `status` = 'queued' AND `session_id` IN (
      SELECT `id` FROM `mcp_runtime_test_sessions` WHERE `status` IN ('active', 'ending')
    ) THEN 'complete'
    WHEN `status` = 'running' AND `session_id` IN (
      SELECT `id` FROM `mcp_runtime_test_sessions` WHERE `status` IN ('active', 'ending')
    ) THEN 'incomplete'
    ELSE `capture_state`
  END,
  CASE
    WHEN `status` = 'running' AND `session_id` IN (
      SELECT `id` FROM `mcp_runtime_test_sessions` WHERE `status` IN ('active', 'ending')
    ) THEN 'post-exit-flush-timeout'
    WHEN `status` = 'queued' AND `session_id` IN (
      SELECT `id` FROM `mcp_runtime_test_sessions` WHERE `status` IN ('active', 'ending')
    ) THEN NULL
    ELSE `capture_incomplete_reason`
  END,
  `capture_first_event_seq`, `capture_last_event_seq`, `capture_event_bytes`,
  `cancel_requested_at`, `pid`, `spawned_at`, `spawn_binary_path`, `exit_code`,
  CASE
    WHEN `status` IN ('queued', 'running') AND `session_id` IN (
      SELECT `id` FROM `mcp_runtime_test_sessions` WHERE `status` IN ('active', 'ending')
    ) THEN 'mcp-test-runtime-session-reset'
    ELSE `failure_code`
  END,
  `stderr_tail`,
  CASE
    WHEN `status` IN ('queued', 'running') AND `session_id` IN (
      SELECT `id` FROM `mcp_runtime_test_sessions` WHERE `status` IN ('active', 'ending')
    ) THEN MAX(0, unixepoch() * 1000 - COALESCE(`started_at`, `created_at`))
    ELSE `duration_ms`
  END,
  `started_at`,
  CASE
    WHEN `status` IN ('queued', 'running') AND `session_id` IN (
      SELECT `id` FROM `mcp_runtime_test_sessions` WHERE `status` IN ('active', 'ending')
    ) THEN unixepoch() * 1000
    ELSE `finished_at`
  END,
  `created_at`
FROM `mcp_runtime_test_turns`;--> statement-breakpoint

CREATE TABLE `__new_mcp_runtime_test_events` (
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
  FOREIGN KEY (`test_session_id`) REFERENCES `__new_mcp_runtime_test_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `mcp_runtime_test_events_shape` CHECK (
    `event_seq` > 0 AND `ts` >= 0
    AND `source` IN ('stream', 'live-child', 'post-run-child')
    AND (`external_event_key` IS NULL OR (
      length(`external_event_key`) = 64
      AND `external_event_key` NOT GLOB '*[^0-9a-f]*'
    ))
  )
);--> statement-breakpoint

INSERT INTO `__new_mcp_runtime_test_events` (
  `id`, `test_session_id`, `first_seen_turn_id`, `event_seq`, `ts`, `kind`,
  `payload`, `session_id`, `parent_session_id`, `source`, `external_event_key`
)
SELECT
  `id`, `test_session_id`, `first_seen_turn_id`, `event_seq`, `ts`, `kind`,
  `payload`, `session_id`, `parent_session_id`, `source`, `external_event_key`
FROM `mcp_runtime_test_events`;--> statement-breakpoint

DROP TABLE `mcp_runtime_test_events`;--> statement-breakpoint
DROP TABLE `mcp_runtime_test_turns`;--> statement-breakpoint
DROP TABLE `mcp_runtime_test_sessions`;--> statement-breakpoint
-- Bun's SQLite connection defaults legacy_alter_table=ON, which leaves child
-- foreign-key targets pointing at the temporary table name after a rename.
-- Toggle it only for this three-table swap, then restore the connection default.
PRAGMA legacy_alter_table=OFF;--> statement-breakpoint
ALTER TABLE `__new_mcp_runtime_test_sessions` RENAME TO `mcp_runtime_test_sessions`;--> statement-breakpoint
ALTER TABLE `__new_mcp_runtime_test_turns` RENAME TO `mcp_runtime_test_turns`;--> statement-breakpoint
ALTER TABLE `__new_mcp_runtime_test_events` RENAME TO `mcp_runtime_test_events`;--> statement-breakpoint
PRAGMA legacy_alter_table=ON;--> statement-breakpoint

CREATE UNIQUE INDEX `uniq_mcp_runtime_test_sessions_owner_mcp_live`
  ON `mcp_runtime_test_sessions` (`mcp_id`,`owner_user_id`)
  WHERE `status` IN ('active','ending');--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_sessions_create`
  ON `mcp_runtime_test_sessions` (`mcp_id`,`owner_user_id`,`client_create_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_sessions_owner_mcp_updated`
  ON `mcp_runtime_test_sessions` (`owner_user_id`,`mcp_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_sessions_idle`
  ON `mcp_runtime_test_sessions` (`status`,`idle_deadline_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_turns_session_seq`
  ON `mcp_runtime_test_turns` (`session_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_turns_message`
  ON `mcp_runtime_test_turns` (`session_id`,`client_message_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_turns_session`
  ON `mcp_runtime_test_turns` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_turns_status`
  ON `mcp_runtime_test_turns` (`status`,`hard_deadline_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_events_session_seq`
  ON `mcp_runtime_test_events` (`test_session_id`,`event_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_events_external`
  ON `mcp_runtime_test_events` (`test_session_id`,`external_event_key`)
  WHERE `external_event_key` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_mcp_runtime_test_events_session`
  ON `mcp_runtime_test_events` (`test_session_id`,`event_seq`);--> statement-breakpoint

CREATE TABLE `mcp_runtime_test_session_leases` (
  `protocol` text NOT NULL,
  `runtime_session_id` text NOT NULL,
  `test_session_id` text NOT NULL,
  `created_turn_id` text NOT NULL,
  `current_turn_id` text NOT NULL,
  `lease_turn_id` text,
  `lease_acquired_at` integer,
  `lease_nonce_digest` text,
  PRIMARY KEY (`protocol`, `runtime_session_id`),
  FOREIGN KEY (`test_session_id`) REFERENCES `mcp_runtime_test_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_turn_id`) REFERENCES `mcp_runtime_test_turns`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`current_turn_id`) REFERENCES `mcp_runtime_test_turns`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`lease_turn_id`) REFERENCES `mcp_runtime_test_turns`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `mcp_runtime_test_session_leases_all_or_none` CHECK (
    (`lease_turn_id` IS NULL AND `lease_acquired_at` IS NULL AND `lease_nonce_digest` IS NULL)
    OR (`lease_turn_id` IS NOT NULL AND `lease_acquired_at` IS NOT NULL AND `lease_nonce_digest` IS NOT NULL)
  ),
  CONSTRAINT `mcp_runtime_test_session_leases_shape` CHECK (
    `protocol` IN ('opencode', 'claude-code')
    AND (`lease_nonce_digest` IS NULL OR (
      length(`lease_nonce_digest`) = 64
      AND `lease_nonce_digest` NOT GLOB '*[^0-9a-f]*'
    ))
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mcp_runtime_test_session_leases_test_session`
  ON `mcp_runtime_test_session_leases` (`test_session_id`);
