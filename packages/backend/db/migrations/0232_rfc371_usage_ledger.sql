CREATE TABLE `observation_usage_sources` (
  `source_id` text PRIMARY KEY NOT NULL,
  `cursor` text
);
--> statement-breakpoint
CREATE TABLE `observation_usage_current` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `source_id` text NOT NULL,
  `document` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observation_usage_task_idx` ON `observation_usage_current` (`task_id`, `id`);
--> statement-breakpoint
CREATE TABLE `observation_usage_events` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL,
  `event_id` text NOT NULL,
  `record_key` text NOT NULL,
  `revision` integer NOT NULL,
  `fingerprint` text NOT NULL,
  `outcome` text NOT NULL,
  `document` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observation_usage_revision_idx` ON `observation_usage_events` (`record_key`, `revision`);
