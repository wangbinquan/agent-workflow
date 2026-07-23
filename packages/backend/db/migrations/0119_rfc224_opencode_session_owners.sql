-- RFC-224 T14 — one immutable owner row per verified OpenCode session.
--
-- A session may appear on multiple node_runs as inline resume history, so
-- ownership and the single-writer lease live in this dedicated table instead
-- of making node_runs.opencode_session_id unique. created_node_run_id and the
-- lease holder are deliberate logical pointers: task deletion owns retention,
-- while run-history maintenance must never cascade-delete a live session owner.
CREATE TABLE `opencode_session_owners` (
  `session_id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `node_id` text NOT NULL,
  `created_node_run_id` text NOT NULL,
  `identity_digest` text NOT NULL,
  `official_build_digest` text NOT NULL,
  `session_contract_digest` text NOT NULL,
  `session_store_key` text NOT NULL,
  `project_id` text NOT NULL,
  `opencode_version` text NOT NULL,
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
