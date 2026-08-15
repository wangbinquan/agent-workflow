-- RFC-304 PR-0 (T0b) — the `code-round` execution kind's discriminator.
--
-- `code_round_id` is what makes `taskExecutionKind()` return 'code-round'. The
-- kind stays DERIVED from row fields (same discipline as `workgroup_id` and
-- `source_agent_name`) instead of being stored as its own column, so a row can
-- never disagree with its own kind.
--
-- Soft reference by design (no FK): the round ledger lives in the
-- code-capability context while this row belongs to task-execution, and
-- deleting a work item must never cascade away the execution history of the
-- rounds it ran.
ALTER TABLE `tasks`
ADD COLUMN `code_round_id` text;
