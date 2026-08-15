-- RFC-304 PR-1a — the code-capability aggregate: work items, their rounds, each
-- round's stages, and one row per AI call.
--
-- Identity note (code_work_items): the unique key is
-- (endpoint, stable_project_id, capability, anchor_kind, anchor_id) and
-- deliberately NOT the repository path. Paths are mutable — rename or transfer a
-- project and the same MR would hash to a new key, detaching its ledger, its
-- dedup chain and its supersede relation; conversely two hosts sharing a path
-- would merge into one item. RFC-303 solved this with the stable numeric project
-- id plus the endpoint id, and this follows it.
--
-- All cross-context ids here (task_id, node_run_id, initiator_user_id) are SOFT
-- references: deleting a task or a user must never cascade away the record of
-- what the platform did on someone's MR.
CREATE TABLE `code_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`code_host_endpoint_id` text NOT NULL,
	`stable_project_id` text NOT NULL,
	`capability` text NOT NULL,
	`anchor_kind` text NOT NULL CHECK (`anchor_kind` IN ('mr','issue','pipeline')),
	`anchor_id` text NOT NULL,
	`status` text NOT NULL DEFAULT 'idle' CHECK (`status` IN ('idle','queued','running','awaiting','settled','failed','superseding','handed_off','closing','closed')),
	`epoch` integer NOT NULL DEFAULT 1 CHECK (`epoch` >= 1),
	`current_round_id` text,
	`pending_generation` integer,
	`handed_off_fingerprint` text,
	`anchor_meta` text,
	`initiator_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_code_work_items_identity`
ON `code_work_items` (`code_host_endpoint_id`,`stable_project_id`,`capability`,`anchor_kind`,`anchor_id`);--> statement-breakpoint
CREATE INDEX `idx_code_work_items_status`
ON `code_work_items` (`status`);--> statement-breakpoint
CREATE INDEX `idx_code_work_items_anchor`
ON `code_work_items` (`code_host_endpoint_id`,`stable_project_id`,`anchor_kind`,`anchor_id`);--> statement-breakpoint

CREATE TABLE `code_work_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`round_seq` integer NOT NULL CHECK (`round_seq` >= 1),
	`epoch` integer NOT NULL CHECK (`epoch` >= 1),
	`task_id` text,
	`baseline_sha` text,
	`work_package` text,
	`template_snapshot` text,
	`stage_contract_ver` integer NOT NULL DEFAULT 1,
	`outcome` text CHECK (`outcome` IS NULL OR `outcome` IN ('published','awaiting','failed','canceled','superseded')),
	`started_at` integer NOT NULL,
	`ended_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_code_work_rounds_seq`
ON `code_work_rounds` (`work_item_id`,`round_seq`);--> statement-breakpoint
CREATE INDEX `idx_code_work_rounds_item`
ON `code_work_rounds` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_code_work_rounds_task`
ON `code_work_rounds` (`task_id`);--> statement-breakpoint

CREATE TABLE `code_round_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`stage_seq` integer NOT NULL CHECK (`stage_seq` >= 0),
	`stage_name` text NOT NULL,
	`stage_kind` text NOT NULL CHECK (`stage_kind` IN ('program','script','ai','invoke')),
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','running','done','failed','skipped','inherited')),
	`counts_json` text,
	`error` text,
	`started_at` integer,
	`ended_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_code_round_stages_seq`
ON `code_round_stages` (`round_id`,`stage_seq`);--> statement-breakpoint
CREATE INDEX `idx_code_round_stages_round`
ON `code_round_stages` (`round_id`);--> statement-breakpoint

-- One row per AI call. `rerun_seq` counts fresh-session re-runs, `attempt_seq`
-- counts same-session retries; the pair plus shard_key is what lets a reader
-- reconstruct "this shard retried twice, then re-ran in a new session". Recovery
-- must settle a dangling attempt to 'interrupted' BEFORE allocating the next
-- attempt_seq — a daemon that died before writing validation_outcome would
-- otherwise mint a duplicate row and race the seq allocation.
CREATE TABLE `code_ai_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`shard_key` text NOT NULL DEFAULT '',
	`rerun_seq` integer NOT NULL DEFAULT 0 CHECK (`rerun_seq` >= 0),
	`attempt_seq` integer NOT NULL DEFAULT 0 CHECK (`attempt_seq` >= 0),
	`status` text NOT NULL DEFAULT 'claimed' CHECK (`status` IN ('claimed','running','validated','failed','interrupted')),
	`validation_outcome` text,
	`session_ref` text,
	`node_run_id` text,
	`started_at` integer NOT NULL,
	`ended_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_code_ai_attempts_identity`
ON `code_ai_attempts` (`round_id`,`stage_name`,`shard_key`,`rerun_seq`,`attempt_seq`);--> statement-breakpoint
CREATE INDEX `idx_code_ai_attempts_round`
ON `code_ai_attempts` (`round_id`);--> statement-breakpoint
CREATE INDEX `idx_code_ai_attempts_status`
ON `code_ai_attempts` (`status`);
