-- table: observation_native_fact_pages
CREATE TABLE "agent_workflow"."observation_native_fact_pages" (
  "cache_key" TEXT COLLATE "C" NOT NULL,
  "cursor" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_native_fact_pages_pkey" PRIMARY KEY ("cache_key", "cursor")
);

-- table: observation_native_fact_roots
CREATE TABLE "agent_workflow"."observation_native_fact_roots" (
  "cache_key" TEXT COLLATE "C" NOT NULL,
  "proof_key" TEXT COLLATE "C" NOT NULL,
  "root_session_id" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_native_fact_roots_pkey" PRIMARY KEY ("cache_key")
);

-- index: observation_native_fact_roots:index:observation_native_fact_epoch_idx
CREATE INDEX "observation_native_fact_epoch_idx" ON "agent_workflow"."observation_native_fact_roots" ("proof_key", "cache_key");

-- constraint: observation_native_fact_pages:fk:observation_native_fact_pages_cache_key_observation_native_fact_roots_cache_key_fk
ALTER TABLE "agent_workflow"."observation_native_fact_pages" ADD CONSTRAINT "observation_native_fact_pages_cache_key_observatio_1042bfaae129" FOREIGN KEY ("cache_key") REFERENCES "agent_workflow"."observation_native_fact_roots" ("cache_key") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: observation_native_fact_roots:check:observation_native_fact_state_ck
ALTER TABLE "agent_workflow"."observation_native_fact_roots" ADD CONSTRAINT "observation_native_fact_state_ck" CHECK ("state" = 'sealed');

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:4b1883057f5a2b4096f238e5a2d088f856af2df07fa808db9cde7a08e10ca989', active_table_count = 235, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:14bbd9c6f45a4f4c35452a2bcce3bbed7979c7741f8c20d58ce0458cc395c4d9' RETURNING contract_digest;
