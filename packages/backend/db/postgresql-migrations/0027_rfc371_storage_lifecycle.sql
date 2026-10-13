-- table: observation_report_leases
CREATE TABLE "agent_workflow"."observation_report_leases" (
  "id" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "request_key" TEXT COLLATE "C",
  "revision" TEXT COLLATE "C",
  "expires_at" BIGINT NOT NULL,
  "retiring" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "observation_report_leases_pkey" PRIMARY KEY ("id")
);

-- table: observation_scope_refs
CREATE TABLE "agent_workflow"."observation_scope_refs" (
  "view_id" TEXT COLLATE "C" NOT NULL,
  "scope" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_scope_refs_pkey" PRIMARY KEY ("view_id", "scope")
);

-- table: observation_storage_samples
CREATE TABLE "agent_workflow"."observation_storage_samples" (
  "day" TEXT COLLATE "C" NOT NULL,
  "sampled_at" BIGINT NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_storage_samples_pkey" PRIMARY KEY ("day")
);

-- table: observation_storage_state
CREATE TABLE "agent_workflow"."observation_storage_state" (
  "key" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_storage_state_pkey" PRIMARY KEY ("key")
);

-- table: observation_work_retention
CREATE TABLE "agent_workflow"."observation_work_retention" (
  "id" TEXT COLLATE "C" NOT NULL,
  "revision" TEXT COLLATE "C",
  "queued_at" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "observation_work_retention_pkey" PRIMARY KEY ("id")
);

-- index: observation_report_leases:index:observation_report_lease_request
CREATE UNIQUE INDEX "observation_report_lease_request" ON "agent_workflow"."observation_report_leases" ("request_key");

-- index: observation_report_leases:index:observation_report_lease_expiry
CREATE INDEX "observation_report_lease_expiry" ON "agent_workflow"."observation_report_leases" ("retiring", "expires_at");

-- index: observation_scope_refs:index:observation_scope_reference
CREATE INDEX "observation_scope_reference" ON "agent_workflow"."observation_scope_refs" ("scope");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:756df370ab27436daa9e84cc9bf0c15db8eebc4a60bd0f04dbce903c247c8f1e', active_table_count = 268, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:6f84095d2d88ef3c6157ed4e52956e7b8662cea495adc2219fc636997f1f308c' RETURNING contract_digest;
