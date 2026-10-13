CREATE TABLE `memory_distill_execution_receipts` (
	`execution_ref` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_index` integer NOT NULL,
	`round_index` integer NOT NULL,
	`context_json` text NOT NULL,
	`retained_ref` text NOT NULL,
	`recovery_ref` text,
	`started_at` integer,
	`prepared_at` integer NOT NULL,
	`state` text NOT NULL,
	`terminal_json` text,
	`settlement` text,
	CONSTRAINT "memory_distill_execution_receipts_state_enum" CHECK("memory_distill_execution_receipts"."state" IN ('prepared', 'started', 'terminal', 'reaped', 'closed')),
	CONSTRAINT "memory_distill_execution_receipts_attempt_nonnegative" CHECK("memory_distill_execution_receipts"."attempt_index" >= 0),
	CONSTRAINT "memory_distill_execution_receipts_round_nonnegative" CHECK("memory_distill_execution_receipts"."round_index" >= 0),
	CONSTRAINT "memory_distill_execution_receipts_context_json_valid" CHECK(json_valid("memory_distill_execution_receipts"."context_json")),
	CONSTRAINT "memory_distill_execution_receipts_terminal_json_valid" CHECK("memory_distill_execution_receipts"."terminal_json" IS NULL OR json_valid("memory_distill_execution_receipts"."terminal_json"))
);--> statement-breakpoint
CREATE INDEX `idx_distill_execution_job_attempt` ON `memory_distill_execution_receipts` (`job_id`,`attempt_index`,`round_index`);--> statement-breakpoint
CREATE INDEX `idx_distill_execution_state_prepared` ON `memory_distill_execution_receipts` (`state`,`prepared_at`);
