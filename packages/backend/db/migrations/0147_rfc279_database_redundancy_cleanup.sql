-- RFC-279 — remove seven columns that no longer carry independent product
-- state. Every dormant/duplicated value is proved safe before any destructive
-- DDL runs, so unexpected historical state aborts the migration transaction.

CREATE TABLE `__rfc279_redundancy_guard` (
	`ok` integer NOT NULL CHECK (`ok` = 1)
);--> statement-breakpoint
INSERT INTO `__rfc279_redundancy_guard` (`ok`)
SELECT CASE WHEN
	NOT EXISTS (SELECT 1 FROM `skills` WHERE `source_kind` <> 'managed')
	AND NOT EXISTS (
		SELECT 1 FROM `task_questions`
		WHERE `reopen_count` <> 0 OR `prior_answer_snapshot_json` IS NOT NULL
	)
	AND NOT EXISTS (
		SELECT 1 FROM `task_questions`
		WHERE `manual_title` IS NOT NULL AND `manual_title` <> `question_title`
	)
	AND NOT EXISTS (
		SELECT 1 FROM `skill_operations`
		WHERE `kind` NOT IN ('reserve', 'migrate', 'delete', 'version-write')
			OR `next_skill_id` IS NOT NULL
	)
THEN 1 ELSE 0 END;--> statement-breakpoint
DROP TABLE `__rfc279_redundancy_guard`;--> statement-breakpoint

-- A direct upgrade can apply RFC-204's columns and this migration in one
-- drizzle batch, before the daemon has had a chance to seal legacy plaintext.
-- Preserve such a URL under a closed prefix. Only the first post-openDb
-- credential gate may decode this payload and replace it with SecretBox
-- ciphertext; ordinary readers reject it.
UPDATE `cached_repos`
SET `url_enc` = 'aw-legacy-url-hex-v1:' || hex(CAST(`url` AS BLOB))
WHERE length(`url`) > 0 AND (`url_enc` IS NULL OR length(`url_enc`) = 0);--> statement-breakpoint

ALTER TABLE `skills` DROP COLUMN `source_kind`;--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `migration_marker`;--> statement-breakpoint

ALTER TABLE `task_questions` DROP COLUMN `reopen_count`;--> statement-breakpoint
ALTER TABLE `task_questions` DROP COLUMN `prior_answer_snapshot_json`;--> statement-breakpoint
ALTER TABLE `task_questions` DROP COLUMN `manual_title`;--> statement-breakpoint

ALTER TABLE `cached_repos` DROP COLUMN `url`;--> statement-breakpoint

-- Rebuild rather than DROP COLUMN so the physical kind CHECK also stops
-- admitting the retired replace/adopt-managed operations.
CREATE TABLE `__new_skill_operations` (
	`op_id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('reserve', 'migrate', 'delete', 'version-write')),
	`phase` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL CHECK (`active` IN (0, 1)),
	`staging_path` text,
	`backup_path` text,
	`candidate_path` text,
	`candidate_fingerprint` text,
	`backup_fingerprint` text,
	`target_version` integer,
	`generation` integer,
	`owner_user_id` text,
	`precondition_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_skill_operations` (
	`op_id`, `skill_id`, `kind`, `phase`, `active`, `staging_path`,
	`backup_path`, `candidate_path`, `candidate_fingerprint`,
	`backup_fingerprint`, `target_version`, `generation`, `owner_user_id`,
	`precondition_json`, `created_at`
)
SELECT
	`op_id`, `skill_id`, `kind`, `phase`, `active`, `staging_path`,
	`backup_path`, `candidate_path`, `candidate_fingerprint`,
	`backup_fingerprint`, `target_version`, `generation`, `owner_user_id`,
	`precondition_json`, `created_at`
FROM `skill_operations`;--> statement-breakpoint
DROP TABLE `skill_operations`;--> statement-breakpoint
ALTER TABLE `__new_skill_operations` RENAME TO `skill_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_skill_operations_active`
	ON `skill_operations` (`skill_id`) WHERE `active` = 1;
