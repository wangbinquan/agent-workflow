-- RFC-354 — execution frames. Every node_runs row now points at the wrapper
-- GENERATION row whose body it belongs to (`container_run_id`, NULL at the top
-- scope); `iteration` narrows to the round INSIDE that frame, so a nested
-- loop's rounds no longer collide with the outer loop's rows (audit S-6).
-- `scope_path` is the derived root→here breadcrumb for UI / diagnostics.
-- clarify_rounds gets the same frame column so a round opened inside a nested
-- loop is keyed by its frame, not by a flat loop counter.
--
-- Backfill of existing rows is NOT done here: it needs each task's workflow
-- snapshot (containment tree), which SQL cannot parse. The daemon runs the
-- durable backfill job at startup (`aw doctor --backfill-containers` is the
-- manual entry); until then existing rows read as top-scope rows.
ALTER TABLE `node_runs` ADD `container_run_id` text REFERENCES node_runs(id);--> statement-breakpoint
ALTER TABLE `node_runs` ADD `scope_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_node_runs_container` ON `node_runs` (`task_id`,`container_run_id`,`node_id`,`iteration`);--> statement-breakpoint
ALTER TABLE `clarify_rounds` ADD `container_run_id` text;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_clarify_rounds_asking`;--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_asking` ON `clarify_rounds` (`asking_node_id`,`container_run_id`,`loop_iter`,`iteration`);
