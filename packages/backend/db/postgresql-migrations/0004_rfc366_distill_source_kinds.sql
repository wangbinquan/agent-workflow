-- constraint: memories:check:memories_source_kind_enum:drop
ALTER TABLE "agent_workflow"."memories" DROP CONSTRAINT "memories_source_kind_enum";

-- constraint: memories:check:memories_source_kind_enum
ALTER TABLE "agent_workflow"."memories" ADD CONSTRAINT "memories_source_kind_enum" CHECK ("source_kind" IN ('clarify','review','feedback','agent-run','task-run','manual'));

-- constraint: memory_distill_jobs:check:memory_distill_jobs_source_kind_enum:drop
ALTER TABLE "agent_workflow"."memory_distill_jobs" DROP CONSTRAINT "memory_distill_jobs_source_kind_enum";

-- constraint: memory_distill_jobs:check:memory_distill_jobs_source_kind_enum
ALTER TABLE "agent_workflow"."memory_distill_jobs" ADD CONSTRAINT "memory_distill_jobs_source_kind_enum" CHECK ("source_kind" IN ('clarify','review','feedback','agent-run','task-run'));

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:a27693137b6fd52a93912ee8d0e204ae58bb685bdcd2d80eb98538f9e07c9286', active_table_count = 182, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:3e64b52d2ac2166405475f71c3160eac22c8617ee8822a108aa6fe2ca472c430' RETURNING contract_digest;
