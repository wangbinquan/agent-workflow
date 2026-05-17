ALTER TABLE `node_run_events` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `node_run_events` ADD `parent_session_id` text;--> statement-breakpoint
CREATE INDEX `idx_events_session` ON `node_run_events` (`node_run_id`,`session_id`,`id`);