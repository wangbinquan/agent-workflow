-- RFC-242 §6.4 — explicit workgroup result anchor (executor outcome projection).
ALTER TABLE `workgroup_task_state` ADD COLUMN `result_message_id` text;
