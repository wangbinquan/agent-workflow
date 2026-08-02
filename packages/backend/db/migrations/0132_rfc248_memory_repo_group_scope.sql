-- RFC-248 PR-2 — memories.scope_type 增加第 5 种 'repo_group'。
--
-- 用组启动的任务注入「组记忆 + 组内每个成员仓的 repo 记忆」（D4）；单个仓库
-- 直启**不**注入它所属任何组的记忆。scope_id = repo_groups.id。
--
-- ⚠ 重建模板取 0117_rfc223_fusion_provenance.sql:119-190，**不是** 0048。
-- 两个原因（设计门 G2）：
--   1. 0048 早于 RFC-223，缺 `fused_into_skill_id` 列与 `idx_memories_fused_skill_id`
--      索引；照抄 0048 会静默丢掉整列融合溯源数据。
--   2. 0117 的 rename-first 顺序是有原因的（它自己的注释写明了）：memories 带
--      两条**自引用 FK**（supersedes_id / superseded_by_id → memories.id），把
--      `__new_memories` rename 成 `memories` 时 SQLite 是否重写这两条自引用
--      **依赖 legacy_alter_table 模式**，而 daemon 迁移期跑在 foreign_keys=OFF、
--      直连 migrator 与测试跑在 ON。先 RENAME 旧表、再直接建最终名，两种模式
--      下都正确。
--
-- 本文件在 DROP 旧表**之前**做三条迁移后校验（设计门 G2 采纳建议 T11b）：
-- 行数一致 / fused_into_skill_id 非空计数一致 / 外键完整。SQLite 的 RAISE()
-- 只能用在 trigger 里，所以用「带 CHECK 的临时表 + 条件 INSERT」当断言原语——
-- 条件不成立时 INSERT 违反 CHECK，整条迁移事务 abort。
--
-- See design/RFC-248-repo-groups/design.md §2.2 / plan.md T11+T11b.
CREATE TEMP TABLE `__rfc248_assert` (`ok` integer NOT NULL CHECK (`ok` = 1));--> statement-breakpoint
ALTER TABLE `memories` RENAME TO `__old_memories`;--> statement-breakpoint
CREATE TABLE `memories` (
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
	CHECK (`source_kind` IN ('clarify','review','feedback','manual')),
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
INSERT INTO `memories` (
	`id`,`scope_type`,`scope_id`,`title`,`body_md`,`tags`,`status`,`source_kind`,
	`source_event_id`,`source_task_id`,`distill_job_id`,`distill_action`,
	`supersedes_id`,`superseded_by_id`,`approved_by_user_id`,`approved_at`,
	`created_at`,`version`,`fused_into_skill`,`fused_into_skill_id`,
	`fused_into_skill_version`,`fused_at`,`fused_by_user_id`,`fused_fusion_id`
)
SELECT
	`id`,`scope_type`,`scope_id`,`title`,`body_md`,`tags`,`status`,`source_kind`,
	`source_event_id`,`source_task_id`,`distill_job_id`,`distill_action`,
	`supersedes_id`,`superseded_by_id`,`approved_by_user_id`,`approved_at`,
	`created_at`,`version`,`fused_into_skill`,`fused_into_skill_id`,
	`fused_into_skill_version`,`fused_at`,`fused_by_user_id`,`fused_fusion_id`
FROM `__old_memories`;--> statement-breakpoint
-- 断言 1：一行不丢。
INSERT INTO `__rfc248_assert` (`ok`)
SELECT CASE WHEN (SELECT COUNT(*) FROM `memories`) = (SELECT COUNT(*) FROM `__old_memories`)
	THEN 1 ELSE 0 END;--> statement-breakpoint
-- 断言 2：RFC-223 的融合溯源列一个不丢（这正是照抄 0048 会踩的坑）。
INSERT INTO `__rfc248_assert` (`ok`)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM `memories` WHERE `fused_into_skill_id` IS NOT NULL) =
	(SELECT COUNT(*) FROM `__old_memories` WHERE `fused_into_skill_id` IS NOT NULL)
	THEN 1 ELSE 0 END;--> statement-breakpoint
DROP TABLE `__old_memories`;--> statement-breakpoint
CREATE INDEX `idx_memories_scope_status` ON `memories` (`scope_type`,`scope_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_memories_status_created` ON `memories` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memories_supersedes` ON `memories` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_source` ON `memories` (`source_kind`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_fused_skill_id` ON `memories` (`fused_into_skill_id`,`fused_into_skill_version`);--> statement-breakpoint
-- 断言 3：五个索引都在（0048 那版只有 4 个——少了 fused_skill_id）。
INSERT INTO `__rfc248_assert` (`ok`)
SELECT CASE WHEN (SELECT COUNT(*) FROM `sqlite_master`
	WHERE `type` = 'index' AND `tbl_name` = 'memories' AND `name` LIKE 'idx_memories_%') = 5
	THEN 1 ELSE 0 END;--> statement-breakpoint
-- 断言 4：自引用 FK 在两种 legacy_alter_table 模式下都正确重写。
INSERT INTO `__rfc248_assert` (`ok`)
SELECT CASE WHEN (SELECT COUNT(*) FROM pragma_foreign_key_check('memories')) = 0
	THEN 1 ELSE 0 END;--> statement-breakpoint
DROP TABLE `__rfc248_assert`;
