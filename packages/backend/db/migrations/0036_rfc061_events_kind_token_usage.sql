CREATE TABLE `events_new` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `ts` integer NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN (
    'task-created',
    'task-started',
    'task-paused',
    'task-canceled',
    'task-completed',
    'task-failed',
    'task-resumed-after-daemon-restart',
    'logical-run-created',
    'logical-run-iter-bumped',
    'logical-run-completed',
    'logical-run-canceled',
    'attempt-started',
    'attempt-finished-success',
    'attempt-finished-envelope-fail',
    'attempt-finished-crash',
    'attempt-finished-timeout',
    'attempt-canceled',
    'attempt-output-captured',
    'attempt-subagent-tool-use',
    'attempt-subagent-output',
    'attempt-token-usage',
    'suspension-created',
    'suspension-resolved',
    'suspension-terminated',
    'invariant-alert-detected',
    'invariant-alert-resolved'
  )),
  `node_id` text,
  `loop_iter` integer,
  `shard_key` text,
  `iter` integer,
  `attempt_id` text,
  `parent_event_id` text,
  `actor` text NOT NULL,
  `resolution_id` text,
  `payload` text NOT NULL DEFAULT '{}',
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `events_new` SELECT * FROM `events`;
--> statement-breakpoint
DROP TABLE `events`;
--> statement-breakpoint
ALTER TABLE `events_new` RENAME TO `events`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_events_resolution` ON `events` (`resolution_id`) WHERE `resolution_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_events_task_ts` ON `events` (`task_id`, `ts`);
--> statement-breakpoint
CREATE INDEX `idx_events_scope` ON `events` (`task_id`, `node_id`, `loop_iter`, `shard_key`, `iter`);
--> statement-breakpoint
CREATE INDEX `idx_events_kind` ON `events` (`task_id`, `kind`);
--> statement-breakpoint
CREATE INDEX `idx_events_parent` ON `events` (`parent_event_id`);
--> statement-breakpoint
CREATE TRIGGER `events_no_update`
BEFORE UPDATE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'INV-1: events table is append-only; UPDATE forbidden');
END;
