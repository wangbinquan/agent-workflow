CREATE TABLE `events_archive` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `ts` integer NOT NULL,
  `kind` text NOT NULL,
  `node_id` text,
  `loop_iter` integer,
  `shard_key` text,
  `iter` integer,
  `attempt_id` text,
  `parent_event_id` text,
  `actor` text NOT NULL,
  `resolution_id` text,
  `payload` text NOT NULL DEFAULT '{}',
  `archived_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_archive_task_ts` ON `events_archive` (`task_id`, `ts`);
--> statement-breakpoint
CREATE INDEX `idx_events_archive_kind` ON `events_archive` (`task_id`, `kind`);
