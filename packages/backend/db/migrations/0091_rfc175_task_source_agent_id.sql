-- RFC-175 (§2e) — persist the launching agent's stable id on single-agent tasks
-- (hand-written; registered in meta/_journal.json). See
-- design/RFC-175-task-relaunch-param-prefill/design.md §2e.
--
-- Purely additive, nullable, no DEFAULT → ADD COLUMN succeeds on a non-empty
-- table and every existing row gets NULL. NOT backfilled (a name→id lookup
-- would itself hit the delete+recreate-same-name ABA the column exists to
-- close). The column is DORMANT until the RFC-175 launch/relaunch code wires it;
-- existing behavior is byte-for-byte unchanged at rest.
ALTER TABLE `tasks` ADD COLUMN `source_agent_id` text;
