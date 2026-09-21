-- RFC-366 T3 —— `source_kind` 值域扩容：加入 `agent-run` / `task-run`。
--
-- 为什么要整表重建：这两列的值域是 SQLite 的 CHECK 约束，而 CHECK 写死在表的
-- DDL 文本里，`ALTER TABLE` 没有任何修改它的语法。官方的 12-step rebuild 是
-- 唯一路径（sqlite.org/lang_altertable）。
--
-- 语序与 pragma 沿用 0151_rfc285_workflow_soft_link.sql 定稿的双保险（RFC-285
-- 实现门 P1-1，那里有完整推导）：
--   ① **12-step 反序**——建临时名 → 搬运 → drop 旧 → rename 临时名到终名。唯一
--     的 RENAME 只作用于零入向引用的 `__new_*`，无论 SQLite 构建是否改写子表
--     FK 文本，`memory_distill_events.distill_job_id` 的引用文本都保持
--     `memory_distill_jobs`（macOS / Linux 的 bun:sqlite 在 foreign_keys=OFF
--     下行为不同，849cfd91 有实锤）；
--   ② 迁移期 `legacy_alter_table=ON`，即便未来语序被改回 rename-first 也不改写引用。
-- `memories` 还有两条**自引用** FK（supersedes_id / superseded_by_id → memories）：
-- 新表 DDL 里它们按终名 `memories` 写，DROP + RENAME 之后自然指向自己，不需要特殊处理。
--
-- foreign_keys 三明治（0019/0035/0057 先例）保证 DROP 不触发级联——
-- `memory_distill_events` 对 jobs 是 ON DELETE CASCADE，不关它会把捕获的会话全删光。
-- DROP 旧表前做行数一致断言（0132 的「CHECK 临时表 + 条件 INSERT」原语）。
--
-- 存量行不回填、不改写：老 job / 老候选的 source_kind 原样搬过去。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
PRAGMA legacy_alter_table=ON;--> statement-breakpoint
CREATE TEMP TABLE `__rfc366_assert` (`ok` integer NOT NULL CHECK (`ok` = 1));--> statement-breakpoint

CREATE TABLE `__new_memory_distill_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`debounce_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_event_id` text NOT NULL,
	`task_id` text,
	`scope_resolved_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`opencode_session_id` text,
	`user_prompt_md` text,
	`exit_code` integer,
	`stderr_excerpt` text,
	`dedup_snapshot_ids_json` text,
	`output_lang` text,
	CHECK (`source_kind` IN ('clarify','review','feedback','agent-run','task-run')),
	CHECK (`status` IN ('pending','running','done','failed','canceled'))
);--> statement-breakpoint
INSERT INTO `__new_memory_distill_jobs` (
	`id`, `debounce_key`, `source_kind`, `source_event_id`, `task_id`,
	`scope_resolved_json`, `status`, `attempts`, `next_run_at`, `last_error`,
	`created_at`, `started_at`, `finished_at`, `opencode_session_id`,
	`user_prompt_md`, `exit_code`, `stderr_excerpt`, `dedup_snapshot_ids_json`,
	`output_lang`
)
SELECT
	`id`, `debounce_key`, `source_kind`, `source_event_id`, `task_id`,
	`scope_resolved_json`, `status`, `attempts`, `next_run_at`, `last_error`,
	`created_at`, `started_at`, `finished_at`, `opencode_session_id`,
	`user_prompt_md`, `exit_code`, `stderr_excerpt`, `dedup_snapshot_ids_json`,
	`output_lang`
FROM `memory_distill_jobs`;--> statement-breakpoint
INSERT INTO `__rfc366_assert` (`ok`)
SELECT CASE
	WHEN (SELECT COUNT(*) FROM `__new_memory_distill_jobs`) = (SELECT COUNT(*) FROM `memory_distill_jobs`)
	THEN 1 ELSE 0
END;--> statement-breakpoint
DROP TABLE `memory_distill_jobs`;--> statement-breakpoint
ALTER TABLE `__new_memory_distill_jobs` RENAME TO `memory_distill_jobs`;--> statement-breakpoint
CREATE INDEX `idx_distill_jobs_status_next` ON `memory_distill_jobs` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_distill_jobs_debounce` ON `memory_distill_jobs` (`debounce_key`,`status`);--> statement-breakpoint
CREATE INDEX `idx_distill_jobs_task` ON `memory_distill_jobs` (`task_id`,`source_kind`);--> statement-breakpoint

CREATE TABLE `__new_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_event_id` text,
	`source_task_id` text,
	`distill_job_id` text,
	`distill_action` text,
	`supersedes_id` text,
	`superseded_by_id` text,
	`approved_by_user_id` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`fused_into_skill` text,
	`fused_into_skill_id` text,
	`fused_into_skill_version` integer,
	`fused_at` integer,
	`fused_by_user_id` text,
	`fused_fusion_id` text,
	CHECK (`scope_type` IN ('agent','workflow','repo','repo_group','global')),
	CHECK (`status` IN ('candidate','approved','archived','superseded','rejected','fused')),
	CHECK (`source_kind` IN ('clarify','review','feedback','agent-run','task-run','manual')),
	CHECK (`distill_action` IS NULL OR `distill_action` IN ('new','update_of','duplicate_of','conflict_with')),
	CHECK (
		(`scope_type` = 'global' AND `scope_id` IS NULL) OR
		(`scope_type` != 'global' AND `scope_id` IS NOT NULL)
	),
	CHECK ((`status` = 'fused') = (`fused_into_skill` IS NOT NULL)),
	CHECK ((`status` = 'fused') = (`fused_into_skill_id` IS NOT NULL)),
	FOREIGN KEY (`supersedes_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_memories` (
	`id`, `scope_type`, `scope_id`, `title`, `body_md`, `tags`, `status`,
	`source_kind`, `source_event_id`, `source_task_id`, `distill_job_id`,
	`distill_action`, `supersedes_id`, `superseded_by_id`, `approved_by_user_id`,
	`approved_at`, `created_at`, `version`, `fused_into_skill`,
	`fused_into_skill_id`, `fused_into_skill_version`, `fused_at`,
	`fused_by_user_id`, `fused_fusion_id`
)
SELECT
	`id`, `scope_type`, `scope_id`, `title`, `body_md`, `tags`, `status`,
	`source_kind`, `source_event_id`, `source_task_id`, `distill_job_id`,
	`distill_action`, `supersedes_id`, `superseded_by_id`, `approved_by_user_id`,
	`approved_at`, `created_at`, `version`, `fused_into_skill`,
	`fused_into_skill_id`, `fused_into_skill_version`, `fused_at`,
	`fused_by_user_id`, `fused_fusion_id`
FROM `memories`;--> statement-breakpoint
INSERT INTO `__rfc366_assert` (`ok`)
SELECT CASE
	WHEN (SELECT COUNT(*) FROM `__new_memories`) = (SELECT COUNT(*) FROM `memories`)
	THEN 1 ELSE 0
END;--> statement-breakpoint
DROP TABLE `memories`;--> statement-breakpoint
ALTER TABLE `__new_memories` RENAME TO `memories`;--> statement-breakpoint
CREATE INDEX `idx_memories_scope_status` ON `memories` (`scope_type`,`scope_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_memories_status_created` ON `memories` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memories_supersedes` ON `memories` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_created` ON `memories` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memories_source` ON `memories` (`source_kind`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_fused_skill_id` ON `memories` (`fused_into_skill_id`,`fused_into_skill_version`);--> statement-breakpoint

PRAGMA legacy_alter_table=OFF;--> statement-breakpoint
DROP TABLE `__rfc366_assert`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
