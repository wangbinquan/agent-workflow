-- RFC-058 — unify clarify_sessions (RFC-023) and cross_clarify_sessions
-- (RFC-056) into a single `clarify_rounds` table with a `kind` discriminator.
-- STAGE 1 (this migration): build the new table + copy every row from both
-- old tables. The old tables are LEFT IN PLACE so services that still read
-- from them keep working through the staged refactor. A follow-up migration
-- (0032) drops the legacy tables once all callsites switch to clarify_rounds.
--
-- The platform is pre-prod (no live user data), so the dual-table window is
-- a few dev iterations long; the staged approach trades the plan's pure
-- "hard-cut" framing for incremental landing safety.
--
-- The DB CHECK constraint enforces the cross-domain rule that 'canceled' is
-- reachable only when kind='self' (RFC-023 task-cancel path) and 'abandoned'
-- only when kind='cross' (RFC-056 CR-1 invariant upgrade); application code
-- no longer needs to re-validate that pairing on every write.
--
-- session_mode is NOT stored on the row — RFC-026 keeps it on the clarify
-- node definition (looked up via workflow snapshot). Migration drops the
-- column rather than back-filling it.
CREATE TABLE `clarify_rounds` (
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
  -- Cross-domain rule (Q2 from RFC-058 design.md §3.1):
  --   self  never reaches abandoned (CR-1 invariant is cross-only)
  --   cross never reaches canceled (task-cancel path is self-only)
  CHECK (
    (`kind` = 'self'  AND `status` != 'abandoned') OR
    (`kind` = 'cross' AND `status` != 'canceled')
  ),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`intermediary_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`asking_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_task` ON `clarify_rounds` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_kind_status` ON `clarify_rounds` (`kind`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_asking` ON `clarify_rounds` (`asking_node_id`, `loop_iter`, `iteration`);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_intermediary` ON `clarify_rounds` (`intermediary_node_id`, `loop_iter`, `iteration`);
--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_target_consumer` ON `clarify_rounds` (`target_consumer_node_id`, `status`);
--> statement-breakpoint
-- Migrate RFC-023 self-clarify rows. `iteration_index` becomes the unified
-- `iteration`; the asking agent is also the consumer (target_consumer_node_id
-- = NULL). All self rows live outside wrapper-loop semantics: loop_iter=0.
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
FROM `clarify_sessions`;
--> statement-breakpoint
-- Migrate RFC-056 cross-clarify rows. questioner = asking; designer = target
-- consumer. agent-single only (asking_shard_key always NULL). truncation
-- warnings were not persisted on cross_clarify_sessions; back-fill as NULL.
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
FROM `cross_clarify_sessions`;
-- STAGE 1: old tables are left in place. Follow-up migration 0032
-- (rfc058_clarify_rounds_drop_legacy) will DROP them after services migrate
-- to read/write `clarify_rounds`.
