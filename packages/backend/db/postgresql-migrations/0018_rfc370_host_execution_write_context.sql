-- table: system_host_execution_write_contexts
CREATE TABLE "agent_workflow"."system_host_execution_write_contexts" (
  "id" TEXT COLLATE "C" NOT NULL,
  "holder" TEXT COLLATE "C" NOT NULL,
  "generation" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "phase" TEXT COLLATE "C" NOT NULL,
  "expires_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "system_host_execution_write_contexts_pkey" PRIMARY KEY ("id")
);

-- constraint: system_host_execution_write_contexts:check:host_execution_write_singleton_ck
ALTER TABLE "agent_workflow"."system_host_execution_write_contexts" ADD CONSTRAINT "host_execution_write_singleton_ck" CHECK ("id" = 'installation');

-- constraint: system_host_execution_write_contexts:check:host_execution_write_revision_ck
ALTER TABLE "agent_workflow"."system_host_execution_write_contexts" ADD CONSTRAINT "host_execution_write_revision_ck" CHECK ("revision" > 0);

-- constraint: system_host_execution_write_contexts:check:host_execution_write_phase_ck
ALTER TABLE "agent_workflow"."system_host_execution_write_contexts" ADD CONSTRAINT "host_execution_write_phase_ck" CHECK ("phase" IN ('preparing','active','draining','closed'));

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:012cce37c527334d3a966f13274636baca3d2f5901736cb43b3923acd28d1f50', active_table_count = 217, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:7123a13ba607ab51076656280e9bca40f36369df085f2c017693b8768eb63e11' RETURNING contract_digest;
