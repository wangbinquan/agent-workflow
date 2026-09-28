CREATE TABLE `observation_invocations` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `canonical_execution` text NOT NULL,
  `fingerprint` text NOT NULL,
  `document` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_invocation_execution_uq` ON `observation_invocations` (`canonical_execution`);
--> statement-breakpoint
CREATE INDEX `observation_invocation_task_idx` ON `observation_invocations` (`task_id`, `id`);
