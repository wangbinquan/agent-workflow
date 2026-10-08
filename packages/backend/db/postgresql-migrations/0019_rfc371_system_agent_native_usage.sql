-- table: system_agent_native_usage_emissions
CREATE TABLE "agent_workflow"."system_agent_native_usage_emissions" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "event_id" TEXT COLLATE "C" NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  "source_row_id" BIGINT NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "ack" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_emissions_pkey" PRIMARY KEY ("invocation_id", "event_id")
);

-- table: system_agent_native_usage_pass_heads
CREATE TABLE "agent_workflow"."system_agent_native_usage_pass_heads" (
  "key" TEXT COLLATE "C" NOT NULL,
  "pass_id" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_pass_heads_pkey" PRIMARY KEY ("key")
);

-- table: system_agent_native_usage_pass_pages
CREATE TABLE "agent_workflow"."system_agent_native_usage_pass_pages" (
  "pass_id" TEXT COLLATE "C" NOT NULL,
  "ordinal" TEXT COLLATE "C" NOT NULL,
  "payload_digest" TEXT COLLATE "C" NOT NULL,
  "cumulative_digest" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "ack" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_pass_pages_pkey" PRIMARY KEY ("pass_id", "ordinal")
);

-- table: system_agent_native_usage_passes
CREATE TABLE "agent_workflow"."system_agent_native_usage_passes" (
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
  CONSTRAINT "system_agent_native_usage_passes_pkey" PRIMARY KEY ("pass_id")
);

-- table: system_agent_native_usage_preparations
CREATE TABLE "agent_workflow"."system_agent_native_usage_preparations" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "owner_receipt_id" TEXT COLLATE "C" NOT NULL,
  "fence" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_preparations_pkey" PRIMARY KEY ("invocation_id")
);

-- table: system_agent_native_usage_revision_heads
CREATE TABLE "agent_workflow"."system_agent_native_usage_revision_heads" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "record_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  CONSTRAINT "system_agent_native_usage_revision_heads_pkey" PRIMARY KEY ("invocation_id", "record_id")
);

-- table: system_agent_native_usage_root_heads
CREATE TABLE "agent_workflow"."system_agent_native_usage_root_heads" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "claim_fence" TEXT COLLATE "C",
  "protocol" TEXT COLLATE "C" NOT NULL,
  "next_ordinal" TEXT COLLATE "C" NOT NULL,
  "first_root_session_id" TEXT COLLATE "C" NOT NULL,
  "last_root_session_id" TEXT COLLATE "C" NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_root_heads_pkey" PRIMARY KEY ("invocation_id")
);

-- table: system_agent_native_usage_root_results
CREATE TABLE "agent_workflow"."system_agent_native_usage_root_results" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "result_id" TEXT COLLATE "C" NOT NULL,
  "root_session_id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_root_results_pkey" PRIMARY KEY ("invocation_id", "result_id", "root_session_id")
);

-- table: system_agent_native_usage_root_sets
CREATE TABLE "agent_workflow"."system_agent_native_usage_root_sets" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "next_ordinal" TEXT COLLATE "C" NOT NULL,
  "root_digest" TEXT COLLATE "C" NOT NULL,
  "process_watermark" TEXT COLLATE "C" NOT NULL,
  "observed_at" BIGINT NOT NULL,
  CONSTRAINT "system_agent_native_usage_root_sets_pkey" PRIMARY KEY ("invocation_id")
);

-- table: system_agent_native_usage_root_transitions
CREATE TABLE "agent_workflow"."system_agent_native_usage_root_transitions" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "ordinal_key" TEXT COLLATE "C" NOT NULL,
  "root_session_id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_root_transitions_pkey" PRIMARY KEY ("invocation_id", "ordinal_key")
);

-- table: system_agent_native_usage_session_parents
CREATE TABLE "agent_workflow"."system_agent_native_usage_session_parents" (
  "pass_id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "parent_session_id" TEXT COLLATE "C",
  "ordinal" TEXT COLLATE "C" NOT NULL,
  "path_digest" TEXT COLLATE "C" NOT NULL,
  "depth" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_session_parents_pkey" PRIMARY KEY ("pass_id", "session_id")
);

-- table: system_agent_native_usage_step_members
CREATE TABLE "agent_workflow"."system_agent_native_usage_step_members" (
  "pass_id" TEXT COLLATE "C" NOT NULL,
  "step_id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "ordinal" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_step_members_pkey" PRIMARY KEY ("pass_id", "step_id")
);

-- table: system_agent_native_usage_store_bindings
CREATE TABLE "agent_workflow"."system_agent_native_usage_store_bindings" (
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "before_owner_receipt_id" TEXT COLLATE "C" NOT NULL,
  "source_generation" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_native_usage_store_bindings_pkey" PRIMARY KEY ("invocation_id")
);

-- table: system_agent_observation_groups
CREATE TABLE "agent_workflow"."system_agent_observation_groups" (
  "id" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "original_id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "parent_task_id" TEXT COLLATE "C",
  "owner_user_id" TEXT COLLATE "C",
  "started_at" BIGINT NOT NULL,
  "finished_at" BIGINT,
  "status" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "system_agent_observation_groups_pkey" PRIMARY KEY ("id")
);

-- table: system_agent_observation_owners
CREATE TABLE "agent_workflow"."system_agent_observation_owners" (
  "id" TEXT COLLATE "C" NOT NULL,
  "group_id" TEXT COLLATE "C" NOT NULL,
  "original_attempt" TEXT COLLATE "C" NOT NULL,
  "agent_id" TEXT COLLATE "C",
  "agent_name" TEXT COLLATE "C" NOT NULL,
  "agent_revision" BIGINT,
  "purpose" TEXT COLLATE "C" NOT NULL,
  "runtime" TEXT COLLATE "C" NOT NULL,
  "owner_nonce" TEXT COLLATE "C" NOT NULL,
  "started_at" BIGINT NOT NULL,
  "finished_at" BIGINT,
  "outcome" TEXT COLLATE "C",
  CONSTRAINT "system_agent_observation_owners_pkey" PRIMARY KEY ("id")
);

-- table: system_agent_observation_sources
CREATE TABLE "agent_workflow"."system_agent_observation_sources" (
  "id" BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "evidence_json" TEXT COLLATE "C" NOT NULL,
  "pending" BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT "system_agent_observation_sources_pkey" PRIMARY KEY ("id")
);

-- index: system_agent_native_usage_emissions:index:system_native_usage_emission_source_idx
CREATE INDEX "system_native_usage_emission_source_idx" ON "agent_workflow"."system_agent_native_usage_emissions" ("source_row_id");

-- index: system_agent_native_usage_passes:index:system_native_usage_pass_invocation_idx
CREATE INDEX "system_native_usage_pass_invocation_idx" ON "agent_workflow"."system_agent_native_usage_passes" ("invocation_id", "pass_id");

-- index: system_agent_native_usage_preparations:index:system_native_usage_preparation_task_idx
CREATE INDEX "system_native_usage_preparation_task_idx" ON "agent_workflow"."system_agent_native_usage_preparations" ("task_id", "invocation_id");

-- index: system_agent_native_usage_root_transitions:index:system_native_usage_root_identity_idx
CREATE INDEX "system_native_usage_root_identity_idx" ON "agent_workflow"."system_agent_native_usage_root_transitions" ("invocation_id", "root_session_id");

-- index: system_agent_observation_owners:index:system_observation_group_attempt_idx
CREATE INDEX "system_observation_group_attempt_idx" ON "agent_workflow"."system_agent_observation_owners" ("group_id", "id");

-- index: system_agent_observation_sources:index:system_observation_pending_idx
CREATE INDEX "system_observation_pending_idx" ON "agent_workflow"."system_agent_observation_sources" ("pending", "node_run_id", "id");

-- index: system_agent_observation_sources:index:system_observation_node_idx
CREATE INDEX "system_observation_node_idx" ON "agent_workflow"."system_agent_observation_sources" ("node_run_id", "id");

-- constraint: system_agent_native_usage_emissions:fk:system_agent_native_usage_emissions_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_emissions" ADD CONSTRAINT "system_agent_native_usage_emissions_invocation_id__ae34efc262b0" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."system_agent_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_pass_heads:fk:system_agent_native_usage_pass_heads_pass_id_system_agent_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_pass_heads" ADD CONSTRAINT "system_agent_native_usage_pass_heads_pass_id_syste_dd934afe8e7c" FOREIGN KEY ("pass_id") REFERENCES "agent_workflow"."system_agent_native_usage_passes" ("pass_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_pass_pages:fk:system_agent_native_usage_pass_pages_pass_id_system_agent_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_pass_pages" ADD CONSTRAINT "system_agent_native_usage_pass_pages_pass_id_syste_5074153782ac" FOREIGN KEY ("pass_id") REFERENCES "agent_workflow"."system_agent_native_usage_passes" ("pass_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_passes:check:system_native_usage_pass_state_ck
ALTER TABLE "agent_workflow"."system_agent_native_usage_passes" ADD CONSTRAINT "system_native_usage_pass_state_ck" CHECK ("state" IN ('open','eof','interrupted','superseded'));

-- constraint: system_agent_native_usage_passes:fk:system_agent_native_usage_passes_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_passes" ADD CONSTRAINT "system_agent_native_usage_passes_invocation_id_sys_5f5e1d0fb62c" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."system_agent_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_preparations:check:system_native_usage_preparation_state_ck
ALTER TABLE "agent_workflow"."system_agent_native_usage_preparations" ADD CONSTRAINT "system_native_usage_preparation_state_ck" CHECK ("state" IN ('open','sealed'));

-- constraint: system_agent_native_usage_preparations:fk:system_agent_native_usage_preparations_task_id_system_agent_observation_groups_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_preparations" ADD CONSTRAINT "system_agent_native_usage_preparations_task_id_sys_8e608f7c418f" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."system_agent_observation_groups" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_revision_heads:fk:system_agent_native_usage_revision_heads_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_revision_heads" ADD CONSTRAINT "system_agent_native_usage_revision_heads_invocatio_9999d4bd0879" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."system_agent_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_root_heads:fk:system_agent_native_usage_root_heads_task_id_system_agent_observation_groups_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_root_heads" ADD CONSTRAINT "system_agent_native_usage_root_heads_task_id_syste_1e9af8bc5f80" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."system_agent_observation_groups" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_root_results:fk:system_agent_native_usage_root_results_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_root_results" ADD CONSTRAINT "system_agent_native_usage_root_results_invocation__cd504aaae3b5" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."system_agent_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_root_sets:fk:system_agent_native_usage_root_sets_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_root_sets" ADD CONSTRAINT "system_agent_native_usage_root_sets_invocation_id__20cfb36a93b8" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."system_agent_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_root_transitions:fk:system_agent_native_usage_root_transitions_invocation_id_system_agent_native_usage_root_heads_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_root_transitions" ADD CONSTRAINT "system_agent_native_usage_root_transitions_invocat_e4431e634559" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."system_agent_native_usage_root_heads" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_session_parents:fk:system_agent_native_usage_session_parents_pass_id_system_agent_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_session_parents" ADD CONSTRAINT "system_agent_native_usage_session_parents_pass_id__d193bfdbc4cc" FOREIGN KEY ("pass_id") REFERENCES "agent_workflow"."system_agent_native_usage_passes" ("pass_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_step_members:fk:system_agent_native_usage_step_members_pass_id_system_agent_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_step_members" ADD CONSTRAINT "system_agent_native_usage_step_members_pass_id_sys_0ccd02b1805b" FOREIGN KEY ("pass_id") REFERENCES "agent_workflow"."system_agent_native_usage_passes" ("pass_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_native_usage_store_bindings:fk:system_agent_native_usage_store_bindings_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_store_bindings" ADD CONSTRAINT "system_agent_native_usage_store_bindings_invocatio_7ee6e0efa1f9" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."system_agent_native_usage_preparations" ("invocation_id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_observation_owners:fk:system_agent_observation_owners_group_id_system_agent_observation_groups_id_fk
ALTER TABLE "agent_workflow"."system_agent_observation_owners" ADD CONSTRAINT "system_agent_observation_owners_group_id_system_ag_c8738567a1bd" FOREIGN KEY ("group_id") REFERENCES "agent_workflow"."system_agent_observation_groups" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_observation_sources:fk:system_agent_observation_sources_task_id_system_agent_observation_groups_id_fk
ALTER TABLE "agent_workflow"."system_agent_observation_sources" ADD CONSTRAINT "system_agent_observation_sources_task_id_system_ag_2bb510694574" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."system_agent_observation_groups" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: system_agent_observation_sources:fk:system_agent_observation_sources_node_run_id_system_agent_observation_owners_id_fk
ALTER TABLE "agent_workflow"."system_agent_observation_sources" ADD CONSTRAINT "system_agent_observation_sources_node_run_id_syste_a0f2d669b979" FOREIGN KEY ("node_run_id") REFERENCES "agent_workflow"."system_agent_observation_owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:14bbd9c6f45a4f4c35452a2bcce3bbed7979c7741f8c20d58ce0458cc395c4d9', active_table_count = 233, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:012cce37c527334d3a966f13274636baca3d2f5901736cb43b3923acd28d1f50' RETURNING contract_digest;
