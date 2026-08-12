-- RFC-285 T5（B2/E2）—— `tasks.workflow_id` 的 FK 软链化（12-step rebuild）。
--
-- 为什么：B2 把 workflow 删除放宽为「只拒非终态引用」后，仅被历史（终态）任务
-- 引用的 workflow 允许删除——但 `tasks.workflow_id` 是 NOT NULL 硬 FK，应用层
-- 放行后 DELETE 直接 SQLITE_CONSTRAINT 500。对齐 `workgroup_id`「durable soft
-- link, no FK」先例：列保持 NOT NULL（软链仍必填，只是不再强制存在性），终态
-- 任务详情容忍悬空 workflow 引用（与 agent 删除后同型）。
--
-- 语序与 pragma（RFC-285 实现门 P1-1 定稿，双保险）：tasks 有 14 条入向 FK
-- （node_runs / doc_versions / task_collaborators / clarify_rounds …）+
-- parent_task_id 自引用，而 ALTER TABLE RENAME 是否改写其他表引用文本随
-- SQLite 版本/构建漂移——macOS bun:sqlite 在 foreign_keys=OFF 下不改写、
-- **Linux bun:sqlite 同 pragma 下仍改写**（849cfd91 ubuntu CI 实锤）。因此：
--   ① **官方 12-step 反序**（建新临时名 → 搬运 → drop 旧 → rename 新到终名，
--     sqlite.org/lang_altertable 推荐序）：唯一的 RENAME 只作用于**零入向引用
--     的临时名** `__new_tasks`，两种改写语义下子表引用文本都保持 `tasks`；
--   ② 迁移期临时 `legacy_alter_table=ON`（该 pragma 可在事务内生效，与
--     foreign_keys 不同）：即便未来语序被改回 rename-first，也不会改写引用；
--     结束前恢复 OFF，避免连接级设置泄漏到后续 DDL（测试锁定不泄漏契约）。
-- foreign_keys 三明治（0019/0035/0057 先例）保证事务外 raw 重放语境下 DROP
-- 不触发级联；daemon runner 本就事务外先 OFF（db/client.ts RFC-115 注），
-- 事务内该 pragma no-op 无害。DROP 旧表前做行数一致断言（0132 的「CHECK
-- 临时表 + 条件 INSERT」原语）。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
PRAGMA legacy_alter_table=ON;--> statement-breakpoint
CREATE TEMP TABLE `__rfc285_assert` (`ok` integer NOT NULL CHECK (`ok` = 1));--> statement-breakpoint
CREATE TABLE `__new_tasks` (
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
INSERT INTO `__new_tasks` (
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
FROM `tasks`;--> statement-breakpoint
INSERT INTO `__rfc285_assert` (`ok`)
SELECT CASE
	WHEN (SELECT COUNT(*) FROM `__new_tasks`) = (SELECT COUNT(*) FROM `tasks`)
	THEN 1 ELSE 0
END;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA legacy_alter_table=OFF;--> statement-breakpoint
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
