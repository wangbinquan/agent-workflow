-- RFC-164 — workgroup engine tables, migration B of 3 (hand-written; additive;
-- registered in meta/_journal.json).
--
-- `workgroup_assignments`: dispatch cards / the free_collab shared task list
-- (one table, discriminated by assignee+source; id doubles as the member
-- run's shard_key). `workgroup_messages`: the room — dispatch/result/chat/
-- system messages; the ONLY blackboard (design §1.5). `workgroup_member_cursors`:
-- per-(task,member) consumption watermarks — wake decisions are idempotent
-- across daemon restarts (design §1.6, 设计门 Finding-3).
--
-- Purely additive. tasks link columns + builtin host seed land with
-- migration C (PR-3). See design/RFC-164-workgroup/design.md §1/§14.
CREATE TABLE IF NOT EXISTS `workgroup_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`created_by_run_id` text,
	`created_by_user_id` text,
	`assignee_member_id` text,
	`title` text NOT NULL,
	`brief_md` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`node_run_id` text,
	`result_message_id` text,
	`dedup_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_wg_assign_task` ON `workgroup_assignments` (`task_id`,`status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workgroup_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`author_kind` text NOT NULL,
	`author_member_id` text,
	`author_user_id` text,
	`kind` text NOT NULL,
	`body_md` text NOT NULL,
	`mentions_json` text DEFAULT '[]' NOT NULL,
	`assignment_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_wg_msg_task` ON `workgroup_messages` (`task_id`,`id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workgroup_member_cursors` (
	`task_id` text NOT NULL,
	`member_id` text NOT NULL,
	`last_consumed_message_id` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`task_id`, `member_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
