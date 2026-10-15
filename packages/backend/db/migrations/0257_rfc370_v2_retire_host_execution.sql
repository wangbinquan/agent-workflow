-- RFC-370 v2 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md):
-- the crash-only execution authority replaces the v1 host write contexts and the
-- memory distill execution receipts; no code reads or writes either table.
DROP TABLE `system_host_execution_write_contexts`;--> statement-breakpoint
DROP TABLE `memory_distill_execution_receipts`;
