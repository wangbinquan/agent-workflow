-- RFC-309 — one capability template, not two layers.
--
-- RFC-304 split a usable configuration across `capability_frameworks`
-- (department: scripts + hooks) and `capability_bindings` (group: agents +
-- prompts + params). Neither half was usable alone, so every list, copy and
-- export existed twice while the thing a person actually wanted was the pair.
-- The user's ruling: 「不需要区分组织模版和小组模版了，就是一套模版，大家可以
-- 复制修改就行了」.
--
-- ## Why the merge does not weaken the permission boundary
--
-- The split existed for one real reason: scripts and hooks run as the daemon
-- with its whole credential surface, so framework writes were system-domain
-- (no API token could ever carry them). That property survives, moved one level
-- down: writing `scripts_json` / `hooks_json` still requires `scripts:author`,
-- now checked per FIELD in the service layer. What changes is that swapping the
-- agent on a step no longer means handing anyone the daemon.
--
-- ## The migration's one clever choice, and why it is the safe one
--
-- Each template KEEPS ITS BINDING'S id. `repo_capability_config.binding_id`
-- already stores exactly that value, so the column is RENAMED and never
-- rewritten — which deletes the single most dangerous failure mode of this
-- migration (matrix cells silently pointing at the wrong configuration). The
-- verification is then a near-tautology, which is the point.
--
-- ## What is deliberately given up
--
-- "One framework shared by N bindings" is gone, so a department fixing a script
-- no longer changes every group's behaviour automatically. That relation
-- becomes the T64 upstream link: each migrated template records the framework
-- it came from in `upstream_id`, so the fix shows up as `update-available` with
-- a three-way diff, applied when the group chooses. Stated as a breaking change
-- in the RFC's capability-impact list and confirmed by the user.

CREATE TABLE `capability_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`capability` text NOT NULL,
	`scripts_json` text NOT NULL DEFAULT '{}',
	`hooks_json` text NOT NULL DEFAULT '[]',
	`param_schema_json` text NOT NULL DEFAULT '[]',
	`param_defaults_json` text NOT NULL DEFAULT '{}',
	`agent_by_slot_json` text NOT NULL DEFAULT '{}',
	`prompt_by_slot_json` text NOT NULL DEFAULT '{}',
	`params_json` text NOT NULL DEFAULT '{}',
	`stage_contract_ver` integer NOT NULL DEFAULT 1,
	`upstream_id` text,
	`upstream_version` integer,
	`base_digest` text,
	`owner_user_id` text,
	`visibility` text NOT NULL DEFAULT 'public' CHECK (`visibility` IN ('public','private')),
	`acl_revision` integer NOT NULL DEFAULT 0,
	`builtin` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint

-- Every binding becomes a template, inheriting its framework's department half.
-- The group's ownership wins: the binding is the row a group already owned, and
-- the merged template is theirs to edit.
--
-- `upstream_id` records where the scripts came from. `base_digest` is the
-- department half as it stood at migration time — without it a later upstream
-- change is a two-way merge that cannot tell "upstream changed this" from
-- "we changed this", and guesses wrong on exactly the fields somebody cared
-- enough to edit.
INSERT INTO `capability_templates` (
	`id`, `name`, `description`, `capability`,
	`scripts_json`, `hooks_json`, `param_schema_json`, `param_defaults_json`,
	`agent_by_slot_json`, `prompt_by_slot_json`, `params_json`,
	`stage_contract_ver`, `upstream_id`, `upstream_version`, `base_digest`,
	`owner_user_id`, `visibility`, `acl_revision`, `builtin`,
	`created_at`, `updated_at`
)
SELECT
	b.`id`, b.`name`, b.`description`, f.`capability`,
	f.`scripts_json`, f.`hooks_json`, f.`param_schema_json`, f.`param_defaults_json`,
	b.`agent_by_slot_json`, b.`prompt_by_slot_json`, b.`params_json`,
	f.`stage_contract_ver`,
	f.`id`,
	1,
	f.`scripts_json` || '|' || f.`hooks_json` || '|' || f.`param_schema_json`,
	b.`owner_user_id`, b.`visibility`, b.`acl_revision`, b.`builtin`,
	b.`created_at`, b.`updated_at`
FROM `capability_bindings` b
JOIN `capability_frameworks` f ON f.`id` = b.`framework_id`;--> statement-breakpoint

-- A framework nobody bound is still a real asset — somebody wrote those scripts.
-- It becomes a template with no agents filled in, which the UI shows as "needs
-- an agent" rather than silently discarding the work (RFC Q-A, default kept).
INSERT INTO `capability_templates` (
	`id`, `name`, `description`, `capability`,
	`scripts_json`, `hooks_json`, `param_schema_json`, `param_defaults_json`,
	`agent_by_slot_json`, `prompt_by_slot_json`, `params_json`,
	`stage_contract_ver`, `upstream_id`, `upstream_version`, `base_digest`,
	`owner_user_id`, `visibility`, `acl_revision`, `builtin`,
	`created_at`, `updated_at`
)
SELECT
	f.`id`, f.`name`, f.`description`, f.`capability`,
	f.`scripts_json`, f.`hooks_json`, f.`param_schema_json`, f.`param_defaults_json`,
	'{}', '{}', '{}',
	f.`stage_contract_ver`, f.`upstream_id`, f.`upstream_version`, f.`base_digest`,
	f.`owner_user_id`, f.`visibility`, f.`acl_revision`, f.`builtin`,
	f.`created_at`, f.`updated_at`
FROM `capability_frameworks` f
WHERE NOT EXISTS (SELECT 1 FROM `capability_bindings` b WHERE b.`framework_id` = f.`id`);--> statement-breakpoint

CREATE UNIQUE INDEX `capability_templates_owner_name_unique`
ON `capability_templates` (`owner_user_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_capability_templates_capability`
ON `capability_templates` (`capability`);--> statement-breakpoint
CREATE INDEX `idx_capability_templates_upstream`
ON `capability_templates` (`upstream_id`);--> statement-breakpoint

DROP TABLE `capability_bindings`;--> statement-breakpoint
DROP TABLE `capability_frameworks`;--> statement-breakpoint

-- The matrix pointer: renamed, never rewritten. Template ids ARE the binding
-- ids, so every cell keeps pointing at the same configuration.
DROP INDEX IF EXISTS `idx_repo_capability_binding`;--> statement-breakpoint
ALTER TABLE `repo_capability_config` RENAME COLUMN `binding_id` TO `template_id`;--> statement-breakpoint
CREATE INDEX `idx_repo_capability_template`
ON `repo_capability_config` (`template_id`);--> statement-breakpoint

-- `anchor_kind` gains `platform`: a round started from the platform's own UI or
-- API has no code-host anchor at all. SQLite cannot alter a CHECK constraint,
-- so both tables are rebuilt.
CREATE TABLE `__new_code_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`code_host_endpoint_id` text NOT NULL,
	`stable_project_id` text NOT NULL,
	`capability` text NOT NULL,
	`anchor_kind` text NOT NULL CHECK (`anchor_kind` IN ('mr','issue','pipeline','platform')),
	`anchor_id` text NOT NULL,
	`status` text NOT NULL DEFAULT 'idle' CHECK (`status` IN ('idle','queued','running','awaiting','settled','failed','superseding','handed_off','closing','closed')),
	`epoch` integer NOT NULL DEFAULT 1 CHECK (`epoch` >= 1),
	`current_round_id` text,
	`pending_generation` integer,
	`handed_off_fingerprint` text,
	`anchor_meta` text,
	`initiator_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	`publishing_epoch` integer CHECK (`publishing_epoch` IS NULL OR `publishing_epoch` >= 1),
	`pending_revision` text
);--> statement-breakpoint
INSERT INTO `__new_code_work_items` (
	`id`, `code_host_endpoint_id`, `stable_project_id`, `capability`,
	`anchor_kind`, `anchor_id`, `status`, `epoch`, `current_round_id`,
	`pending_generation`, `handed_off_fingerprint`, `anchor_meta`,
	`initiator_user_id`, `created_at`, `updated_at`, `closed_at`,
	`publishing_epoch`, `pending_revision`
)
SELECT
	`id`, `code_host_endpoint_id`, `stable_project_id`, `capability`,
	`anchor_kind`, `anchor_id`, `status`, `epoch`, `current_round_id`,
	`pending_generation`, `handed_off_fingerprint`, `anchor_meta`,
	`initiator_user_id`, `created_at`, `updated_at`, `closed_at`,
	`publishing_epoch`, `pending_revision`
FROM `code_work_items`;--> statement-breakpoint
DROP TABLE `code_work_items`;--> statement-breakpoint
ALTER TABLE `__new_code_work_items` RENAME TO `code_work_items`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_code_work_items_identity`
ON `code_work_items` (`code_host_endpoint_id`,`stable_project_id`,`capability`,`anchor_kind`,`anchor_id`);--> statement-breakpoint
CREATE INDEX `idx_code_work_items_status`
ON `code_work_items` (`status`);--> statement-breakpoint
CREATE INDEX `idx_code_work_items_anchor`
ON `code_work_items` (`code_host_endpoint_id`,`stable_project_id`,`anchor_kind`,`anchor_id`);--> statement-breakpoint

CREATE TABLE `__new_code_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`code_host_endpoint_id` text NOT NULL,
	`stable_project_id` text NOT NULL,
	`anchor_kind` text NOT NULL CHECK (`anchor_kind` IN ('mr','issue','pipeline','platform')),
	`anchor_id` text NOT NULL,
	`capability` text NOT NULL,
	`fingerprint` text NOT NULL,
	`generation` integer NOT NULL DEFAULT 1,
	`lifecycle` text NOT NULL DEFAULT 'active' CHECK (`lifecycle` IN ('active','disappeared','reappeared')),
	`severity` text,
	`title` text,
	`file_path` text,
	`anchor_line` integer,
	`external_id` text,
	`published_round_id` text,
	`disappeared_round_id` text,
	-- Added by 0165 (adoption signals). A rebuild written from 0164's CREATE
	-- would drop them, and the failure surfaces far away: `code_findings has no
	-- column named resolved_at` from the metrics query, long after the migration
	-- reported success.
	`resolved_at` integer,
	`code_changed_at` integer,
	`resolved_round_id` text,
	`code_changed_round_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`closed_at` integer
);--> statement-breakpoint
INSERT INTO `__new_code_findings` (
	`id`, `code_host_endpoint_id`, `stable_project_id`, `anchor_kind`, `anchor_id`,
	`capability`, `fingerprint`, `generation`, `lifecycle`, `severity`, `title`,
	`file_path`, `anchor_line`, `external_id`, `published_round_id`,
	`disappeared_round_id`, `resolved_at`, `code_changed_at`, `resolved_round_id`,
	`code_changed_round_id`, `created_at`, `last_seen_at`, `closed_at`
)
SELECT
	`id`, `code_host_endpoint_id`, `stable_project_id`, `anchor_kind`, `anchor_id`,
	`capability`, `fingerprint`, `generation`, `lifecycle`, `severity`, `title`,
	`file_path`, `anchor_line`, `external_id`, `published_round_id`,
	`disappeared_round_id`, `resolved_at`, `code_changed_at`, `resolved_round_id`,
	`code_changed_round_id`, `created_at`, `last_seen_at`, `closed_at`
FROM `code_findings`;--> statement-breakpoint
DROP TABLE `code_findings`;--> statement-breakpoint
ALTER TABLE `__new_code_findings` RENAME TO `code_findings`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_code_finding_identity`
ON `code_findings` (`code_host_endpoint_id`,`stable_project_id`,`anchor_kind`,`anchor_id`,`fingerprint`,`generation`);--> statement-breakpoint
CREATE INDEX `idx_code_findings_anchor`
ON `code_findings` (`code_host_endpoint_id`,`stable_project_id`,`anchor_kind`,`anchor_id`,`lifecycle`);--> statement-breakpoint
CREATE INDEX `idx_code_findings_seen`
ON `code_findings` (`stable_project_id`,`last_seen_at`);--> statement-breakpoint

-- Grants naming the removed points. Deleted rather than mapped, on the user's
-- explicit ruling (「你直接改，过去的权限还没人用」). Written down because a
-- silent delete of authorization rows is the kind of thing a later reader must
-- be able to tell apart from an oversight: an account that held only
-- `capability-bindings:update` loses it here and needs re-granting as
-- `capability-templates:update`.
DELETE FROM `user_permission_grants`
WHERE `permission` LIKE 'capability-frameworks:%'
   OR `permission` LIKE 'capability-bindings:%';--> statement-breakpoint

-- Resource grants naming the merged types. A binding grant retypes cleanly
-- because template ids ARE binding ids; a framework grant may point at an id
-- that is now nobody's template (its scripts live inside each binding's copy),
-- so it is dropped rather than left dangling against a row that no longer
-- exists. Same ruling as the permission grants above.
UPDATE `resource_grants`
SET `resource_type` = 'capability_template'
WHERE `resource_type` = 'capability_binding';--> statement-breakpoint
UPDATE `resource_grants`
SET `resource_type` = 'capability_template'
WHERE `resource_type` = 'capability_framework'
  AND `resource_id` IN (SELECT `id` FROM `capability_templates`);--> statement-breakpoint
DELETE FROM `resource_grants` WHERE `resource_type` = 'capability_framework';
