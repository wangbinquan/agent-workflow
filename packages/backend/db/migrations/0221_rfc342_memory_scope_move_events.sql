-- RFC-342 / RFC-294 P0-A — durable audit/event receipt for every committed
-- memory scope move.  The row is inserted in the same SQLite transaction as
-- the memory CAS.  It intentionally has no FK to memories/users: the receipt
-- must survive later cleanup of either mutable aggregate.

CREATE TABLE `memory_scope_move_events` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_source` text NOT NULL,
	`from_scope_type` text NOT NULL,
	`from_scope_id` text,
	`to_scope_type` text NOT NULL,
	`to_scope_id` text,
	`expected_version` integer NOT NULL,
	`resulting_version` integer NOT NULL,
	`correlation_id` text NOT NULL,
	`causation_id` text,
	`occurred_at` integer NOT NULL,
	CONSTRAINT `memory_scope_move_events_actor_source` CHECK(`actor_source` IN ('session','pat','daemon','cli','system')),
	CONSTRAINT `memory_scope_move_events_from_scope` CHECK((`from_scope_type` = 'global' AND `from_scope_id` IS NULL) OR (`from_scope_type` IN ('agent','workflow','repo','repo_group') AND `from_scope_id` IS NOT NULL AND length(`from_scope_id`) > 0)),
	CONSTRAINT `memory_scope_move_events_to_scope` CHECK((`to_scope_type` = 'global' AND `to_scope_id` IS NULL) OR (`to_scope_type` IN ('agent','workflow','repo','repo_group') AND `to_scope_id` IS NOT NULL AND length(`to_scope_id`) > 0)),
	CONSTRAINT `memory_scope_move_events_not_noop` CHECK(`from_scope_type` <> `to_scope_type` OR `from_scope_id` IS NOT `to_scope_id`),
	CONSTRAINT `memory_scope_move_events_version_step` CHECK(`expected_version` > 0 AND `resulting_version` = `expected_version` + 1),
	CONSTRAINT `memory_scope_move_events_time_nonnegative` CHECK(`occurred_at` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_memory_scope_move_events_memory_version`
	ON `memory_scope_move_events` (`memory_id`,`resulting_version`);
--> statement-breakpoint
CREATE INDEX `idx_memory_scope_move_events_occurred`
	ON `memory_scope_move_events` (`occurred_at`,`memory_id`);
