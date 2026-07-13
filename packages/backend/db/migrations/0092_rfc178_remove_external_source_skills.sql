-- RFC-178 (2026-07-14) — 收敛 skills 为 managed-only：删除「外部 skill」
-- (hand-external, import-external) 与「父目录 skill」(source-external, skill_sources
-- / RFC-017) 两套功能。外部 skill 的磁盘文件在用户自己的目录里，本迁移只删 DB
-- 索引行，不触碰磁盘。forward-drop（同 0089）：新库创建后即删（表 external 行恒空）；
-- 存量 dev 库删除既有 external 行 + skill_sources + 相关列。取代 RFC-170 的 external
-- 部分（managed 主干独立保留）。hand-written；registered in meta/_journal.json。
--
-- 语句顺序对 foreign_keys=ON 也安全：先删 skills.source_id 列（连带其指向
-- skill_sources 的 FK），最后才 DROP TABLE skill_sources——skills 全程不带指向已删表
-- 的悬空 FK（否则 FK-ON 下对 skills 的任何操作会「no such table: skill_sources」）。
--
-- 步骤 1：清理 agents.skills[] 里指向被删外部 skill 的悬空引用。只剔除「确实是
-- external skill 的名字」——保留指向 repo-local project skill (DB 无行) 的合法引用。
-- 必须先于步骤 2 的 DELETE（子查询依赖尚存的 external 行）。workflow.validator 会校验
-- agent.skills 都能解析，故这步是正确性必需、非锦上添花。
UPDATE `agents`
SET `skills` = (
  SELECT json_group_array(value)
  FROM json_each(`agents`.`skills`)
  WHERE value NOT IN (SELECT `name` FROM `skills` WHERE `source_kind` = 'external')
)
WHERE EXISTS (
  SELECT 1 FROM json_each(`agents`.`skills`)
  WHERE value IN (SELECT `name` FROM `skills` WHERE `source_kind` = 'external')
);
--> statement-breakpoint
-- 步骤 2：删所有 external skill 行（skill_sources 尚存，skills.source_id FK 有效）。
-- 级联删各自 skill_versions（skill_name FK ON DELETE CASCADE；外部 skill 通常无版本）。
DELETE FROM `skills` WHERE `source_kind` = 'external';
--> statement-breakpoint
-- 步骤 3：删 external/source 专属列。source_id 有 index，先 DROP INDEX；再删 source_id
-- 列（连带其 FK），使 skills 不再引用 skill_sources。
DROP INDEX IF EXISTS `skills_source_id_idx`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `source_id`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `external_path`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `authority_kind`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `source_state`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `origin_source_id`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `authority_owner_user_id`;
--> statement-breakpoint
-- 步骤 4：删父目录表（此时已无 FK 指向它，FK-ON 也安全）。
DROP TABLE IF EXISTS `skill_sources`;
--> statement-breakpoint
-- 步骤 5：清理被删外部 skill 的 ACL 授权行（resource_grants 无 FK 到 skills，须显式清）。
-- resource_id 存 skill.id（ULID）；外部行已在步骤 2 删，此处删指向已消失 skill id 的 skill
-- 授权（同名重建的 managed skill 是新 ULID，不会继承）。
DELETE FROM `resource_grants`
WHERE `resource_type` = 'skill'
  AND `resource_id` NOT IN (SELECT `id` FROM `skills`);
