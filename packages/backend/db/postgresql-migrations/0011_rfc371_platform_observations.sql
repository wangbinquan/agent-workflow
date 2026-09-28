-- table: observation_platform_records
CREATE TABLE "agent_workflow"."observation_platform_records" (
  "id" TEXT COLLATE "C" NOT NULL,
  "source_key" TEXT COLLATE "C" NOT NULL,
  "generation" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_platform_records_pkey" PRIMARY KEY ("id")
);

-- table: observation_platform_sources
CREATE TABLE "agent_workflow"."observation_platform_sources" (
  "id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_platform_sources_pkey" PRIMARY KEY ("id")
);

-- index: observation_platform_records:index:observation_platform_generation_idx
CREATE INDEX "observation_platform_generation_idx" ON "agent_workflow"."observation_platform_records" ("source_key", "generation", "id");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:46a167b740646dee8344022bbdde8462ce38090b178016996a4341313a83fb92', active_table_count = 195, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:f25b12861dee6ead97e6f066776794739217086c2d38f21474dd2015f539b1cb' RETURNING contract_digest;
