CREATE TABLE `observation_platform_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `document` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_platform_records` (
  `id` text PRIMARY KEY NOT NULL,
  `source_key` text NOT NULL,
  `generation` text NOT NULL,
  `document` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observation_platform_generation_idx` ON `observation_platform_records` (`source_key`, `generation`, `id`);
