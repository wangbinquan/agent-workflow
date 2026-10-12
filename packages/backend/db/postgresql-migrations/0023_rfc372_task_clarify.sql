-- table: task_clarify_channels
CREATE TABLE "agent_workflow"."task_clarify_channels" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "logical_key" TEXT COLLATE "C" NOT NULL,
  "asking_node_id" TEXT COLLATE "C" NOT NULL,
  "clarify_node_id" TEXT COLLATE "C" NOT NULL,
  "binding_digest" TEXT COLLATE "C" NOT NULL,
  "host_json" TEXT COLLATE "C" NOT NULL,
  "head_entry_ref" TEXT COLLATE "C",
  "entry_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "task_clarify_channels_pkey" PRIMARY KEY ("id")
);

-- table: task_clarify_consumptions
CREATE TABLE "agent_workflow"."task_clarify_consumptions" (
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "material_id" TEXT COLLATE "C" NOT NULL,
  "acceptance_ref" TEXT COLLATE "C" NOT NULL,
  "source_context_digest" TEXT COLLATE "C" NOT NULL,
  "snapshot_set_digest" TEXT COLLATE "C" NOT NULL,
  "finalized_prompt_digest" TEXT COLLATE "C" NOT NULL,
  "accepted_at" BIGINT NOT NULL,
  "consumed_at" BIGINT,
  CONSTRAINT "task_clarify_consumptions_pkey" PRIMARY KEY ("node_run_id")
);

-- table: task_clarify_entries
CREATE TABLE "agent_workflow"."task_clarify_entries" (
  "id" TEXT COLLATE "C" NOT NULL,
  "channel_id" TEXT COLLATE "C" NOT NULL,
  "entry_revision" BIGINT NOT NULL,
  "host_entry_key" TEXT COLLATE "C" NOT NULL,
  "host_json" TEXT COLLATE "C" NOT NULL,
  "source_asking_run_id" TEXT COLLATE "C" NOT NULL,
  "source_context_digest" TEXT COLLATE "C" NOT NULL,
  "source_context_json" TEXT COLLATE "C" NOT NULL,
  "config_snapshot_ref" TEXT COLLATE "C" NOT NULL,
  "trigger_json" TEXT COLLATE "C" NOT NULL,
  "request_id" TEXT COLLATE "C",
  "request_json" TEXT COLLATE "C",
  "previous_snapshot_id" TEXT COLLATE "C",
  "disposition" TEXT COLLATE "C" NOT NULL,
  "round_id" TEXT COLLATE "C",
  "gate_node_run_id" TEXT COLLATE "C",
  "snapshot_id" TEXT COLLATE "C",
  "completion_operation_id" TEXT COLLATE "C",
  "delivery_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "task_clarify_entries_pkey" PRIMARY KEY ("id")
);

-- table: task_clarify_host_runs
CREATE TABLE "agent_workflow"."task_clarify_host_runs" (
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "occurrence_ref" TEXT COLLATE "C" NOT NULL,
  "slot_key" TEXT COLLATE "C" NOT NULL,
  "inherited_from_run_id" TEXT COLLATE "C",
  "shard_instance_ref" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "task_clarify_host_runs_pkey" PRIMARY KEY ("node_run_id")
);

-- table: task_clarify_materials
CREATE TABLE "agent_workflow"."task_clarify_materials" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "entry_scope_ref" TEXT COLLATE "C" NOT NULL,
  "consumer_node_id" TEXT COLLATE "C" NOT NULL,
  "material_revision" BIGINT NOT NULL,
  "plan_id" TEXT COLLATE "C" NOT NULL,
  "source_context_digest" TEXT COLLATE "C" NOT NULL,
  "snapshot_set_digest" TEXT COLLATE "C" NOT NULL,
  "material_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "task_clarify_materials_pkey" PRIMARY KEY ("id")
);

-- index: task_clarify_channels:index:idx_task_clarify_channel_key
CREATE UNIQUE INDEX "idx_task_clarify_channel_key" ON "agent_workflow"."task_clarify_channels" ("task_id", "logical_key");

-- index: task_clarify_consumptions:index:idx_task_clarify_consumption_acceptance
CREATE UNIQUE INDEX "idx_task_clarify_consumption_acceptance" ON "agent_workflow"."task_clarify_consumptions" ("acceptance_ref");

-- index: task_clarify_consumptions:index:idx_task_clarify_consumption_material
CREATE INDEX "idx_task_clarify_consumption_material" ON "agent_workflow"."task_clarify_consumptions" ("material_id");

-- index: task_clarify_entries:index:idx_task_clarify_entry_request
CREATE UNIQUE INDEX "idx_task_clarify_entry_request" ON "agent_workflow"."task_clarify_entries" ("channel_id", "request_id");

-- index: task_clarify_entries:index:idx_task_clarify_entry_round
CREATE UNIQUE INDEX "idx_task_clarify_entry_round" ON "agent_workflow"."task_clarify_entries" ("round_id");

-- index: task_clarify_entries:index:idx_task_clarify_entry_source
CREATE INDEX "idx_task_clarify_entry_source" ON "agent_workflow"."task_clarify_entries" ("source_asking_run_id");

-- index: task_clarify_host_runs:index:idx_task_clarify_host_occurrence
CREATE INDEX "idx_task_clarify_host_occurrence" ON "agent_workflow"."task_clarify_host_runs" ("task_id", "occurrence_ref");

-- index: task_clarify_host_runs:index:idx_task_clarify_host_slot
CREATE INDEX "idx_task_clarify_host_slot" ON "agent_workflow"."task_clarify_host_runs" ("task_id", "slot_key");

-- index: task_clarify_materials:index:idx_task_clarify_material_version
CREATE UNIQUE INDEX "idx_task_clarify_material_version" ON "agent_workflow"."task_clarify_materials" ("entry_scope_ref", "consumer_node_id", "material_revision");

-- index: task_clarify_materials:index:idx_task_clarify_material_consumer
CREATE INDEX "idx_task_clarify_material_consumer" ON "agent_workflow"."task_clarify_materials" ("task_id", "consumer_node_id");

-- constraint: task_clarify_channels:fk:task_clarify_channels_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_clarify_channels" ADD CONSTRAINT "task_clarify_channels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_clarify_consumptions:fk:task_clarify_consumptions_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."task_clarify_consumptions" ADD CONSTRAINT "task_clarify_consumptions_node_run_id_node_runs_id_fk" FOREIGN KEY ("node_run_id") REFERENCES "agent_workflow"."node_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_clarify_consumptions:fk:task_clarify_consumptions_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_clarify_consumptions" ADD CONSTRAINT "task_clarify_consumptions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_clarify_consumptions:fk:task_clarify_consumptions_material_id_task_clarify_materials_id_fk
ALTER TABLE "agent_workflow"."task_clarify_consumptions" ADD CONSTRAINT "task_clarify_consumptions_material_id_task_clarify_349fa4a8348e" FOREIGN KEY ("material_id") REFERENCES "agent_workflow"."task_clarify_materials" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: task_clarify_entries:fk:task_clarify_entries_channel_id_task_clarify_channels_id_fk
ALTER TABLE "agent_workflow"."task_clarify_entries" ADD CONSTRAINT "task_clarify_entries_channel_id_task_clarify_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "agent_workflow"."task_clarify_channels" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_clarify_host_runs:fk:task_clarify_host_runs_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."task_clarify_host_runs" ADD CONSTRAINT "task_clarify_host_runs_node_run_id_node_runs_id_fk" FOREIGN KEY ("node_run_id") REFERENCES "agent_workflow"."node_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_clarify_host_runs:fk:task_clarify_host_runs_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_clarify_host_runs" ADD CONSTRAINT "task_clarify_host_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_clarify_materials:fk:task_clarify_materials_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_clarify_materials" ADD CONSTRAINT "task_clarify_materials_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_clarify_materials:fk:task_clarify_materials_entry_scope_ref_task_clarify_entries_id_fk
ALTER TABLE "agent_workflow"."task_clarify_materials" ADD CONSTRAINT "task_clarify_materials_entry_scope_ref_task_clarif_52d757845e9c" FOREIGN KEY ("entry_scope_ref") REFERENCES "agent_workflow"."task_clarify_entries" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:92f680cc5dacd69f83f87650ec1b6a9e7b21189911ade7780a8f507525c1a68d', active_table_count = 248, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:f093173a29f7875afcbd167fae1d2687cc3118431348a2f3a848acb8cb929d49' RETURNING contract_digest;
