-- RFC-227 — OpenCode provenance is byte identity + behavior codec.
--
-- Preserve every RFC-224 owner and lease while removing the misleading
-- official-build/version identity columns. The prior version is retained only
-- as nullable telemetry; it is never compared during resume admission.
CREATE TABLE `__new_opencode_session_owners` (
  `session_id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `node_id` text NOT NULL,
  `created_node_run_id` text NOT NULL,
  `identity_digest` text NOT NULL,
  `runtime_binary_digest` text NOT NULL,
  `session_contract_digest` text NOT NULL,
  `session_store_key` text NOT NULL,
  `project_id` text NOT NULL,
  `protocol_codec` text NOT NULL,
  `reported_version` text,
  `lease_node_run_id` text,
  `lease_nonce_digest` text,
  `leased_at` integer,
  CONSTRAINT `opencode_session_owners_lease_all_or_none` CHECK (
    (
      `lease_node_run_id` IS NULL
      AND `lease_nonce_digest` IS NULL
      AND `leased_at` IS NULL
    )
    OR
    (
      `lease_node_run_id` IS NOT NULL
      AND `lease_nonce_digest` IS NOT NULL
      AND `leased_at` IS NOT NULL
    )
  ),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_opencode_session_owners` (
  `session_id`,
  `task_id`,
  `node_id`,
  `created_node_run_id`,
  `identity_digest`,
  `runtime_binary_digest`,
  `session_contract_digest`,
  `session_store_key`,
  `project_id`,
  `protocol_codec`,
  `reported_version`,
  `lease_node_run_id`,
  `lease_nonce_digest`,
  `leased_at`
)
SELECT
  `session_id`,
  `task_id`,
  `node_id`,
  `created_node_run_id`,
  `identity_digest`,
  `official_build_digest`,
  `session_contract_digest`,
  `session_store_key`,
  `project_id`,
  'opencode-direct-v1',
  `opencode_version`,
  `lease_node_run_id`,
  `lease_nonce_digest`,
  `leased_at`
FROM `opencode_session_owners`;
--> statement-breakpoint
DROP TABLE `opencode_session_owners`;
--> statement-breakpoint
ALTER TABLE `__new_opencode_session_owners` RENAME TO `opencode_session_owners`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_opencode_session_owners_store_key`
  ON `opencode_session_owners` (`session_store_key`);
--> statement-breakpoint
CREATE INDEX `idx_opencode_session_owners_task`
  ON `opencode_session_owners` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_opencode_session_owners_created_run`
  ON `opencode_session_owners` (`created_node_run_id`);
--> statement-breakpoint
CREATE INDEX `idx_opencode_session_owners_lease_run`
  ON `opencode_session_owners` (`lease_node_run_id`);
