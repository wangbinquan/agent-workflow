-- RFC-285 T5（B2/E2）—— `tasks.workflow_id` 的 FK 软链化（12-step rebuild）。
--
-- 为什么：B2 把 workflow 删除放宽为「只拒非终态引用」后，仅被历史（终态）任务
-- 引用的 workflow 允许删除——但 `tasks.workflow_id` 是 NOT NULL 硬 FK，应用层
-- 放行后 DELETE 直接 SQLITE_CONSTRAINT 500。对齐 `workgroup_id`「durable soft
-- link, no FK」先例：列保持 NOT NULL（软链仍必填，只是不再强制存在性），终态
-- 任务详情容忍悬空 workflow 引用（与 agent 删除后同型）。
--
-- 语序采 0117/0132 的 rename-first 模板；tasks 有 14 条入向 FK（node_runs /
-- doc_versions / task_collaborators / clarify_rounds …）+ parent_task_id 自引用，
-- 本仓迁移 runner 恒以 `PRAGMA foreign_keys=OFF` 执行（db/client.ts RFC-115 注：
-- drizzle 单事务内 pragma 不生效，故在事务外先关）——实测该模式下 RENAME **不
-- 改写**其他表的引用文本（引用仍写 `tasks`），先改名旧表、再建终名新表后，全部
-- 入向 FK 自然指向新表；FK ON 模式会改写引用（危险语序），本迁移不在该模式下跑。
--
-- DROP 旧表前做行数一致断言（0132 的「CHECK 临时表 + 条件 INSERT」原语）。
--
-- ⚠ 内联 pragma 三明治（0019/0035/0057 既有先例）：本仓存在**事务外 FK ON**
-- 的重放语境（snapshot 构建 / 迁移测试的 raw 重放）——该模式下 RENAME 会把
-- 14 个子表的引用文本改写成 `__old_tasks`（2a8fce6b 门禁 snapshot-parity 实锤）。
-- 显式 OFF 后 rename 不改写；daemon runner 本就事务内（pragma no-op、恒 OFF）。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TEMP TABLE `__rfc285_assert` (`ok` integer NOT NULL CHECK (`ok` = 1));--> statement-breakpoint
ALTER TABLE `tasks` RENAME TO `__old_tasks`;--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_snapshot` text NOT NULL,
	`repo_path` text NOT NULL,
	`worktree_path` text NOT NULL,
	`base_branch` text NOT NULL,
	`branch` text NOT NULL,
	`status` text NOT NULL,
	`inputs` text NOT NULL,
	`max_duration_ms` integer,
	`max_total_tokens` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error_summary` text,
	`error_message` text,
	`failed_node_id` text,
	`expires_at` integer,
	`deleted_at` integer,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`base_commit` text,
	`repo_url` text,
	`owner_user_id` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	`name` text,
	`git_user_name` text,
	`git_user_email` text,
	`repo_count` integer NOT NULL DEFAULT 1,
	`working_branch` text,
	`auto_commit_push` integer DEFAULT 0 NOT NULL,
	`workflow_version` integer,
	`auto_recovery_attempts` integer DEFAULT 0 NOT NULL,
	`auto_recovery_suspended` integer DEFAULT 0 NOT NULL,
	`auto_recovery_window_started_at` integer,
	`scheduled_task_id` text,
	`workgroup_id` text,
	`workgroup_config_json` text,
	`space_kind` text NOT NULL DEFAULT 'remote',
	`source_agent_name` text,
	`workspace_pruning_at` integer,
	`workspace_pruned_at` integer,
	`source_agent_id` text,
	`cached_repo_id` text,
	`running_ms` integer DEFAULT 0 NOT NULL,
	`running_since` integer,
	`parent_task_id` text REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	`parent_node_run_id` text,
	`invocation_depth` integer NOT NULL DEFAULT 0,
	`ref_closure_json` text,
	`repo_group_id` text,
	`repo_group_name` text,
	`webhook_trigger_id` text,
	`webhook_fire_id` text,
	`trigger_context_json` text
);--> statement-breakpoint
INSERT INTO `tasks` (
	`id`, `workflow_id`, `workflow_snapshot`, `repo_path`, `worktree_path`,
	`base_branch`, `branch`, `status`, `inputs`, `max_duration_ms`,
	`max_total_tokens`, `started_at`, `finished_at`, `error_summary`,
	`error_message`, `failed_node_id`, `expires_at`, `deleted_at`,
	`schema_version`, `base_commit`, `repo_url`, `owner_user_id`, `name`,
	`git_user_name`, `git_user_email`, `repo_count`, `working_branch`,
	`auto_commit_push`, `workflow_version`, `auto_recovery_attempts`,
	`auto_recovery_suspended`, `auto_recovery_window_started_at`,
	`scheduled_task_id`, `workgroup_id`, `workgroup_config_json`, `space_kind`,
	`source_agent_name`, `workspace_pruning_at`, `workspace_pruned_at`,
	`source_agent_id`, `cached_repo_id`, `running_ms`, `running_since`,
	`parent_task_id`, `parent_node_run_id`, `invocation_depth`,
	`ref_closure_json`, `repo_group_id`, `repo_group_name`,
	`webhook_trigger_id`, `webhook_fire_id`, `trigger_context_json`
)
SELECT
	`id`, `workflow_id`, `workflow_snapshot`, `repo_path`, `worktree_path`,
	`base_branch`, `branch`, `status`, `inputs`, `max_duration_ms`,
	`max_total_tokens`, `started_at`, `finished_at`, `error_summary`,
	`error_message`, `failed_node_id`, `expires_at`, `deleted_at`,
	`schema_version`, `base_commit`, `repo_url`, `owner_user_id`, `name`,
	`git_user_name`, `git_user_email`, `repo_count`, `working_branch`,
	`auto_commit_push`, `workflow_version`, `auto_recovery_attempts`,
	`auto_recovery_suspended`, `auto_recovery_window_started_at`,
	`scheduled_task_id`, `workgroup_id`, `workgroup_config_json`, `space_kind`,
	`source_agent_name`, `workspace_pruning_at`, `workspace_pruned_at`,
	`source_agent_id`, `cached_repo_id`, `running_ms`, `running_since`,
	`parent_task_id`, `parent_node_run_id`, `invocation_depth`,
	`ref_closure_json`, `repo_group_id`, `repo_group_name`,
	`webhook_trigger_id`, `webhook_fire_id`, `trigger_context_json`
FROM `__old_tasks`;--> statement-breakpoint
INSERT INTO `__rfc285_assert` (`ok`)
SELECT CASE
	WHEN (SELECT COUNT(*) FROM `tasks`) = (SELECT COUNT(*) FROM `__old_tasks`)
	THEN 1 ELSE 0
END;--> statement-breakpoint
DROP TABLE `__old_tasks`;--> statement-breakpoint
DROP TABLE `__rfc285_assert`;--> statement-breakpoint
CREATE INDEX `idx_tasks_workflow` ON `tasks` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_scheduled_task` ON `tasks` (`scheduled_task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_workgroup` ON `tasks` (`workgroup_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_list_started_id` ON `tasks` (`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_list_status_started_id` ON `tasks` (`status`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_list_parent_started_id` ON `tasks` (`parent_task_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_list_owner_started_id` ON `tasks` (`owner_user_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_webhook_trigger` ON `tasks` (`webhook_trigger_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
