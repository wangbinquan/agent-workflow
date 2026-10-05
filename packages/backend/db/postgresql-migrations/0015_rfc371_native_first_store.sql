-- table: task_execution_native_usage_store_bindings
CREATE TABLE "agent_workflow"."task_execution_native_usage_store_bindings" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "before_owner_receipt_id" TEXT COLLATE "C" NOT NULL,
  "source_generation" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_store_bindings_pkey" PRIMARY KEY ("invocation_id")
);

-- constraint: task_execution_native_usage_store_bindings:fk:task_execution_native_usage_store_bindings_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_store_bindings" ADD CONSTRAINT "task_execution_native_usage_store_bindings_invocat_645ed6f86ac2" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."task_execution_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:e9073431b301f4759a5130406a6df904c69fe1dfdf4a96be6be82ee62fce4ee2', active_table_count = 211, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:84d3103ed75deab383bbed787f018a9ae0d79fdc7b33ec205075f1cffdb3c2c4' RETURNING contract_digest;
