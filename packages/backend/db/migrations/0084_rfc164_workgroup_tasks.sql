-- RFC-164 — workgroup task launch, migration C of 3 (hand-written; additive;
-- registered in meta/_journal.json).
--
-- Two nullable link columns on `tasks` (NULL = not a workgroup task; same
-- durable-soft-link philosophy as scheduled_task_id). The builtin host
-- workflow row `__workgroup_host__` is NOT seeded here — a migration-seeded
-- row would surface in every fresh DB and break empty-fixture expectations
-- (workflow-service / backup tests); startWorkgroupTask lazily
-- INSERT-OR-IGNOREs it on first launch instead (ensureWorkgroupHostWorkflow,
-- services/workgroupLaunch.ts).
ALTER TABLE `tasks` ADD `workgroup_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `workgroup_config_json` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_workgroup` ON `tasks` (`workgroup_id`);
