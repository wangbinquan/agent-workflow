-- RFC-333 T3: additive collaboration-owned operation and artifact journal.
--
-- These tables are intentionally inactive in this migration. They record the
-- prepare/commit/recovery state of review, clarify and question commands; task
-- continuation remains exclusively in task_execution_intents.

CREATE TABLE `collaboration_gate_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `gate_kind` text NOT NULL CHECK (`gate_kind` IN ('review','clarify','questions')),
  `operation_kind` text NOT NULL CHECK (`operation_kind` IN ('open','decide','manual-question-open','legacy-seed')),
  `gate_ref` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `actor_user_id` text,
  `expected_task_revision` integer NOT NULL CHECK (`expected_task_revision` >= 0),
  `expected_gate_revision` integer NOT NULL CHECK (`expected_gate_revision` >= 0),
  `result_gate_revision` integer,
  `state` text NOT NULL CHECK (`state` IN ('preparing','prepared','committed','cleanup_pending','completed','failed')),
  `claim_epoch` integer DEFAULT 0 NOT NULL CHECK (`claim_epoch` >= 0),
  `claim_expires_at` integer,
  `schema_version` integer DEFAULT 1 NOT NULL CHECK (`schema_version` > 0),
  `manifest_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`manifest_json`)),
  `receipt_json` text CHECK (`receipt_json` IS NULL OR json_valid(`receipt_json`)),
  `failure_json` text CHECK (`failure_json` IS NULL OR json_valid(`failure_json`)),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `committed_at` integer,
  `completed_at` integer,
  CHECK (`result_gate_revision` IS NULL OR `result_gate_revision` = `expected_gate_revision` + 1),
  CHECK (
    `state` <> 'committed' OR
    (`result_gate_revision` IS NOT NULL AND `receipt_json` IS NOT NULL AND `committed_at` IS NOT NULL)
  ),
  CHECK (
    `state` <> 'completed' OR
    (`failure_json` IS NOT NULL OR
      (`result_gate_revision` IS NOT NULL AND `receipt_json` IS NOT NULL AND `committed_at` IS NOT NULL))
  ),
  CHECK (`state` <> 'failed' OR `failure_json` IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_collaboration_gate_operations_idempotency`
  ON `collaboration_gate_operations` (`task_id`, `gate_kind`, `operation_kind`, `idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_collaboration_gate_operations_revision`
  ON `collaboration_gate_operations` (`gate_kind`, `gate_ref`, `result_gate_revision`)
  WHERE `result_gate_revision` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_collaboration_gate_operations_one_active`
  ON `collaboration_gate_operations` (`task_id`, `gate_kind`, `gate_ref`, `operation_kind`)
  WHERE `state` IN ('preparing','prepared','committed','cleanup_pending');
--> statement-breakpoint
CREATE INDEX `idx_collaboration_gate_operations_recovery`
  ON `collaboration_gate_operations` (`state`, `claim_expires_at`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_collaboration_gate_operations_task_gate`
  ON `collaboration_gate_operations` (`task_id`, `gate_kind`, `gate_ref`, `created_at`);
--> statement-breakpoint

CREATE TABLE `collaboration_gate_artifacts` (
  `operation_id` text NOT NULL REFERENCES `collaboration_gate_operations`(`id`) ON DELETE CASCADE,
  `artifact_key` text NOT NULL,
  `artifact_kind` text NOT NULL CHECK (`artifact_kind` = 'review-doc'),
  `staged_path` text NOT NULL,
  `final_path` text NOT NULL,
  `sha256` text NOT NULL,
  `byte_size` integer NOT NULL CHECK (`byte_size` >= 0),
  `state` text NOT NULL CHECK (`state` IN ('declared','staged','consumed','finalized','cleanup_pending')),
  `receipt_json` text CHECK (`receipt_json` IS NULL OR json_valid(`receipt_json`)),
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`operation_id`, `artifact_key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_collaboration_gate_artifacts_final_path`
  ON `collaboration_gate_artifacts` (`final_path`);
--> statement-breakpoint
CREATE INDEX `idx_collaboration_gate_artifacts_state`
  ON `collaboration_gate_artifacts` (`state`, `updated_at`);
--> statement-breakpoint
CREATE TRIGGER `trg_collaboration_gate_operations_committed_immutable`
BEFORE UPDATE OF `result_gate_revision`, `receipt_json`, `committed_at`
ON `collaboration_gate_operations`
WHEN OLD.`result_gate_revision` IS NOT NULL AND (
  NEW.`result_gate_revision` IS NOT OLD.`result_gate_revision` OR
  NEW.`receipt_json` IS NOT OLD.`receipt_json` OR
  NEW.`committed_at` IS NOT OLD.`committed_at`
)
BEGIN
  SELECT RAISE(ABORT, 'human-gate-committed-receipt-immutable');
END;
