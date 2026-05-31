-- RFC-075 — Task working branch + framework-managed auto commit&push.
--
-- Two orthogonal, independently-toggled capabilities, all columns additive
-- and backward compatible:
--
--   * `tasks.working_branch` (nullable TEXT): the user-specified working
--     branch name. NULL → the task uses the framework default isolation
--     branch `agent-workflow/{taskId}` (byte-identical to pre-RFC-075).
--     When set, `tasks.branch` equals this value; the column is kept
--     separately only to distinguish "user picked this" from "framework
--     default" and to render it on the detail page.
--
--   * `tasks.auto_commit_push` (INTEGER NOT NULL DEFAULT 0): the commit&push
--     toggle. 0 → no commit/push ever (legacy behavior). 1 → after each
--     writer agent emits its final output the framework commits all changes
--     (LLM-summarized message) and pushes. Defaulted to 0 so every existing
--     row and every launch that omits the flag stays byte-for-byte unchanged.
--
--   * `task_repos.working_branch` (nullable TEXT): multi-repo (RFC-066)
--     mirror of `tasks.working_branch`; the single working-branch name is
--     applied to every repo's worktree.
--
--   * `node_runs.commit_push_json` (nullable TEXT): JSON metadata recorded on
--     a framework-synthesized commit&push node_run (commit SHA / push target
--     / outcome / repair count). Non-NULL presence marks the row as a commit
--     node for the detail-page commit row. NULL on every regular node_run and
--     all pre-RFC-075 rows.
--
-- Historical rows: working_branch / commit_push_json default NULL,
-- auto_commit_push defaults 0 — "recovered" old tasks (RFC-042 retry,
-- resumeTask after daemon restart) read these and behave exactly as before.
--
-- See design/RFC-075-task-working-branch-auto-commit-push/design.md §2.
ALTER TABLE `tasks` ADD COLUMN `working_branch` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `auto_commit_push` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `task_repos` ADD COLUMN `working_branch` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `commit_push_json` text;
