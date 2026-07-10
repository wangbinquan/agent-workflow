-- RFC-165 — unified task creation, migration 1 of 2 (hand-written; registered
-- in meta/_journal.json).
--
-- `space_kind` backfill rules (design §1):
--   * 'local'    — any task with a path-mode repo: top-level repo_url IS NULL
--                  OR any task_repos row with repo_url IS NULL (mixed multi-repo
--                  tasks must not be mislabeled 'remote' — F20).
--   * 'internal' — fusion framework tasks, matched by the canonical builtin
--                  fusion workflow name ONLY (a bare `builtin = 1` predicate
--                  would mislabel __workgroup_host__ tasks — F4-r3); workgroup
--                  tasks are excluded explicitly. The literal 'aw-skill-fusion'
--                  is locked against SKILL_FUSION_WORKFLOW_NAME by a migration
--                  test (SQL cannot import TS constants — design §15.5).
--   * 'remote'   — column default; every other existing row.
-- New scratch/internal rows are written by the service layer after this ships.
ALTER TABLE `tasks` ADD `space_kind` text NOT NULL DEFAULT 'remote';
--> statement-breakpoint
UPDATE `tasks` SET `space_kind` = 'local'
WHERE `repo_url` IS NULL
   OR EXISTS (SELECT 1 FROM `task_repos` tr WHERE tr.`task_id` = `tasks`.`id` AND tr.`repo_url` IS NULL);
--> statement-breakpoint
UPDATE `tasks` SET `space_kind` = 'internal'
WHERE `workgroup_id` IS NULL
  AND `workflow_id` IN (SELECT `id` FROM `workflows` WHERE `builtin` = 1 AND `name` = 'aw-skill-fusion');
--> statement-breakpoint
ALTER TABLE `tasks` ADD `source_agent_name` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `workspace_pruning_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `workspace_pruned_at` integer;
--> statement-breakpoint
DROP TABLE IF EXISTS `recent_repos`;
