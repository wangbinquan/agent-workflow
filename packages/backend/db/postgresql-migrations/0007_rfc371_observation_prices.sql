-- table: observation_price_heads
CREATE TABLE "agent_workflow"."observation_price_heads" (
  "registration_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "observation_price_heads_pkey" PRIMARY KEY ("registration_id")
);

-- table: observation_price_versions
CREATE TABLE "agent_workflow"."observation_price_versions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "registration_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "request_key" TEXT COLLATE "C" NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  "configuration_revision" BIGINT NOT NULL,
  "protocol" TEXT COLLATE "C" NOT NULL,
  "provider" TEXT COLLATE "C" NOT NULL,
  "model" TEXT COLLATE "C" NOT NULL,
  "condition" TEXT COLLATE "C",
  "effective_from" BIGINT NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_price_versions_pkey" PRIMARY KEY ("id")
);

-- index: observation_price_versions:index:observation_price_revision_idx
CREATE UNIQUE INDEX "observation_price_revision_idx" ON "agent_workflow"."observation_price_versions" ("registration_id", "revision");

-- index: observation_price_versions:index:observation_price_request_idx
CREATE UNIQUE INDEX "observation_price_request_idx" ON "agent_workflow"."observation_price_versions" ("registration_id", "request_key");

-- index: observation_price_versions:index:observation_price_match_idx
CREATE INDEX "observation_price_match_idx" ON "agent_workflow"."observation_price_versions" ("registration_id", "configuration_revision", "protocol", "provider", "model", "condition", "effective_from");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:00667e4d68f1eb5de171729a79eef9b9507062b4fee5e9b02412d89eadf66f77', active_table_count = 188, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:85b914204bdf43d5d3333d819113b3c226c22376465d4540f5d74d1ae7866bf0' RETURNING contract_digest;
