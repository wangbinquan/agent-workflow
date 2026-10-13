-- table: observation_anomaly_history
CREATE TABLE "agent_workflow"."observation_anomaly_history" (
  "id" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C",
  "observed_at" BIGINT NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_anomaly_history_pkey" PRIMARY KEY ("id")
);

-- table: observation_anomaly_states
CREATE TABLE "agent_workflow"."observation_anomaly_states" (
  "key" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C",
  "document" TEXT COLLATE "C" NOT NULL,
  "source_revision" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_anomaly_states_pkey" PRIMARY KEY ("key")
);

-- table: observation_invocation_price_audit
CREATE TABLE "agent_workflow"."observation_invocation_price_audit" (
  "operation_id" TEXT COLLATE "C" NOT NULL,
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_invocation_price_audit_pkey" PRIMARY KEY ("operation_id", "invocation_id")
);

-- table: observation_invocation_price_policies
CREATE TABLE "agent_workflow"."observation_invocation_price_policies" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "operation_id" TEXT COLLATE "C" NOT NULL,
  "confirmed_at" BIGINT NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_invocation_price_policies_pkey" PRIMARY KEY ("invocation_id")
);

-- table: observation_invocation_price_records
CREATE TABLE "agent_workflow"."observation_invocation_price_records" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "record_id" TEXT COLLATE "C" NOT NULL,
  "operation_id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_invocation_price_records_pkey" PRIMARY KEY ("invocation_id", "source_id", "record_id")
);

-- table: observation_maintenance_members
CREATE TABLE "agent_workflow"."observation_maintenance_members" (
  "operation_id" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  CONSTRAINT "observation_maintenance_members_pkey" PRIMARY KEY ("operation_id", "key")
);

-- table: observation_maintenance_operations
CREATE TABLE "agent_workflow"."observation_maintenance_operations" (
  "id" TEXT COLLATE "C" NOT NULL,
  "request_key" TEXT COLLATE "C" NOT NULL,
  "actor_id" TEXT COLLATE "C" NOT NULL,
  "actor_scope" TEXT COLLATE "C" NOT NULL,
  "actor_document" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "source_revision" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "lease_token" TEXT COLLATE "C",
  "lease_until" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "observation_maintenance_operations_pkey" PRIMARY KEY ("id")
);

-- table: observation_projection_descriptors
CREATE TABLE "agent_workflow"."observation_projection_descriptors" (
  "key" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_descriptors_pkey" PRIMARY KEY ("key")
);

-- table: observation_projection_indexed_versions
CREATE TABLE "agent_workflow"."observation_projection_indexed_versions" (
  "revision" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_indexed_versions_pkey" PRIMARY KEY ("revision")
);

-- table: observation_projection_query_scope_members
CREATE TABLE "agent_workflow"."observation_projection_query_scope_members" (
  "scope" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "identity" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_query_scope_members_pkey" PRIMARY KEY ("scope", "kind", "identity")
);

-- table: observation_projection_query_scopes
CREATE TABLE "agent_workflow"."observation_projection_query_scopes" (
  "id" TEXT COLLATE "C" NOT NULL,
  "ready" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "observation_projection_query_scopes_pkey" PRIMARY KEY ("id")
);

-- index: observation_anomaly_history:index:observation_anomaly_task_time
CREATE INDEX "observation_anomaly_task_time" ON "agent_workflow"."observation_anomaly_history" ("task_id", "observed_at", "id");

-- index: observation_maintenance_operations:index:observation_maintenance_actor_request
CREATE UNIQUE INDEX "observation_maintenance_actor_request" ON "agent_workflow"."observation_maintenance_operations" ("actor_id", "request_key");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:6f84095d2d88ef3c6157ed4e52956e7b8662cea495adc2219fc636997f1f308c', active_table_count = 263, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:aeaf35a854b78e2a6afa7c4d8c0b5fe8412dda9dcc742388defeff8ff5c29c0f' RETURNING contract_digest;
