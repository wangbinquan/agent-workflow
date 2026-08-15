-- RFC-304 PR-4b — the findings ledger.
--
-- One row per (finding, generation) on one anchor. This is what makes a review
-- CONTINUOUS rather than a fresh opinion every push: without it, round two
-- reposts everything round one already said, and an MR that saw ten pushes
-- carries ten copies of the same remark.
--
-- Identity note: the unique key is
-- (endpoint, stable_project_id, anchor_kind, anchor_id, fingerprint, generation)
-- and deliberately does NOT include work_item_id. A finding belongs to the MR,
-- not to the work item that happened to observe it — keying it to the work item
-- would detach the whole history the day a work item is rebuilt, and the
-- rebuilt one would then republish every finding as new.
--
-- `generation` is in the key for one specific case: a finding that disappeared
-- and came back. Its old thread was already resolved or annotated, so the
-- return has to be a NEW thread; the old row stays as history rather than being
-- overwritten, which is also what lets "this keeps coming back" be answerable.
--
-- Lifecycle (see domain/findingReconcile.ts):
--   active ──absent this round──► disappeared ──seen again──► reappeared
-- The provider action fires only on the ACTIVE→DISAPPEARED edge. Firing it on
-- every subsequent round is what produced 78 identical "no longer present"
-- replies on one long-lived MR.
CREATE TABLE `code_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`code_host_endpoint_id` text NOT NULL,
	`stable_project_id` text NOT NULL,
	`anchor_kind` text NOT NULL CHECK (`anchor_kind` IN ('mr','issue','pipeline')),
	`anchor_id` text NOT NULL,
	`capability` text NOT NULL,
	`fingerprint` text NOT NULL,
	`generation` integer NOT NULL DEFAULT 1,
	`lifecycle` text NOT NULL DEFAULT 'active' CHECK (`lifecycle` IN ('active','disappeared','reappeared')),
	`severity` text,
	`title` text,
	`file_path` text,
	`anchor_line` integer,
	`external_id` text,
	`published_round_id` text,
	`disappeared_round_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_code_finding_identity` ON `code_findings` (`code_host_endpoint_id`,`stable_project_id`,`anchor_kind`,`anchor_id`,`fingerprint`,`generation`);
--> statement-breakpoint
CREATE INDEX `idx_code_findings_anchor` ON `code_findings` (`code_host_endpoint_id`,`stable_project_id`,`anchor_kind`,`anchor_id`,`lifecycle`);
--> statement-breakpoint
CREATE INDEX `idx_code_findings_seen` ON `code_findings` (`stable_project_id`,`last_seen_at`);
