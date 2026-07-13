-- RFC-170 — skills storage-layer + shared-ACL hardening (hand-written; registered
-- in meta/_journal.json). See design/RFC-170-skills-storage-acl-hardening/design.md §10.
--
-- Purely additive schema (no table rebuilds): 18 ALTER + 2 CREATE TABLE +
-- 1 partial-unique index + 3 backfill UPDATE. Every NOT NULL column carries a
-- DEFAULT so ADD COLUMN succeeds on a non-empty table (G4-7). The new columns/
-- tables are DORMANT until the batch-B code wires them; existing behavior is
-- byte-for-byte unchanged at rest.
--
-- 1) Six-resource `acl_revision` — RFC-170 §8 aclRevision monotonic CAS.
ALTER TABLE `agents` ADD `acl_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD `acl_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `mcps` ADD `acl_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `acl_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `workflows` ADD `acl_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `workgroups` ADD `acl_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 2) fusions precondition composite token — RFC-170 §2 fusion approval CAS.
--    Existing awaiting-approval rows get NULL → the approve path fails closed and
--    prompts a re-initiate (no silent stale-baseline apply).
ALTER TABLE `fusions` ADD `precondition_token` text;
--> statement-breakpoint
-- 3) skills identity/lifecycle columns — RFC-170 §1/§3/§4/§9/§7a.
ALTER TABLE `skills` ADD `meta_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD `migration_marker` text;
--> statement-breakpoint
ALTER TABLE `skills` ADD `reservation_state` text DEFAULT 'ready' NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD `version_state` text DEFAULT 'legacy-unbackfilled' NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD `authority_kind` text DEFAULT 'managed' NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD `source_state` text;
--> statement-breakpoint
ALTER TABLE `skills` ADD `origin_source_id` text;
--> statement-breakpoint
ALTER TABLE `skills` ADD `authority_owner_user_id` text;
--> statement-breakpoint
-- 4) skill_sources lifecycle + monotonic revision — RFC-170 §7/§7a.
ALTER TABLE `skill_sources` ADD `lifecycle_state` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE `skill_sources` ADD `deleted_at` integer;
--> statement-breakpoint
ALTER TABLE `skill_sources` ADD `source_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 5) skill_operations — RFC-170 §6a two-phase-commit crash-recovery state machine.
--    No `skills` FK cascade (recovery is by op_id ownership, not row lifetime).
CREATE TABLE `skill_operations` (
	`op_id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`kind` text NOT NULL CHECK(`kind` IN ('reserve', 'replace', 'migrate', 'delete', 'version-write', 'adopt-managed')),
	`phase` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL CHECK(`active` IN (0, 1)),
	`staging_path` text,
	`backup_path` text,
	`candidate_path` text,
	`next_skill_id` text,
	`candidate_fingerprint` text,
	`backup_fingerprint` text,
	`target_version` integer,
	`generation` integer,
	`owner_user_id` text,
	`precondition_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
-- Partial-unique: at most one active op per skill_id (per-skill recovery index +
-- secondary guard; the universal cross-op exclusion is skill_operation_locks).
CREATE UNIQUE INDEX `uq_skill_operations_active` ON `skill_operations` (`skill_id`) WHERE `active` = 1;
--> statement-breakpoint
-- 6) skill_operation_locks — RFC-170 §6a/G6-2 universal mutual-exclusion primitive.
--    Every op INSERTs a row per affected skillId in its intent tx; PK conflict = 409.
--    Held until phase='done' (released same tx). Locks the SECOND id (replace's
--    next_skill_id) that the ops partial-unique cannot.
CREATE TABLE `skill_operation_locks` (
	`locked_skill_id` text PRIMARY KEY NOT NULL,
	`op_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
-- 7) Backfill authority_kind from existing source_kind + source_id (G3-7): the
--    stable discriminator replaces the fragile `source_id != NULL` heuristic.
UPDATE `skills` SET `authority_kind` = CASE
	WHEN `source_kind` = 'external' AND `source_id` IS NOT NULL THEN 'source-external'
	WHEN `source_kind` = 'external' AND `source_id` IS NULL THEN 'hand-external'
	ELSE 'managed'
END;
--> statement-breakpoint
-- 8) Backfill version_state (G3-5): managed skills that already have a
--    skill_versions row become 'snapshot-unverified' (NOT authoritative — the old
--    funnel hash skipped symlinks; boot must re-verify before trusting). Others
--    stay 'legacy-unbackfilled'. External rows ignore this column.
UPDATE `skills` SET `version_state` = 'snapshot-unverified'
	WHERE `source_kind` = 'managed'
	AND EXISTS (SELECT 1 FROM `skill_versions` WHERE `skill_versions`.`skill_name` = `skills`.`name`);
--> statement-breakpoint
-- 9) Backfill authority_owner_user_id (content provenance) + degraded marking
--    (G6-3/G4-8): source-external ← its source registrar (provable content
--    controller); hand-external ← NULL AND source_state='degraded' (no importer
--    provenance pre-upgrade → cannot prove current owner controls disk → await
--    adoption). source-external whose owner drifted from its registrar is also
--    degraded (pre-upgrade transfer mismatch). managed stays NULL.
UPDATE `skills` SET
	`authority_owner_user_id` = CASE
		WHEN `authority_kind` = 'source-external'
			THEN (SELECT `created_by` FROM `skill_sources` WHERE `skill_sources`.`id` = `skills`.`source_id`)
		ELSE NULL
	END,
	`source_state` = CASE
		WHEN `authority_kind` = 'hand-external' THEN 'degraded'
		WHEN `authority_kind` = 'source-external'
			AND `owner_user_id` IS NOT (SELECT `created_by` FROM `skill_sources` WHERE `skill_sources`.`id` = `skills`.`source_id`)
			THEN 'degraded'
		ELSE `source_state`
	END
	WHERE `authority_kind` IN ('source-external', 'hand-external');
