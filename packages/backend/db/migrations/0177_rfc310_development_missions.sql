-- RFC-310 PR-2 T21 — DevelopmentMission 聚合与 worker 的持久化面（design §11.1）。
--
-- 原则：DB 行只存 ref/digest/closed enum/计数——raw requirement/log/diff、
-- host path、credential、webhook body、session id 一概不入库（各表「不存什么」
-- 见 design 表）。所有 command 走 (mission_id, revision) OCC；单可写 ActionRun
-- 与 active MR claim 用唯一索引在存储层兜底。

CREATE TABLE `development_missions` (
  `id` text PRIMARY KEY NOT NULL,
  `revision` integer NOT NULL DEFAULT 0,
  `epoch` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL,
  `automation_mode` text NOT NULL DEFAULT 'active',
  `transition_fence` text NOT NULL DEFAULT 'none',
  `repository_id` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_content_digest` text,
  `requested_source_key` text,
  `external_id` text,
  `resolved_source_key` text,
  `resolved_adapter_id` text,
  `resolved_adapter_revision` integer,
  `delivery_kind` text NOT NULL,
  `delivery_target_ref` text,
  `delivery_source_branch` text,
  `adopted_mr_ref` text,
  `assignment_id` text,
  `employee_id` text,
  `employee_revision` integer,
  `policy_id` text,
  `policy_revision` integer,
  `requirement_bundle_ref` text,
  `repository_facts_ref` text,
  `upload_plan_ref` text,
  `upload_placement_ref` text,
  `upload_publication_ref` text,
  `mr_claim_id` text,
  `current_action_run_id` text,
  `readiness_json` text,
  `block_code` text,
  `block_detail` text,
  `terminal_kind` text,
  `terminal_upload_fulfillment` text,
  `terminal_at` integer,
  `launch_idempotency_key` text,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `development_missions_launch_idem_unique` ON `development_missions` (`launch_idempotency_key`) WHERE `launch_idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_development_missions_status` ON `development_missions` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_development_missions_repo` ON `development_missions` (`repository_id`);
--> statement-breakpoint
CREATE TABLE `development_mission_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `generation` integer NOT NULL DEFAULT 1,
  `source_kind` text NOT NULL,
  `external_id` text,
  `adapter_id` text,
  `adapter_revision` integer,
  `source_revision` text,
  `bundle_ref` text,
  `manifest_digest` text,
  `file_count` integer,
  `total_bytes` integer,
  `state` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dev_mission_sources_mission` ON `development_mission_sources` (`mission_id`);
--> statement-breakpoint
CREATE TABLE `development_repository_upload_plans` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `mission_revision` integer NOT NULL,
  `repository_id` text NOT NULL,
  `baseline_snapshot_ref` text NOT NULL,
  `baseline_sha` text NOT NULL,
  `plan_digest` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `development_repository_upload_plan_entries` (
  `plan_id` text NOT NULL REFERENCES `development_repository_upload_plans`(`id`),
  `ordinal` integer NOT NULL,
  `file_id` text NOT NULL,
  `upload_blob_ref` text NOT NULL,
  `upload_sha256` text NOT NULL,
  `repository_target_path` text NOT NULL,
  `content_policy` text NOT NULL,
  `target_file_mode` text NOT NULL,
  `expected_target_kind` text NOT NULL,
  `expected_target_sha256` text,
  `expected_target_file_mode` text,
  PRIMARY KEY (`plan_id`, `ordinal`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_upload_plan_target_unique` ON `development_repository_upload_plan_entries` (`plan_id`, `repository_target_path`);
--> statement-breakpoint
CREATE TABLE `development_repository_upload_receipts` (
  `id` text PRIMARY KEY NOT NULL,
  `plan_id` text NOT NULL REFERENCES `development_repository_upload_plans`(`id`),
  `baseline_snapshot_ref` text NOT NULL,
  `receipt_kind` text NOT NULL,
  `seed_change_ref` text,
  `seed_tree_digest` text,
  `fulfillment_kind` text,
  `commit_sha` text,
  `entries_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_upload_receipts_unique` ON `development_repository_upload_receipts` (`plan_id`, `baseline_snapshot_ref`, `receipt_kind`);
--> statement-breakpoint
CREATE TABLE `development_mr_claims` (
  `id` text PRIMARY KEY NOT NULL,
  `code_host_endpoint_ref` text NOT NULL,
  `stable_project_ref` text NOT NULL,
  `mr_iid` text NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `epoch` integer NOT NULL,
  `head_sha` text,
  `state` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL,
  `released_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_mr_claims_active_unique` ON `development_mr_claims` (`code_host_endpoint_ref`, `stable_project_ref`, `mr_iid`) WHERE `state` = 'active';
--> statement-breakpoint
CREATE TABLE `development_wake_hints` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `source` text NOT NULL,
  `delivery_key` text NOT NULL,
  `observed_at` integer NOT NULL,
  `consumed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_wake_hints_delivery_unique` ON `development_wake_hints` (`mission_id`, `delivery_key`);
--> statement-breakpoint
CREATE TABLE `development_deferred_wakes` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `decision_id` text NOT NULL,
  `reason` text NOT NULL,
  `resume_at` integer,
  `wake_sources_json` text NOT NULL,
  `attempt_ordinal` integer NOT NULL DEFAULT 0,
  `state` text NOT NULL DEFAULT 'armed',
  `created_at` integer NOT NULL,
  `settled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_deferred_wakes_decision_unique` ON `development_deferred_wakes` (`mission_id`, `decision_id`);
--> statement-breakpoint
CREATE TABLE `development_fact_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `mission_revision` integer NOT NULL,
  `captured_at` text NOT NULL,
  `cells_json` text NOT NULL,
  `refs_json` text NOT NULL,
  `digest` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dev_fact_snapshots_mission` ON `development_fact_snapshots` (`mission_id`);
--> statement-breakpoint
CREATE TABLE `development_decisions` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `mission_revision` integer NOT NULL,
  `policy_id` text,
  `policy_revision` integer,
  `employee_id` text,
  `employee_revision` integer,
  `fact_snapshot_id` text,
  `fact_digest` text NOT NULL,
  `work_set_json` text,
  `guard_trace_json` text NOT NULL,
  `rule_trace_json` text NOT NULL,
  `selected_json` text NOT NULL,
  `canonical_digest` text NOT NULL,
  `decision_input_digest` text NOT NULL,
  `decided_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_decisions_input_unique` ON `development_decisions` (`mission_id`, `decision_input_digest`);
--> statement-breakpoint
CREATE TABLE `development_action_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `mission_revision` integer NOT NULL,
  `decision_id` text NOT NULL,
  `capability_id` text NOT NULL,
  `capability_contract_version` integer NOT NULL,
  `template_id` text,
  `template_revision` integer,
  `work_set_digest` text,
  `input_fact_digest` text NOT NULL,
  `baseline_ref` text,
  `writable` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL,
  `result_ref` text,
  `failure_json` text,
  `created_at` integer NOT NULL,
  `settled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_action_runs_decision_unique` ON `development_action_runs` (`decision_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_action_runs_single_writable` ON `development_action_runs` (`mission_id`) WHERE `writable` = 1 AND `status` IN ('claimed','materializing','running','validating','awaiting-effect');
--> statement-breakpoint
CREATE TABLE `development_agent_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `action_run_id` text NOT NULL REFERENCES `development_action_runs`(`id`),
  `rerun_seq` integer NOT NULL,
  `attempt_seq` integer NOT NULL,
  `execution_ref` text,
  `baseline_ref` text NOT NULL,
  `nonce_digest` text NOT NULL,
  `input_digest` text NOT NULL,
  `status` text NOT NULL,
  `rejection_json` text,
  `outcome_ref` text,
  `created_at` integer NOT NULL,
  `settled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_agent_attempts_ordinal_unique` ON `development_agent_attempts` (`action_run_id`, `rerun_seq`, `attempt_seq`);
--> statement-breakpoint
CREATE TABLE `development_effects` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `action_run_id` text,
  `effect_kind` text NOT NULL,
  `intent_digest` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `epoch` integer NOT NULL,
  `state` text NOT NULL DEFAULT 'prepared',
  `receipt_ref` text,
  `failure_json` text,
  `created_at` integer NOT NULL,
  `settled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_effects_idempotency_unique` ON `development_effects` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_dev_effects_mission_state` ON `development_effects` (`mission_id`, `state`);
--> statement-breakpoint
CREATE TABLE `development_feedback_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `thread_ref` text NOT NULL,
  `revision` text NOT NULL,
  `head_sha` text NOT NULL,
  `fingerprint` text NOT NULL,
  `author_class` text NOT NULL,
  `state` text NOT NULL DEFAULT 'observed',
  `action_run_id` text,
  `reply_effect_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_feedback_ledger_unique` ON `development_feedback_ledger` (`mission_id`, `thread_ref`, `revision`, `head_sha`);
--> statement-breakpoint
CREATE TABLE `development_bundle_refs` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `purpose` text NOT NULL,
  `evidence_ref` text NOT NULL,
  `manifest_digest` text NOT NULL,
  `file_count` integer NOT NULL,
  `total_bytes` integer NOT NULL,
  `retention_state` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dev_bundle_refs_mission` ON `development_bundle_refs` (`mission_id`);
--> statement-breakpoint
CREATE TABLE `legacy_code_work_item_links` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL REFERENCES `development_missions`(`id`),
  `legacy_work_item_id` text,
  `legacy_round_id` text,
  `cutover_receipt_json` text NOT NULL,
  `created_at` integer NOT NULL
);
