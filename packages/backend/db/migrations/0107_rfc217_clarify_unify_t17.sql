-- RFC-217 T8 — the real RFC-058 T17: drop the legacy clarify tables. Steps:
--   1) FIELD-LEVEL reconcile for overlapping ids (design-gate P1: pre-T7
--      repairs wrote only the legacy tables, so a same-id unified row can be
--      stale; the legacy row is the read-authority up to this migration, so
--      its lifecycle fields win — unified-only columns are untouched).
--   2) INSERT rows that exist ONLY in a legacy table (pre-0031 stragglers).
--   3) Fold the RFC-132 boot shims (clarifyMigration.ts) into one-time SQL:
--      3a) legacy immediate rounds: answered self/questioner task_questions
--          entries never marked dispatched get sealed+dispatched and bound to
--          their newest existing continuation run (no continuation → skip,
--          exactly the shim's invariant ②);
--      3b) legacy cross persistent-stop: a cross 'stop' with NO node-level
--          directive row gets one (never overwriting an existing row — a
--          canvas re-enable 'continue' must not be reverted).
--   4) DROP both legacy tables.
--   5) Rebuild clarify_rounds WITHOUT the dormant question_scopes_json column
--      (RFC-162 removed scopes; the column was never read since). The
--      `directive` column STAYS — it is the per-round disposition record
--      (design-gate P2: the node/shard toggle cannot express "this old round
--      was answered with stop"; dropping it would let a later 'continue'
--      revive designer rows from stopped rounds).
-- Codex impl-gate P2-1: `answered_by` is deliberately NOT in this SET — the
-- pre-T7 repair paths that created the divergence only maintained the legacy
-- lifecycle fields (answered_by stayed NULL there), while the unified row's
-- answered_by is real RFC-099 attribution that must survive the reconcile.
UPDATE `clarify_rounds`
SET
	`status` = (SELECT s.`status` FROM `clarify_sessions` s WHERE s.`id` = `clarify_rounds`.`id`),
	`answers_json` = (SELECT s.`answers_json` FROM `clarify_sessions` s WHERE s.`id` = `clarify_rounds`.`id`),
	`answered_at` = (SELECT s.`answered_at` FROM `clarify_sessions` s WHERE s.`id` = `clarify_rounds`.`id`),
	`directive` = (SELECT s.`directive` FROM `clarify_sessions` s WHERE s.`id` = `clarify_rounds`.`id`)
WHERE `kind` = 'self'
	AND EXISTS (
		SELECT 1 FROM `clarify_sessions` s
		WHERE s.`id` = `clarify_rounds`.`id`
			AND (
				s.`status` != `clarify_rounds`.`status`
				OR s.`answers_json` IS NOT `clarify_rounds`.`answers_json`
				OR s.`answered_at` IS NOT `clarify_rounds`.`answered_at`
				OR s.`directive` IS NOT `clarify_rounds`.`directive`
			)
	);
--> statement-breakpoint
UPDATE `clarify_rounds`
SET
	`status` = (SELECT c.`status` FROM `cross_clarify_sessions` c WHERE c.`id` = `clarify_rounds`.`id`),
	`answers_json` = (SELECT c.`answers_json` FROM `cross_clarify_sessions` c WHERE c.`id` = `clarify_rounds`.`id`),
	`answered_at` = (SELECT c.`answered_at` FROM `cross_clarify_sessions` c WHERE c.`id` = `clarify_rounds`.`id`),
	`directive` = (SELECT c.`directive` FROM `cross_clarify_sessions` c WHERE c.`id` = `clarify_rounds`.`id`),
	`designer_run_triggered_at` = (SELECT c.`designer_run_triggered_at` FROM `cross_clarify_sessions` c WHERE c.`id` = `clarify_rounds`.`id`)
WHERE `kind` = 'cross'
	AND EXISTS (
		SELECT 1 FROM `cross_clarify_sessions` c
		WHERE c.`id` = `clarify_rounds`.`id`
			AND (
				c.`status` != `clarify_rounds`.`status`
				OR c.`answers_json` IS NOT `clarify_rounds`.`answers_json`
				OR c.`answered_at` IS NOT `clarify_rounds`.`answered_at`
				OR c.`directive` IS NOT `clarify_rounds`.`directive`
				OR c.`designer_run_triggered_at` IS NOT `clarify_rounds`.`designer_run_triggered_at`
			)
	);
--> statement-breakpoint
INSERT INTO `clarify_rounds` (
	`id`, `task_id`, `kind`,
	`asking_node_id`, `asking_node_run_id`, `asking_shard_key`,
	`intermediary_node_id`, `intermediary_node_run_id`, `target_consumer_node_id`,
	`loop_iter`, `iteration`,
	`questions_json`, `answers_json`, `directive`, `status`,
	`truncation_warnings_json`,
	`designer_run_triggered_at`, `abandoned_at`,
	`created_at`, `answered_at`, `answered_by`
)
SELECT
	`id`, `task_id`, 'self',
	`source_agent_node_id`, `source_agent_node_run_id`, `source_shard_key`,
	`clarify_node_id`, `clarify_node_run_id`, NULL,
	0, `iteration_index`,
	`questions_json`, `answers_json`, `directive`, `status`,
	`truncation_warnings_json`,
	NULL, NULL,
	`created_at`, `answered_at`, `answered_by`
FROM `clarify_sessions`
WHERE `id` NOT IN (SELECT `id` FROM `clarify_rounds`);
--> statement-breakpoint
INSERT INTO `clarify_rounds` (
	`id`, `task_id`, `kind`,
	`asking_node_id`, `asking_node_run_id`, `asking_shard_key`,
	`intermediary_node_id`, `intermediary_node_run_id`, `target_consumer_node_id`,
	`loop_iter`, `iteration`,
	`questions_json`, `answers_json`, `directive`, `status`,
	`truncation_warnings_json`,
	`designer_run_triggered_at`, `abandoned_at`,
	`created_at`, `answered_at`, `answered_by`
)
SELECT
	`id`, `task_id`, 'cross',
	`source_questioner_node_id`, `source_questioner_node_run_id`, NULL,
	`cross_clarify_node_id`, `cross_clarify_node_run_id`, `target_designer_node_id`,
	`loop_iter`, `iteration`,
	`questions_json`, `answers_json`, `directive`, `status`,
	NULL,
	`designer_run_triggered_at`, `abandoned_at`,
	`created_at`, `answered_at`, NULL
FROM `cross_clarify_sessions`
WHERE `id` NOT IN (SELECT `id` FROM `clarify_rounds`);
--> statement-breakpoint
UPDATE `task_questions`
SET
	`sealed_at` = unixepoch() * 1000,
	`sealed_by` = 'rfc132-migration',
	`dispatched_at` = unixepoch() * 1000,
	`dispatched_by` = 'rfc132-migration',
	`trigger_run_id` = (
		SELECT nr.`id` FROM `node_runs` nr
		JOIN `clarify_rounds` r ON r.`intermediary_node_run_id` = `task_questions`.`origin_node_run_id`
		WHERE nr.`task_id` = r.`task_id`
			AND nr.`node_id` = r.`asking_node_id`
			AND nr.`iteration` = r.`iteration`
			AND nr.`parent_node_run_id` IS NULL
			AND nr.`rerun_cause` = CASE `task_questions`.`role_kind` WHEN 'self' THEN 'clarify-answer' ELSE 'cross-clarify-questioner-rerun' END
		ORDER BY nr.`id` DESC
		LIMIT 1
	),
	`updated_at` = unixepoch() * 1000
WHERE `dispatched_at` IS NULL
	AND `role_kind` IN ('self', 'questioner')
	AND EXISTS (
		SELECT 1 FROM `clarify_rounds` r
		WHERE r.`intermediary_node_run_id` = `task_questions`.`origin_node_run_id`
			AND r.`status` = 'answered'
	)
	AND (
		SELECT nr.`id` FROM `node_runs` nr
		JOIN `clarify_rounds` r ON r.`intermediary_node_run_id` = `task_questions`.`origin_node_run_id`
		WHERE nr.`task_id` = r.`task_id`
			AND nr.`node_id` = r.`asking_node_id`
			AND nr.`iteration` = r.`iteration`
			AND nr.`parent_node_run_id` IS NULL
			AND nr.`rerun_cause` = CASE `task_questions`.`role_kind` WHEN 'self' THEN 'clarify-answer' ELSE 'cross-clarify-questioner-rerun' END
	) IS NOT NULL;
--> statement-breakpoint
INSERT INTO `task_node_clarify_directives` (`task_id`, `node_id`, `shard_key`, `directive`, `updated_at`)
SELECT DISTINCT c.`task_id`, c.`source_questioner_node_id`, '', 'stop', unixepoch() * 1000
FROM `cross_clarify_sessions` c
WHERE c.`directive` = 'stop'
	AND NOT EXISTS (
		SELECT 1 FROM `task_node_clarify_directives` d
		WHERE d.`task_id` = c.`task_id`
			AND d.`node_id` = c.`source_questioner_node_id`
			-- Codex impl-gate P2-2: only the GLOBAL row counts as coverage —
			-- resolveCrossNodeStopped reads shard-less (node-level); a
			-- shard-scoped row must not suppress the global stop backfill.
			AND d.`shard_key` = ''
	);
--> statement-breakpoint
DROP TABLE `clarify_sessions`;
--> statement-breakpoint
DROP TABLE `cross_clarify_sessions`;
--> statement-breakpoint
CREATE TABLE `__new_clarify_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('self', 'cross')),
	`asking_node_id` text NOT NULL,
	`asking_node_run_id` text NOT NULL,
	`asking_shard_key` text,
	`intermediary_node_id` text NOT NULL,
	`intermediary_node_run_id` text NOT NULL,
	`target_consumer_node_id` text,
	`loop_iter` integer NOT NULL DEFAULT 0,
	`iteration` integer NOT NULL DEFAULT 0,
	`questions_json` text NOT NULL,
	`answers_json` text,
	`directive` text CHECK (`directive` IS NULL OR `directive` IN ('continue', 'stop')),
	`status` text NOT NULL DEFAULT 'awaiting_human'
		CHECK (`status` IN ('awaiting_human', 'answered', 'canceled', 'abandoned')),
	`truncation_warnings_json` text,
	`designer_run_triggered_at` integer,
	`abandoned_at` integer,
	`created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	`answered_at` integer,
	`answered_by` text,
	`submitted_by_role` text,
	`answer_attributions_json` text,
	`draft_answers_json` text,
	CHECK (
		(`kind` = 'self'  AND `status` != 'abandoned') OR
		(`kind` = 'cross' AND `status` != 'canceled')
	),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`intermediary_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asking_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_clarify_rounds` (
	`id`, `task_id`, `kind`,
	`asking_node_id`, `asking_node_run_id`, `asking_shard_key`,
	`intermediary_node_id`, `intermediary_node_run_id`, `target_consumer_node_id`,
	`loop_iter`, `iteration`,
	`questions_json`, `answers_json`, `directive`, `status`,
	`truncation_warnings_json`, `designer_run_triggered_at`, `abandoned_at`,
	`created_at`, `answered_at`, `answered_by`,
	`submitted_by_role`, `answer_attributions_json`, `draft_answers_json`
)
SELECT
	`id`, `task_id`, `kind`,
	`asking_node_id`, `asking_node_run_id`, `asking_shard_key`,
	`intermediary_node_id`, `intermediary_node_run_id`, `target_consumer_node_id`,
	`loop_iter`, `iteration`,
	`questions_json`, `answers_json`, `directive`, `status`,
	`truncation_warnings_json`, `designer_run_triggered_at`, `abandoned_at`,
	`created_at`, `answered_at`, `answered_by`,
	`submitted_by_role`, `answer_attributions_json`, `draft_answers_json`
FROM `clarify_rounds`;
--> statement-breakpoint
DROP TABLE `clarify_rounds`;
--> statement-breakpoint
ALTER TABLE `__new_clarify_rounds` RENAME TO `clarify_rounds`;
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_task` ON `clarify_rounds` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_kind_status` ON `clarify_rounds` (`kind`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_asking` ON `clarify_rounds` (`asking_node_id`, `loop_iter`, `iteration`);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_intermediary` ON `clarify_rounds` (`intermediary_node_id`, `loop_iter`, `iteration`);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_target_consumer` ON `clarify_rounds` (`target_consumer_node_id`, `loop_iter`, `iteration`);
