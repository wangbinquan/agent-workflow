-- RFC-223 PR-8 — the final name-uniqueness flip.
--
-- URL, persisted references, frozen snapshots, and managed skill paths are
-- canonical by immutable id before this migration. Names are now display
-- labels: the five owner-scoped resource types reject duplicates only inside
-- one owner bucket. Workflows deliberately remain non-unique and runtimes
-- deliberately retain their global name identity.
--
-- Existing rows predate this flip and were globally unique. Normalizing the
-- remaining NULL owners to the system bucket therefore cannot introduce a
-- collision. COALESCE remains in each index as the physical NULL-safe guard
-- for direct/legacy writers.
UPDATE `agents` SET `owner_user_id` = '__system__' WHERE `owner_user_id` IS NULL;
--> statement-breakpoint
UPDATE `skills` SET `owner_user_id` = '__system__' WHERE `owner_user_id` IS NULL;
--> statement-breakpoint
UPDATE `mcps` SET `owner_user_id` = '__system__' WHERE `owner_user_id` IS NULL;
--> statement-breakpoint
UPDATE `plugins` SET `owner_user_id` = '__system__' WHERE `owner_user_id` IS NULL;
--> statement-breakpoint
UPDATE `workgroups` SET `owner_user_id` = '__system__' WHERE `owner_user_id` IS NULL;
--> statement-breakpoint

DROP INDEX `agents_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_owner_name_unique`
  ON `agents` (COALESCE(`owner_user_id`, ''), `name`);
--> statement-breakpoint
DROP INDEX `skills_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_owner_name_unique`
  ON `skills` (COALESCE(`owner_user_id`, ''), `name`);
--> statement-breakpoint
DROP INDEX `mcps_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `mcps_owner_name_unique`
  ON `mcps` (COALESCE(`owner_user_id`, ''), `name`);
--> statement-breakpoint
DROP INDEX `plugins_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `plugins_owner_name_unique`
  ON `plugins` (COALESCE(`owner_user_id`, ''), `name`);
--> statement-breakpoint
DROP INDEX `workgroups_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `workgroups_owner_name_unique`
  ON `workgroups` (COALESCE(`owner_user_id`, ''), `name`);
