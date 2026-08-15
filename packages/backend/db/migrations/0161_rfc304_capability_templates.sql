-- RFC-304 PR-2 — the two template layers and the repo × capability matrix.
--
-- The split between the two layers IS the permission model (design §2.5). The
-- DEPARTMENT layer (`capability_frameworks`) carries scripts and hooks, which
-- run as the daemon with its full credential surface — so its write permission
-- additionally requires `scripts:author`. The GROUP layer
-- (`capability_bindings`) deliberately has no script or hook columns at all,
-- which is what lets a group lead be given write access to their own binding
-- without being handed that surface. The absence of those columns is the
-- guarantee; the service layer refusing the fields is the second line, not the
-- first.
--
-- `repo_capability_config.readiness` is a DERIVED state cached for the matrix
-- view. `dependency_revision` + `last_validated_at` exist so it can be
-- invalidated: without them, deleting one shared binding leaves every cell that
-- used it still claiming `ready` until an event arrives and fails, and a user
-- who fixes a missing prerequisite stays stuck on `misconfigured`.
CREATE TABLE `capability_frameworks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`capability` text NOT NULL,
	`scripts_json` text NOT NULL DEFAULT '{}',
	`hooks_json` text NOT NULL DEFAULT '[]',
	`param_schema_json` text NOT NULL DEFAULT '{}',
	`param_defaults_json` text NOT NULL DEFAULT '{}',
	`stage_contract_ver` integer NOT NULL DEFAULT 1,
	`owner_user_id` text,
	`visibility` text NOT NULL DEFAULT 'public' CHECK (`visibility` IN ('private','public')),
	`acl_revision` integer NOT NULL DEFAULT 0,
	`builtin` integer NOT NULL DEFAULT 0 CHECK (`builtin` IN (0, 1)),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `capability_frameworks_owner_name_unique`
ON `capability_frameworks` (`owner_user_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_capability_frameworks_capability`
ON `capability_frameworks` (`capability`);--> statement-breakpoint

-- No `scripts_json`, no `hooks_json`. That absence is the permission boundary.
CREATE TABLE `capability_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`framework_id` text NOT NULL,
	`agent_by_slot_json` text NOT NULL DEFAULT '{}',
	`prompt_by_slot_json` text NOT NULL DEFAULT '{}',
	`params_json` text NOT NULL DEFAULT '{}',
	`owner_user_id` text,
	`visibility` text NOT NULL DEFAULT 'public' CHECK (`visibility` IN ('private','public')),
	`acl_revision` integer NOT NULL DEFAULT 0,
	`builtin` integer NOT NULL DEFAULT 0 CHECK (`builtin` IN (0, 1)),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `capability_bindings_owner_name_unique`
ON `capability_bindings` (`owner_user_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_capability_bindings_framework`
ON `capability_bindings` (`framework_id`);--> statement-breakpoint

CREATE TABLE `repo_capability_config` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`capability` text NOT NULL,
	`binding_id` text,
	`enabled` integer NOT NULL DEFAULT 0 CHECK (`enabled` IN (0, 1)),
	`trigger_config_json` text NOT NULL DEFAULT '{}',
	`readiness` text NOT NULL DEFAULT 'disabled' CHECK (`readiness` IN ('disabled','misconfigured','ready')),
	`readiness_issues_json` text NOT NULL DEFAULT '[]',
	`dependency_revision` integer NOT NULL DEFAULT 0,
	`last_validated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repo_capability_cell`
ON `repo_capability_config` (`repo_id`,`capability`);--> statement-breakpoint
CREATE INDEX `idx_repo_capability_binding`
ON `repo_capability_config` (`binding_id`);--> statement-breakpoint
CREATE INDEX `idx_repo_capability_readiness`
ON `repo_capability_config` (`readiness`);
