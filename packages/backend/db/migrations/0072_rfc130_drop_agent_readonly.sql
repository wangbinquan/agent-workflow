-- RFC-130 PR-C — drop the dead agent `readonly` column.
--
-- `readonly` used to (a) gate the scheduler's per-task write-lock serialization,
-- (b) inject into the opencode inline config, (c) gate claude-code's
-- `--disallowed-tools` soft write-sandbox, and (d) mark the built-in commit
-- agent. RFC-130 replaced readonly-based write serialization with per-node
-- worktree isolation (PR-A/PR-B: isolated worktrees + merge reconciliation), so
-- the scheduler no longer reads `agent.readonly`. The flag is now fully deleted
-- from the contract (backend + shared + frontend); this migration drops the
-- backing column. The claude soft-sandbox is intentionally dropped with it.
--
-- Unlike RFC-115's param drop (0057) there is NO data to preserve — `readonly`
-- is being removed as a concept, not re-homed — so this rebuild needs NO
-- pre-drop guard.
--
-- SQLite has no in-place DROP COLUMN in bun:sqlite's bundled runtime, so we use
-- the standard 12-step rebuild (cf. 0041 / 0057 / 0058). The new table mirrors
-- `agents` MINUS the `readonly` column; the `agents_name_unique` index (0000) is
-- recreated. Column list is explicit on both sides so the dropped column can't
-- sneak back. The platform is pre-prod; hard-cut is safe.
--
-- See design/RFC-130-node-worktree-isolation/design.md.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`outputs` text DEFAULT '[]' NOT NULL,
	`sync_outputs_on_iterate` integer DEFAULT true NOT NULL,
	`runtime` text,
	`permission` text DEFAULT '{}' NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`mcp` text DEFAULT '[]' NOT NULL,
	`plugins` text DEFAULT '[]' NOT NULL,
	`frontmatter_extra` text DEFAULT '{}' NOT NULL,
	`body_md` text DEFAULT '' NOT NULL,
	`owner_user_id` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_agents` (
	`id`, `name`, `description`, `outputs`, `sync_outputs_on_iterate`,
	`runtime`, `permission`, `skills`, `depends_on`, `mcp`, `plugins`,
	`frontmatter_extra`, `body_md`, `owner_user_id`, `visibility`, `builtin`,
	`schema_version`, `created_at`, `updated_at`
)
SELECT
	`id`, `name`, `description`, `outputs`, `sync_outputs_on_iterate`,
	`runtime`, `permission`, `skills`, `depends_on`, `mcp`, `plugins`,
	`frontmatter_extra`, `body_md`, `owner_user_id`, `visibility`, `builtin`,
	`schema_version`, `created_at`, `updated_at`
FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
