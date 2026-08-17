-- RFC-308 — hard cut from repository-mutating `.gitignore` preset commits to
-- per-worktree platform exclude profiles. The two nullable receipt columns
-- record which profile was installed for new task repositories; legacy rows
-- remain NULL. `gitignore_commit` has no runtime reader after this migration.

ALTER TABLE `task_repos` ADD COLUMN `workspace_profile_version` integer;
--> statement-breakpoint
ALTER TABLE `task_repos` ADD COLUMN `workspace_profile_digest` text;
--> statement-breakpoint
ALTER TABLE `task_repos` DROP COLUMN `gitignore_commit`;
