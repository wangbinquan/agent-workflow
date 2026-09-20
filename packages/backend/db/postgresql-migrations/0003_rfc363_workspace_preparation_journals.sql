-- table: sc_preparation_operations
CREATE TABLE "agent_workflow"."sc_preparation_operations" (
  "id" TEXT COLLATE "C" NOT NULL,
  "snapshot_ref" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'planned',
  "version" BIGINT NOT NULL DEFAULT 0,
  "resolved_json" TEXT COLLATE "C",
  "receipt_ref" TEXT COLLATE "C",
  "receipt_json" TEXT COLLATE "C",
  "failure_code" TEXT COLLATE "C",
  "diagnostics_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "sc_preparation_operations_pkey" PRIMARY KEY ("id")
);

-- table: sc_repository_snapshots
CREATE TABLE "agent_workflow"."sc_repository_snapshots" (
  "id" TEXT COLLATE "C" NOT NULL,
  "source_ref" TEXT COLLATE "C" NOT NULL,
  "revision" TEXT COLLATE "C" NOT NULL,
  "facts_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "sc_repository_snapshots_pkey" PRIMARY KEY ("id")
);

-- table: sc_repository_sources
CREATE TABLE "agent_workflow"."sc_repository_sources" (
  "id" TEXT COLLATE "C" NOT NULL,
  "request_key" TEXT COLLATE "C" NOT NULL,
  "request_digest" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "facts_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "sc_repository_sources_pkey" PRIMARY KEY ("id")
);

-- table: task_workspace_preparations
CREATE TABLE "agent_workflow"."task_workspace_preparations" (
  "id" TEXT COLLATE "C" NOT NULL,
  "admission_key" TEXT COLLATE "C" NOT NULL,
  "request_digest" TEXT COLLATE "C" NOT NULL,
  "lane" TEXT COLLATE "C" NOT NULL,
  "operation_ref" TEXT COLLATE "C",
  "artifact_json" TEXT COLLATE "C",
  "admitted_task_id" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'preparing',
  "owner_fence" BIGINT NOT NULL DEFAULT 0,
  "version" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "task_workspace_preparations_pkey" PRIMARY KEY ("id")
);

-- constraint: sc_preparation_operations:unique:sc_preparation_operations_receipt_ref_unique
ALTER TABLE "agent_workflow"."sc_preparation_operations" ADD CONSTRAINT "sc_preparation_operations_receipt_ref_unique" UNIQUE ("receipt_ref");

-- constraint: sc_preparation_operations:fk:sc_preparation_operations_snapshot_ref_sc_repository_snapshots_id_fk
ALTER TABLE "agent_workflow"."sc_preparation_operations" ADD CONSTRAINT "sc_preparation_operations_snapshot_ref_sc_reposito_9dc5f480f1b4" FOREIGN KEY ("snapshot_ref") REFERENCES "agent_workflow"."sc_repository_snapshots" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: sc_repository_snapshots:fk:sc_repository_snapshots_source_ref_sc_repository_sources_id_fk
ALTER TABLE "agent_workflow"."sc_repository_snapshots" ADD CONSTRAINT "sc_repository_snapshots_source_ref_sc_repository_sources_id_fk" FOREIGN KEY ("source_ref") REFERENCES "agent_workflow"."sc_repository_sources" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: sc_repository_sources:unique:sc_repository_sources_request_key_unique
ALTER TABLE "agent_workflow"."sc_repository_sources" ADD CONSTRAINT "sc_repository_sources_request_key_unique" UNIQUE ("request_key");

-- constraint: task_workspace_preparations:unique:task_workspace_preparations_admission_key_unique
ALTER TABLE "agent_workflow"."task_workspace_preparations" ADD CONSTRAINT "task_workspace_preparations_admission_key_unique" UNIQUE ("admission_key");

-- constraint: task_workspace_preparations:unique:task_workspace_preparations_admitted_task_id_unique
ALTER TABLE "agent_workflow"."task_workspace_preparations" ADD CONSTRAINT "task_workspace_preparations_admitted_task_id_unique" UNIQUE ("admitted_task_id");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:3e64b52d2ac2166405475f71c3160eac22c8617ee8822a108aa6fe2ca472c430', active_table_count = 182, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:0a8fe7af8576c0642020a55a1609f2fe48df69a22459234ba785f2148a69f4d4' RETURNING contract_digest;
