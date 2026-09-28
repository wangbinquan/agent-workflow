-- table: observation_usage_captures
CREATE TABLE "agent_workflow"."observation_usage_captures" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "source_cursor" TEXT COLLATE "C" NOT NULL,
  "native_root_key" TEXT COLLATE "C",
  "prior_revision_gap" BIGINT NOT NULL DEFAULT 0,
  "repair_pending" BIGINT NOT NULL DEFAULT 0,
  "document" TEXT COLLATE "C" NOT NULL,
  "summary" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_usage_captures_pkey" PRIMARY KEY ("invocation_id")
);

-- table: observation_usage_native_records
CREATE TABLE "agent_workflow"."observation_usage_native_records" (
  "id" TEXT COLLATE "C" NOT NULL,
  "native_source" TEXT COLLATE "C" NOT NULL,
  "native_root" TEXT COLLATE "C" NOT NULL,
  "record_id" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_usage_native_records_pkey" PRIMARY KEY ("id")
);

-- index: observation_usage_captures:index:observation_capture_task_idx
CREATE INDEX "observation_capture_task_idx" ON "agent_workflow"."observation_usage_captures" ("task_id", "invocation_id");

-- index: observation_usage_captures:index:observation_capture_root_gap_idx
CREATE INDEX "observation_capture_root_gap_idx" ON "agent_workflow"."observation_usage_captures" ("native_root_key", "prior_revision_gap");

-- index: observation_usage_captures:index:observation_capture_pending_idx
CREATE INDEX "observation_capture_pending_idx" ON "agent_workflow"."observation_usage_captures" ("repair_pending", "invocation_id");

-- index: observation_usage_native_records:index:observation_usage_native_step_idx
CREATE INDEX "observation_usage_native_step_idx" ON "agent_workflow"."observation_usage_native_records" ("native_source", "native_root", "record_id");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:adabb68099bbd7e59fd320b658db36b20786fcaecafe8994a0721f624e0bdaa6', active_table_count = 197, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:46a167b740646dee8344022bbdde8462ce38090b178016996a4341313a83fb92' RETURNING contract_digest;
