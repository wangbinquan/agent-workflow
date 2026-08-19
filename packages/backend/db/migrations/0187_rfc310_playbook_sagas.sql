CREATE TABLE `development_step_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`employee_revision` integer NOT NULL,
	`step_id` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`input_digest` text NOT NULL,
	`producer_kind` text NOT NULL,
	`state` text DEFAULT 'claimed' NOT NULL,
	`decision_id` text,
	`action_run_id` text,
	`deadline_at` integer,
	`output_ref` text,
	`output_revision` text,
	`failure_category` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`mission_id`) REFERENCES `development_missions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_step_runs_replay_unique` ON `development_step_runs` (`mission_id`,`employee_id`,`employee_revision`,`step_id`,`attempt`,`input_digest`);
--> statement-breakpoint
CREATE INDEX `idx_dev_step_runs_mission_state` ON `development_step_runs` (`mission_id`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_dev_step_runs_action` ON `development_step_runs` (`action_run_id`);
--> statement-breakpoint
CREATE TABLE `development_mission_links` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_mission_id` text NOT NULL,
	`parent_step_run_id` text NOT NULL,
	`target_repository_id` text NOT NULL,
	`target_employee_id` text NOT NULL,
	`target_employee_revision` integer NOT NULL,
	`input_digest` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`child_mission_id` text,
	`completion` text NOT NULL,
	`state` text DEFAULT 'creating' NOT NULL,
	`latest_child_revision` integer,
	`latest_status` text,
	`completion_satisfied` integer DEFAULT 0 NOT NULL,
	`output_ref` text,
	`observed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_mission_id`) REFERENCES `development_missions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_step_run_id`) REFERENCES `development_step_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_mission_id`) REFERENCES `development_missions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_mission_links_idem_unique` ON `development_mission_links` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_dev_mission_links_parent` ON `development_mission_links` (`parent_mission_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_mission_links_child_unique` ON `development_mission_links` (`child_mission_id`);
--> statement-breakpoint
CREATE TABLE `development_approval_sagas` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`step_run_id` text NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_revision` integer NOT NULL,
	`draft_ref` text NOT NULL,
	`submit_intent_digest` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`correlation_ref` text,
	`external_request_ref` text,
	`submitted_revision` text,
	`latest_status` text DEFAULT 'submitting' NOT NULL,
	`observed_revision` text,
	`evidence_ref` text,
	`deadline_at` integer NOT NULL,
	`attempt_ordinal` integer DEFAULT 0 NOT NULL,
	`next_observe_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`mission_id`) REFERENCES `development_missions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_run_id`) REFERENCES `development_step_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dev_approval_sagas_idem_unique` ON `development_approval_sagas` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_dev_approval_sagas_mission` ON `development_approval_sagas` (`mission_id`);
--> statement-breakpoint
CREATE INDEX `idx_dev_approval_sagas_correlation` ON `development_approval_sagas` (`correlation_ref`);
--> statement-breakpoint
CREATE TABLE `development_step_joins` (
	`mission_id` text NOT NULL,
	`group_id` text NOT NULL,
	`member_step_id` text NOT NULL,
	`mode` text NOT NULL,
	`quorum` integer,
	`deadline_at` integer NOT NULL,
	`member_state` text DEFAULT 'pending' NOT NULL,
	`receipt_revision` text,
	`settled_result` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`mission_id`,`group_id`,`member_step_id`),
	FOREIGN KEY (`mission_id`) REFERENCES `development_missions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_dev_step_joins_pending` ON `development_step_joins` (`mission_id`,`settled_result`);
