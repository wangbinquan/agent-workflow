-- table: observation_usage_sources
CREATE TABLE "agent_workflow"."observation_usage_sources" (
  "source_id" TEXT COLLATE "C" NOT NULL,
  "cursor" TEXT COLLATE "C",
  CONSTRAINT "observation_usage_sources_pkey" PRIMARY KEY ("source_id")
);

-- table: observation_usage_current
CREATE TABLE "agent_workflow"."observation_usage_current" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_usage_current_pkey" PRIMARY KEY ("id")
);

-- table: observation_usage_events
CREATE TABLE "agent_workflow"."observation_usage_events" (
  "id" TEXT COLLATE "C" NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "event_id" TEXT COLLATE "C" NOT NULL,
  "record_key" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  "outcome" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_usage_events_pkey" PRIMARY KEY ("id")
);

-- index: observation_usage_current:index:observation_usage_task_idx
CREATE INDEX "observation_usage_task_idx" ON "agent_workflow"."observation_usage_current" ("task_id", "id");

-- index: observation_usage_events:index:observation_usage_revision_idx
CREATE INDEX "observation_usage_revision_idx" ON "agent_workflow"."observation_usage_events" ("record_key", "revision");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:04d316c1638d8d782a4645b7b21cf9e7cf5db537b9e58d54b21699276ea3c5a1', active_table_count = 191, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:00667e4d68f1eb5de171729a79eef9b9507062b4fee5e9b02412d89eadf66f77' RETURNING contract_digest;
