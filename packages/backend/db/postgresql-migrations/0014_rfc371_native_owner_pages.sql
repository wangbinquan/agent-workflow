-- table: task_execution_native_usage_emissions
CREATE TABLE "agent_workflow"."task_execution_native_usage_emissions" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "event_id" TEXT COLLATE "C" NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  "source_row_id" BIGINT NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "ack" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_emissions_pkey" PRIMARY KEY ("invocation_id", "event_id")
);

-- table: task_execution_native_usage_pass_heads
CREATE TABLE "agent_workflow"."task_execution_native_usage_pass_heads" (
  "key" TEXT COLLATE "C" NOT NULL,
  "pass_id" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_pass_heads_pkey" PRIMARY KEY ("key")
);

-- table: task_execution_native_usage_pass_pages
CREATE TABLE "agent_workflow"."task_execution_native_usage_pass_pages" (
  "pass_id" TEXT COLLATE "C" NOT NULL,
  "ordinal" TEXT COLLATE "C" NOT NULL,
  "payload_digest" TEXT COLLATE "C" NOT NULL,
  "cumulative_digest" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "ack" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_pass_pages_pkey" PRIMARY KEY ("pass_id", "ordinal")
);

-- table: task_execution_native_usage_passes
CREATE TABLE "agent_workflow"."task_execution_native_usage_passes" (
  "pass_id" TEXT COLLATE "C" NOT NULL,
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "head_key" TEXT COLLATE "C" NOT NULL,
  "owner_receipt_id" TEXT COLLATE "C" NOT NULL,
  "identity" TEXT COLLATE "C" NOT NULL,
  "initial_cursor" TEXT COLLATE "C" NOT NULL,
  "admission" TEXT COLLATE "C" NOT NULL,
  "root_created_at" BIGINT,
  "state" TEXT COLLATE "C" NOT NULL,
  "next_ordinal" TEXT COLLATE "C" NOT NULL,
  "next_cursor" TEXT COLLATE "C",
  "digest" TEXT COLLATE "C" NOT NULL,
  "position" TEXT COLLATE "C" NOT NULL,
  "counts" TEXT COLLATE "C" NOT NULL,
  "last_ack" TEXT COLLATE "C",
  "interruption" TEXT COLLATE "C",
  CONSTRAINT "task_execution_native_usage_passes_pkey" PRIMARY KEY ("pass_id")
);

-- table: task_execution_native_usage_preparations
CREATE TABLE "agent_workflow"."task_execution_native_usage_preparations" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "owner_receipt_id" TEXT COLLATE "C" NOT NULL,
  "fence" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_preparations_pkey" PRIMARY KEY ("invocation_id")
);

-- table: task_execution_native_usage_revision_heads
CREATE TABLE "agent_workflow"."task_execution_native_usage_revision_heads" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "record_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  CONSTRAINT "task_execution_native_usage_revision_heads_pkey" PRIMARY KEY ("invocation_id", "record_id")
);

-- table: task_execution_native_usage_session_parents
CREATE TABLE "agent_workflow"."task_execution_native_usage_session_parents" (
  "pass_id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "parent_session_id" TEXT COLLATE "C",
  "ordinal" TEXT COLLATE "C" NOT NULL,
  "path_digest" TEXT COLLATE "C" NOT NULL,
  "depth" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_session_parents_pkey" PRIMARY KEY ("pass_id", "session_id")
);

-- table: task_execution_native_usage_step_members
CREATE TABLE "agent_workflow"."task_execution_native_usage_step_members" (
  "pass_id" TEXT COLLATE "C" NOT NULL,
  "step_id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "ordinal" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "task_execution_native_usage_step_members_pkey" PRIMARY KEY ("pass_id", "step_id")
);

-- index: task_execution_native_usage_emissions:index:native_usage_emission_source_idx
CREATE INDEX "native_usage_emission_source_idx" ON "agent_workflow"."task_execution_native_usage_emissions" ("source_row_id");

-- index: task_execution_native_usage_passes:index:native_usage_pass_invocation_idx
CREATE INDEX "native_usage_pass_invocation_idx" ON "agent_workflow"."task_execution_native_usage_passes" ("invocation_id", "pass_id");

-- index: task_execution_native_usage_preparations:index:native_usage_preparation_task_idx
CREATE INDEX "native_usage_preparation_task_idx" ON "agent_workflow"."task_execution_native_usage_preparations" ("task_id", "invocation_id");

-- constraint: task_execution_native_usage_emissions:fk:task_execution_native_usage_emissions_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_emissions" ADD CONSTRAINT "task_execution_native_usage_emissions_invocation_i_736e4f7e9eac" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."task_execution_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_pass_heads:fk:task_execution_native_usage_pass_heads_pass_id_task_execution_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_pass_heads" ADD CONSTRAINT "task_execution_native_usage_pass_heads_pass_id_tas_e85116aac2c2" FOREIGN KEY ("pass_id") REFERENCES "agent_workflow"."task_execution_native_usage_passes" ("pass_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_pass_pages:fk:task_execution_native_usage_pass_pages_pass_id_task_execution_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_pass_pages" ADD CONSTRAINT "task_execution_native_usage_pass_pages_pass_id_tas_8979c549fa87" FOREIGN KEY ("pass_id") REFERENCES "agent_workflow"."task_execution_native_usage_passes" ("pass_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_passes:check:native_usage_pass_state_ck
ALTER TABLE "agent_workflow"."task_execution_native_usage_passes" ADD CONSTRAINT "native_usage_pass_state_ck" CHECK ("state" IN ('open','eof','interrupted','superseded'));

-- constraint: task_execution_native_usage_passes:fk:task_execution_native_usage_passes_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_passes" ADD CONSTRAINT "task_execution_native_usage_passes_invocation_id_t_9642d172b21a" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."task_execution_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_preparations:check:native_usage_preparation_state_ck
ALTER TABLE "agent_workflow"."task_execution_native_usage_preparations" ADD CONSTRAINT "native_usage_preparation_state_ck" CHECK ("state" IN ('open','sealed'));

-- constraint: task_execution_native_usage_preparations:fk:task_execution_native_usage_preparations_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_preparations" ADD CONSTRAINT "task_execution_native_usage_preparations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_revision_heads:fk:task_execution_native_usage_revision_heads_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_revision_heads" ADD CONSTRAINT "task_execution_native_usage_revision_heads_invocat_90a718d767b1" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."task_execution_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_session_parents:fk:task_execution_native_usage_session_parents_pass_id_task_execution_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_session_parents" ADD CONSTRAINT "task_execution_native_usage_session_parents_pass_i_b04e34343ffb" FOREIGN KEY ("pass_id") REFERENCES "agent_workflow"."task_execution_native_usage_passes" ("pass_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_native_usage_step_members:fk:task_execution_native_usage_step_members_pass_id_task_execution_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_step_members" ADD CONSTRAINT "task_execution_native_usage_step_members_pass_id_t_9fe3e7734a66" FOREIGN KEY ("pass_id") REFERENCES "agent_workflow"."task_execution_native_usage_passes" ("pass_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:84d3103ed75deab383bbed787f018a9ae0d79fdc7b33ec205075f1cffdb3c2c4', active_table_count = 210, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:a76becc4828a1999aca866a29860fa5ba23e6cad21fd9eecbe48434fe8f18cc1' RETURNING contract_digest;
