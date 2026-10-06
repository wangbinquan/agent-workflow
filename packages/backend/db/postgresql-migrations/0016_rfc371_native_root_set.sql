-- table: task_execution_native_usage_root_heads
CREATE TABLE "agent_workflow"."task_execution_native_usage_root_heads" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "claim_fence" TEXT COLLATE "C",
  "protocol" TEXT COLLATE "C" NOT NULL,
  "next_ordinal" TEXT COLLATE "C" NOT NULL,
  "first_root_session_id" TEXT COLLATE "C" NOT NULL,
  "last_root_session_id" TEXT COLLATE "C" NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_root_heads_pkey" PRIMARY KEY ("invocation_id")
);

-- table: task_execution_native_usage_root_results
CREATE TABLE "agent_workflow"."task_execution_native_usage_root_results" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "result_id" TEXT COLLATE "C" NOT NULL,
  "root_session_id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_root_results_pkey" PRIMARY KEY ("invocation_id", "result_id", "root_session_id")
);

-- table: task_execution_native_usage_root_sets
CREATE TABLE "agent_workflow"."task_execution_native_usage_root_sets" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "next_ordinal" TEXT COLLATE "C" NOT NULL,
  "root_digest" TEXT COLLATE "C" NOT NULL,
  "process_watermark" TEXT COLLATE "C" NOT NULL,
  "observed_at" BIGINT NOT NULL,
  CONSTRAINT "task_execution_native_usage_root_sets_pkey" PRIMARY KEY ("invocation_id")
);

-- table: task_execution_native_usage_root_transitions
CREATE TABLE "agent_workflow"."task_execution_native_usage_root_transitions" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "ordinal_key" TEXT COLLATE "C" NOT NULL,
  "root_session_id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_root_transitions_pkey" PRIMARY KEY ("invocation_id", "ordinal_key")
);

-- index: task_execution_native_usage_root_transitions:index:native_usage_root_identity_idx
CREATE INDEX "native_usage_root_identity_idx" ON "agent_workflow"."task_execution_native_usage_root_transitions" ("invocation_id", "root_session_id");

-- constraint: task_execution_native_usage_root_heads:fk:task_execution_native_usage_root_heads_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_root_heads" ADD CONSTRAINT "task_execution_native_usage_root_heads_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_root_results:fk:task_execution_native_usage_root_results_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_root_results" ADD CONSTRAINT "task_execution_native_usage_root_results_invocatio_e9a248ae4f50" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."task_execution_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_root_sets:fk:task_execution_native_usage_root_sets_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_root_sets" ADD CONSTRAINT "task_execution_native_usage_root_sets_invocation_i_13d93e099559" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."task_execution_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_root_transitions:fk:task_execution_native_usage_root_transitions_invocation_id_task_execution_native_usage_root_heads_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_root_transitions" ADD CONSTRAINT "task_execution_native_usage_root_transitions_invoc_c0302dba6386" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."task_execution_native_usage_root_heads" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:ad118eb1d59bd9930e60e1789b070e713b6a1bc596d6b1f964849195d2b1bb1c', active_table_count = 215, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:e9073431b301f4759a5130406a6df904c69fe1dfdf4a96be6be82ee62fce4ee2' RETURNING contract_digest;
