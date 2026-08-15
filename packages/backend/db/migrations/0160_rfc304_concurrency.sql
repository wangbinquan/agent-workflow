-- RFC-304 PR-1c — the two concurrency invariants, made durable.
--
-- `code_work_items` gains the publish critical section marker and the single
-- merged pending revision. `publishing_epoch` non-null means a round is issuing
-- outbound writes at that epoch: while it is set, an arriving automated event
-- may only be registered as `pending_revision`, never advance the item to
-- `superseding`. That is the system's only linearization point — "re-check the
-- epoch before calling" is a TOCTOU, because a handler can bump the epoch
-- between the re-check and the HTTP leaving, and the stale output lands on the
-- MR anyway.
--
-- `code_mr_leases` is invariant two: `mr-review` and `mr-monitor` are separate
-- work items on the same MR and both can run, so without an MR-keyed lease the
-- monitor pushes a CI fix while the review comments on the old sha. The holder
-- is a ROUND, and the token carries the daemon generation so a lease left by a
-- dead process is reclaimable rather than blocking the MR until it expires.
--
-- `code_publish_intents` closes the duplicate-comment window: publish succeeds,
-- the daemon dies before the external ids are written back, and the next
-- round's reconciliation posts every finding a second time.
ALTER TABLE `code_work_items`
ADD COLUMN `publishing_epoch` integer
CHECK (`publishing_epoch` IS NULL OR `publishing_epoch` >= 1);--> statement-breakpoint
ALTER TABLE `code_work_items`
ADD COLUMN `pending_revision` text;--> statement-breakpoint

CREATE TABLE `code_mr_leases` (
	`lease_key` text PRIMARY KEY NOT NULL,
	`holder_round_id` text NOT NULL,
	`token` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_code_mr_leases_holder`
ON `code_mr_leases` (`holder_round_id`);--> statement-breakpoint
CREATE INDEX `idx_code_mr_leases_expiry`
ON `code_mr_leases` (`expires_at`);--> statement-breakpoint

CREATE TABLE `code_publish_intents` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`epoch` integer NOT NULL CHECK (`epoch` >= 1),
	`state` text NOT NULL DEFAULT 'pending' CHECK (`state` IN ('pending','settled','compensated','abandoned')),
	`fingerprints_json` text NOT NULL,
	`external_ids_json` text NOT NULL DEFAULT '{}',
	`anchor_ref` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer
);--> statement-breakpoint
CREATE INDEX `idx_code_publish_intents_round`
ON `code_publish_intents` (`round_id`);--> statement-breakpoint
CREATE INDEX `idx_code_publish_intents_state`
ON `code_publish_intents` (`state`);
