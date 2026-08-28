-- RFC-338 — durable admission/lease ledger for off-thread maintenance.
-- Business state remains in its owner tables; this ledger only makes a
-- scheduled slot, cursor and completion receipt crash-recoverable.

CREATE TABLE `maintenance_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `job_key` text NOT NULL,
  `job_class` text NOT NULL CHECK (`job_class` IN ('cleanup','recovery','checkpoint')),
  `slot_key` text NOT NULL,
  `cycle_key` text,
  `state` text NOT NULL CHECK (`state` IN ('pending','running','deferred','succeeded','failed')),
  `payload_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`payload_json`)),
  `cursor_version` integer DEFAULT 1 NOT NULL CHECK (`cursor_version` > 0),
  `cursor_json` text CHECK (`cursor_json` IS NULL OR json_valid(`cursor_json`)),
  `lease_token` text,
  `lease_expires_at` integer,
  `heartbeat_at` integer,
  `attempt` integer DEFAULT 0 NOT NULL CHECK (`attempt` >= 0),
  `slice_no` integer DEFAULT 0 NOT NULL CHECK (`slice_no` >= 0),
  `counters_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`counters_json`)),
  `error_code` text,
  `error_message` text,
  `scheduled_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `started_at` integer,
  `finished_at` integer,
  CHECK (
    (`state` = 'running' AND `lease_token` IS NOT NULL AND `lease_expires_at` IS NOT NULL) OR
    (`state` <> 'running')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_maintenance_runs_job_slot`
  ON `maintenance_runs` (`job_key`, `slot_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_maintenance_runs_one_running`
  ON `maintenance_runs` (`job_key`)
  WHERE `state` = 'running';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_maintenance_runs_one_queued`
  ON `maintenance_runs` (`job_key`)
  WHERE `state` IN ('pending','deferred');
--> statement-breakpoint
CREATE INDEX `idx_maintenance_runs_admission`
  ON `maintenance_runs` (`state`, `job_class`, `scheduled_at`);
--> statement-breakpoint
CREATE INDEX `idx_maintenance_runs_lease`
  ON `maintenance_runs` (`state`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_maintenance_runs_last`
  ON `maintenance_runs` (`finished_at`, `job_key`);
