-- RFC-363 expand phase. No Task is created by preparation; records survive process restarts.
CREATE TABLE `sc_repository_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `request_key` text NOT NULL UNIQUE,
  `request_digest` text NOT NULL,
  `kind` text NOT NULL,
  `facts_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sc_repository_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `source_ref` text NOT NULL REFERENCES `sc_repository_sources` (`id`),
  `revision` text NOT NULL,
  `facts_json` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sc_preparation_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `snapshot_ref` text NOT NULL REFERENCES `sc_repository_snapshots` (`id`),
  `state` text DEFAULT 'planned' NOT NULL,
  `version` integer DEFAULT 0 NOT NULL,
  `resolved_json` text,
  `receipt_ref` text UNIQUE,
  `receipt_json` text,
  `failure_code` text,
  `diagnostics_json` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_workspace_preparations` (
  `id` text PRIMARY KEY NOT NULL,
  `admission_key` text NOT NULL UNIQUE,
  `request_digest` text NOT NULL,
  `lane` text NOT NULL,
  `operation_ref` text,
  `artifact_json` text,
  `admitted_task_id` text UNIQUE,
  `state` text DEFAULT 'preparing' NOT NULL,
  `owner_fence` integer DEFAULT 0 NOT NULL,
  `version` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
