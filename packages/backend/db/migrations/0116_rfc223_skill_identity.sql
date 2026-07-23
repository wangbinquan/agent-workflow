-- RFC-223 PR-5 — make immutable skills.id the DB identity of every version row.
--
-- Filesystem paths are deliberately copied unchanged in this SQL migration.
-- `runSkillIdentityMigrationBarrier` owns the crash-safe vertical move from
-- skills/{name} to skills/{id}; its migrate operation updates managed_path and
-- every files_path in the same db-committed transaction. This rebuild only
-- changes the FK/unique identity so an upgrade cannot keep using a mutable name.
--
-- Fail closed before rebuilding if a version cannot resolve to exactly one
-- current skill. Name is still globally unique before RFC-223 PR-8, so this is a
-- deterministic one-time backfill and not a current-name guess after the flip.
CREATE TEMP TABLE `__rfc223_skill_version_guard` (`n` integer CHECK (`n` = 0));--> statement-breakpoint
INSERT INTO `__rfc223_skill_version_guard`
SELECT COUNT(*)
FROM `skill_versions` AS `v`
LEFT JOIN `skills` AS `s` ON `s`.`name` = `v`.`skill_name`
WHERE `s`.`id` IS NULL;--> statement-breakpoint
DROP TABLE `__rfc223_skill_version_guard`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`version_index` integer NOT NULL,
	`files_path` text NOT NULL,
	`source` text NOT NULL,
	`summary` text,
	`fusion_id` text,
	`restored_from_version` integer,
	`author_user_id` text,
	`content_hash` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_skill_versions` (
	`id`, `skill_id`, `version_index`, `files_path`, `source`, `summary`,
	`fusion_id`, `restored_from_version`, `author_user_id`, `content_hash`, `created_at`
)
SELECT
	`v`.`id`, `s`.`id`, `v`.`version_index`, `v`.`files_path`, `v`.`source`, `v`.`summary`,
	`v`.`fusion_id`, `v`.`restored_from_version`, `v`.`author_user_id`, `v`.`content_hash`,
	`v`.`created_at`
FROM `skill_versions` AS `v`
INNER JOIN `skills` AS `s` ON `s`.`name` = `v`.`skill_name`;--> statement-breakpoint
DROP TABLE `skill_versions`;--> statement-breakpoint
ALTER TABLE `__new_skill_versions` RENAME TO `skill_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_skill_versions_skill_v` ON `skill_versions` (`skill_id`, `version_index`);--> statement-breakpoint
CREATE INDEX `idx_skill_versions_created` ON `skill_versions` (`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
