-- RFC-153 — drop the runtimes `builtin` read-only flag.
--
-- `builtin` (added 0049/0055, RFC-104/112) used to mark the two framework-seeded
-- runtimes (opencode, claude-code) as read-only: it (a) forbade delete
-- (assertNotBuiltinRuntime), (b) reserved their names (validateName), (c) drove
-- the "内置" UI badge, and (d) let seed hard-reset their identity every startup.
-- RFC-113 D8 already made built-ins fully editable (binary/model/profile), so the
-- flag had decayed to just those four residual behaviors. RFC-153 removes the
-- built-in vs non-built-in distinction entirely: opencode/claude-code become
-- ordinary deletable runtimes, seeded ONLY on an empty table (deleted rows never
-- re-seeded). The protocol-name driver fallback (resolveRuntimeByName's
-- BUILTIN_NAMES) is a code constant, NOT this column, and stays.
--
-- Unlike RFC-115's param drop (0057) there is NO data to preserve — `builtin` is
-- removed as a concept, not re-homed — so this rebuild needs NO pre-drop guard.
--
-- SQLite has no in-place DROP COLUMN in bun:sqlite's bundled runtime, so we use
-- the standard 12-step rebuild (cf. 0072 / 0058 / 0041). The new table mirrors
-- `runtimes` MINUS the `builtin` column, preserving the physical column order of
-- the cumulative 0055 + 0056 (profile) + 0059 (enabled) shape; the
-- `runtimes_name_unique` index (0055) is recreated. Column list is explicit on
-- both sides so the dropped column can't sneak back. The platform is pre-prod;
-- hard-cut is safe.
--
-- See design/RFC-153-runtime-drop-builtin/design.md.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`binary_path` text,
	`last_probe_json` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`model` text,
	`variant` text,
	`temperature` real,
	`steps` integer,
	`max_steps` integer,
	`enabled` integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_runtimes` (
	`id`, `name`, `protocol`, `binary_path`, `last_probe_json`, `created_by`,
	`created_at`, `updated_at`, `model`, `variant`, `temperature`, `steps`,
	`max_steps`, `enabled`
)
SELECT
	`id`, `name`, `protocol`, `binary_path`, `last_probe_json`, `created_by`,
	`created_at`, `updated_at`, `model`, `variant`, `temperature`, `steps`,
	`max_steps`, `enabled`
FROM `runtimes`;--> statement-breakpoint
DROP TABLE `runtimes`;--> statement-breakpoint
ALTER TABLE `__new_runtimes` RENAME TO `runtimes`;--> statement-breakpoint
CREATE UNIQUE INDEX `runtimes_name_unique` ON `runtimes` (`name`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
