CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`options_json` text DEFAULT '{}' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_kind` text NOT NULL,
	`cached_path` text NOT NULL,
	`resolved_version` text,
	`installed_at` integer NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugins_name_unique` ON `plugins` (`name`);--> statement-breakpoint
ALTER TABLE `agents` ADD `plugins` text DEFAULT '[]' NOT NULL;
