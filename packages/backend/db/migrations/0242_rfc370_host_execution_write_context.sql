CREATE TABLE `system_host_execution_write_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`generation` text NOT NULL,
	`revision` integer NOT NULL,
	`phase` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "host_execution_write_singleton_ck" CHECK("system_host_execution_write_contexts"."id" = 'installation'),
	CONSTRAINT "host_execution_write_revision_ck" CHECK("system_host_execution_write_contexts"."revision" > 0),
	CONSTRAINT "host_execution_write_phase_ck" CHECK("system_host_execution_write_contexts"."phase" IN ('preparing','active','draining','closed'))
);
