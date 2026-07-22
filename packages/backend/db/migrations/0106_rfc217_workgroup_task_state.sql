-- RFC-217 T2 — workgroup runtime state leaves the untyped JSON slots.
-- 1) new 1:1 table; 2) backfill from $.gate/$.dw/$.wgPause (declared-only
-- crash window maps to 'declared', NOT 'idle' — design-gate P1); 3) strip the
-- retired slots (incl. the RFC-207 `autonomous` corpse) so the config column
-- is a pure frozen config again; 4) stamp historical leader idle-nudge rows
-- with the new dedicated kind (the counter stops keying on exact bodyMd).
CREATE TABLE `workgroup_task_state` (
	`task_id` text PRIMARY KEY NOT NULL REFERENCES `tasks`(`id`) ON DELETE cascade,
	`gate_status` text DEFAULT 'idle' NOT NULL,
	`gate_summary` text,
	`gate_rejected_comment` text,
	`pause_reason` text,
	`dw_state_json` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `workgroup_task_state` (`task_id`, `gate_status`, `gate_summary`, `gate_rejected_comment`, `pause_reason`, `dw_state_json`, `updated_at`)
SELECT
	`id`,
	CASE
		WHEN json_extract(`workgroup_config_json`, '$.gate.approved') = 1 THEN 'approved'
		WHEN json_extract(`workgroup_config_json`, '$.gate.awaitingConfirmation') = 1 THEN 'awaiting_confirmation'
		WHEN json_extract(`workgroup_config_json`, '$.gate.rejected') = 1 THEN 'rejected'
		WHEN json_extract(`workgroup_config_json`, '$.gate.declaredDone') = 1 THEN 'declared'
		ELSE 'idle'
	END,
	json_extract(`workgroup_config_json`, '$.gate.summary'),
	json_extract(`workgroup_config_json`, '$.gate.rejectedComment'),
	json_extract(`workgroup_config_json`, '$.wgPause.reason'),
	json_extract(`workgroup_config_json`, '$.dw'),
	unixepoch() * 1000
FROM `tasks`
WHERE `workgroup_id` IS NOT NULL AND `workgroup_config_json` IS NOT NULL;
--> statement-breakpoint
UPDATE `tasks`
SET `workgroup_config_json` = json_remove(`workgroup_config_json`, '$.gate', '$.dw', '$.wgPause', '$.autonomous')
WHERE `workgroup_id` IS NOT NULL AND `workgroup_config_json` IS NOT NULL;
--> statement-breakpoint
UPDATE `workgroup_messages`
SET `kind` = 'nudge'
WHERE `author_kind` = 'system'
	AND `kind` = 'chat'
	AND `body_md` = 'Autonomous mode: you ended a round without dispatching work or declaring done. If the goal is complete, emit wg_decision done; otherwise dispatch the next assignment(s) or say what is blocking.';
