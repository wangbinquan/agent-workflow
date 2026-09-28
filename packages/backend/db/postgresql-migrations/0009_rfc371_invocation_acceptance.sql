-- table: observation_invocations
CREATE TABLE "agent_workflow"."observation_invocations" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "canonical_execution" TEXT COLLATE "C" NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_invocations_pkey" PRIMARY KEY ("id")
);

-- index: observation_invocations:index:observation_invocation_execution_uq
CREATE UNIQUE INDEX "observation_invocation_execution_uq" ON "agent_workflow"."observation_invocations" ("canonical_execution");

-- index: observation_invocations:index:observation_invocation_task_idx
CREATE INDEX "observation_invocation_task_idx" ON "agent_workflow"."observation_invocations" ("task_id", "id");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:799edd05285d773e07ad9d704a90b0756df6604b892df220dd02a3cec8b95fd0', active_table_count = 192, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:04d316c1638d8d782a4645b7b21cf9e7cf5db537b9e58d54b21699276ea3c5a1' RETURNING contract_digest;
