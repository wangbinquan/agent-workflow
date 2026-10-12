-- constraint: retire:clarify_mindmap_command_receipts:clarify_mindmap_command_receipts_session_id_clarify_mindmap_sessions_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_command_receipts" DROP CONSTRAINT "clarify_mindmap_command_receipts_session_id_clarify_mindmap_sessions_id_fk";

-- constraint: retire:clarify_mindmap_node_revisions:clarify_mindmap_node_revisions_node_id_clarify_mindmap_nodes_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_node_revisions" DROP CONSTRAINT "clarify_mindmap_node_revisions_node_id_clarify_mindmap_nodes_id_fk";

-- constraint: retire:clarify_mindmap_nodes:clarify_mindmap_nodes_session_id_clarify_mindmap_sessions_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_nodes" DROP CONSTRAINT "clarify_mindmap_nodes_session_id_clarify_mindmap_sessions_id_fk";

-- constraint: retire:clarify_mindmap_sessions:clarify_mindmap_sessions_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_sessions" DROP CONSTRAINT "clarify_mindmap_sessions_task_id_tasks_id_fk";

-- constraint: retire:clarify_mindmap_sessions:clarify_mindmap_sessions_round_id_clarify_rounds_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_sessions" DROP CONSTRAINT "clarify_mindmap_sessions_round_id_clarify_rounds_id_fk";

-- constraint: retire:clarify_mindmap_snapshots:clarify_mindmap_snapshots_session_id_clarify_mindmap_sessions_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_snapshots" DROP CONSTRAINT "clarify_mindmap_snapshots_session_id_clarify_mindmap_sessions_id_fk";

-- constraint: retire:task_clarify_channels:task_clarify_channels_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_clarify_channels" DROP CONSTRAINT "task_clarify_channels_task_id_tasks_id_fk";

-- constraint: retire:task_clarify_consumptions:task_clarify_consumptions_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."task_clarify_consumptions" DROP CONSTRAINT "task_clarify_consumptions_node_run_id_node_runs_id_fk";

-- constraint: retire:task_clarify_consumptions:task_clarify_consumptions_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_clarify_consumptions" DROP CONSTRAINT "task_clarify_consumptions_task_id_tasks_id_fk";

-- constraint: retire:task_clarify_consumptions:task_clarify_consumptions_material_id_task_clarify_materials_id_fk
ALTER TABLE "agent_workflow"."task_clarify_consumptions" DROP CONSTRAINT "task_clarify_consumptions_material_id_task_clarify_materials_id_fk";

-- constraint: retire:task_clarify_entries:task_clarify_entries_channel_id_task_clarify_channels_id_fk
ALTER TABLE "agent_workflow"."task_clarify_entries" DROP CONSTRAINT "task_clarify_entries_channel_id_task_clarify_channels_id_fk";

-- constraint: retire:task_clarify_host_runs:task_clarify_host_runs_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."task_clarify_host_runs" DROP CONSTRAINT "task_clarify_host_runs_node_run_id_node_runs_id_fk";

-- constraint: retire:task_clarify_host_runs:task_clarify_host_runs_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_clarify_host_runs" DROP CONSTRAINT "task_clarify_host_runs_task_id_tasks_id_fk";

-- constraint: retire:task_clarify_materials:task_clarify_materials_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_clarify_materials" DROP CONSTRAINT "task_clarify_materials_task_id_tasks_id_fk";

-- constraint: retire:task_clarify_materials:task_clarify_materials_entry_scope_ref_task_clarify_entries_id_fk
ALTER TABLE "agent_workflow"."task_clarify_materials" DROP CONSTRAINT "task_clarify_materials_entry_scope_ref_task_clarify_entries_id_fk";

-- table: retire:clarify_mindmap_command_receipts
DROP TABLE "agent_workflow"."clarify_mindmap_command_receipts";

-- table: retire:clarify_mindmap_node_revisions
DROP TABLE "agent_workflow"."clarify_mindmap_node_revisions";

-- table: retire:clarify_mindmap_nodes
DROP TABLE "agent_workflow"."clarify_mindmap_nodes";

-- table: retire:clarify_mindmap_sessions
DROP TABLE "agent_workflow"."clarify_mindmap_sessions";

-- table: retire:clarify_mindmap_snapshots
DROP TABLE "agent_workflow"."clarify_mindmap_snapshots";

-- table: retire:task_clarify_channels
DROP TABLE "agent_workflow"."task_clarify_channels";

-- table: retire:task_clarify_consumptions
DROP TABLE "agent_workflow"."task_clarify_consumptions";

-- table: retire:task_clarify_entries
DROP TABLE "agent_workflow"."task_clarify_entries";

-- table: retire:task_clarify_host_runs
DROP TABLE "agent_workflow"."task_clarify_host_runs";

-- table: retire:task_clarify_materials
DROP TABLE "agent_workflow"."task_clarify_materials";

-- table: observation_projection_bindings
CREATE TABLE "agent_workflow"."observation_projection_bindings" (
  "kind" TEXT COLLATE "C" NOT NULL,
  "identity" TEXT COLLATE "C" NOT NULL,
  "contribution_key" TEXT COLLATE "C" NOT NULL,
  "component" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_bindings_pkey" PRIMARY KEY ("kind", "identity", "contribution_key")
);

-- table: observation_projection_bootstrap
CREATE TABLE "agent_workflow"."observation_projection_bootstrap" (
  "generation" TEXT COLLATE "C" NOT NULL,
  "channel" TEXT COLLATE "C" NOT NULL,
  "cursor" TEXT COLLATE "C",
  "done" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "observation_projection_bootstrap_pkey" PRIMARY KEY ("generation", "channel")
);

-- table: observation_projection_changes
CREATE TABLE "agent_workflow"."observation_projection_changes" (
  "id" TEXT COLLATE "C" NOT NULL,
  "source" TEXT COLLATE "C" NOT NULL,
  "entity_key" TEXT COLLATE "C" NOT NULL,
  "operation" TEXT COLLATE "C" NOT NULL,
  "previous_route" TEXT COLLATE "C",
  "next_route" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "completed" BOOLEAN NOT NULL DEFAULT FALSE,
  "retry_at" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "observation_projection_changes_pkey" PRIMARY KEY ("id")
);

-- table: observation_projection_components
CREATE TABLE "agent_workflow"."observation_projection_components" (
  "component" TEXT COLLATE "C" NOT NULL,
  "revision" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_components_pkey" PRIMARY KEY ("component")
);

-- table: observation_projection_current
CREATE TABLE "agent_workflow"."observation_projection_current" (
  "kind" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "component" TEXT COLLATE "C",
  "revision" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "section" TEXT COLLATE "C",
  "original_key" TEXT COLLATE "C",
  "parent" TEXT COLLATE "C",
  "task_id" TEXT COLLATE "C",
  "cohort_at" BIGINT,
  CONSTRAINT "observation_projection_current_pkey" PRIMARY KEY ("kind", "key")
);

-- table: observation_projection_dependencies
CREATE TABLE "agent_workflow"."observation_projection_dependencies" (
  "source" TEXT COLLATE "C" NOT NULL,
  "entity_key" TEXT COLLATE "C" NOT NULL,
  "component" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_dependencies_pkey" PRIMARY KEY ("source", "entity_key", "component")
);

-- table: observation_projection_heads
CREATE TABLE "agent_workflow"."observation_projection_heads" (
  "id" TEXT COLLATE "C" NOT NULL,
  "revision" TEXT COLLATE "C" NOT NULL,
  "as_of" BIGINT NOT NULL,
  CONSTRAINT "observation_projection_heads_pkey" PRIMARY KEY ("id")
);

-- table: observation_projection_history
CREATE TABLE "agent_workflow"."observation_projection_history" (
  "kind" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "component" TEXT COLLATE "C",
  "from_revision" TEXT COLLATE "C" NOT NULL,
  "to_revision" TEXT COLLATE "C",
  "document" TEXT COLLATE "C" NOT NULL,
  "section" TEXT COLLATE "C",
  "original_key" TEXT COLLATE "C",
  "parent" TEXT COLLATE "C",
  "task_id" TEXT COLLATE "C",
  "cohort_at" BIGINT,
  CONSTRAINT "observation_projection_history_pkey" PRIMARY KEY ("kind", "key", "from_revision")
);

-- table: observation_projection_memberships
CREATE TABLE "agent_workflow"."observation_projection_memberships" (
  "aggregate" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "from_revision" TEXT COLLATE "C" NOT NULL,
  "to_revision" TEXT COLLATE "C",
  CONSTRAINT "observation_projection_memberships_pkey" PRIMARY KEY ("aggregate", "key", "from_revision")
);

-- table: observation_projection_prepared
CREATE TABLE "agent_workflow"."observation_projection_prepared" (
  "work_id" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_prepared_pkey" PRIMARY KEY ("work_id", "key")
);

-- table: observation_projection_versions
CREATE TABLE "agent_workflow"."observation_projection_versions" (
  "revision" TEXT COLLATE "C" NOT NULL,
  "as_of" BIGINT NOT NULL,
  "bootstrap_complete" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "observation_projection_versions_pkey" PRIMARY KEY ("revision")
);

-- table: observation_projection_views
CREATE TABLE "agent_workflow"."observation_projection_views" (
  "id" TEXT COLLATE "C" NOT NULL,
  "actor_scope" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_views_pkey" PRIMARY KEY ("id")
);

-- table: observation_projection_work
CREATE TABLE "agent_workflow"."observation_projection_work" (
  "id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  "completed_revision" TEXT COLLATE "C",
  "prepared" TEXT COLLATE "C",
  "lease_token" TEXT COLLATE "C",
  "lease_until" BIGINT NOT NULL DEFAULT 0,
  "retry_at" BIGINT NOT NULL DEFAULT 0,
  "failure" TEXT COLLATE "C",
  "applied_revision" TEXT COLLATE "C",
  "retry_count" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "observation_projection_work_pkey" PRIMARY KEY ("id")
);

-- table: observation_projection_work_components
CREATE TABLE "agent_workflow"."observation_projection_work_components" (
  "work_id" TEXT COLLATE "C" NOT NULL,
  "component" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_projection_work_components_pkey" PRIMARY KEY ("work_id", "component")
);

-- index: observation_projection_bindings:index:observation_projection_binding_component
CREATE INDEX "observation_projection_binding_component" ON "agent_workflow"."observation_projection_bindings" ("component");

-- index: observation_projection_bindings:index:observation_projection_binding_contribution
CREATE INDEX "observation_projection_binding_contribution" ON "agent_workflow"."observation_projection_bindings" ("contribution_key");

-- index: observation_projection_changes:index:observation_projection_changes_pending
CREATE INDEX "observation_projection_changes_pending" ON "agent_workflow"."observation_projection_changes" ("completed", "created_at", "id");

-- index: observation_projection_current:index:observation_projection_current_component
CREATE INDEX "observation_projection_current_component" ON "agent_workflow"."observation_projection_current" ("kind", "component", "key");

-- index: observation_projection_dependencies:index:observation_projection_dependencies_component
CREATE INDEX "observation_projection_dependencies_component" ON "agent_workflow"."observation_projection_dependencies" ("component");

-- index: observation_projection_history:index:observation_projection_history_component
CREATE INDEX "observation_projection_history_component" ON "agent_workflow"."observation_projection_history" ("kind", "component", "key");

-- index: observation_projection_history:index:observation_projection_history_section
CREATE INDEX "observation_projection_history_section" ON "agent_workflow"."observation_projection_history" ("kind", "section", "cohort_at", "key");

-- index: observation_projection_history:index:observation_projection_history_task
CREATE INDEX "observation_projection_history_task" ON "agent_workflow"."observation_projection_history" ("kind", "task_id", "section", "parent", "key");

-- index: observation_projection_history:index:observation_projection_history_day
CREATE INDEX "observation_projection_history_day" ON "agent_workflow"."observation_projection_history" ("kind", "section", "task_id", "cohort_at", "key");

-- index: observation_projection_memberships:index:observation_projection_memberships_key
CREATE INDEX "observation_projection_memberships_key" ON "agent_workflow"."observation_projection_memberships" ("key", "from_revision");

-- index: observation_projection_work:index:observation_projection_work_pending
CREATE INDEX "observation_projection_work_pending" ON "agent_workflow"."observation_projection_work" ("completed_revision", "retry_at", "lease_until", "id");

-- constraint: observation_projection_prepared:fk:observation_projection_prepared_work_id_observation_projection_work_id_fk
ALTER TABLE "agent_workflow"."observation_projection_prepared" ADD CONSTRAINT "observation_projection_prepared_work_id_observatio_51063f60edc8" FOREIGN KEY ("work_id") REFERENCES "agent_workflow"."observation_projection_work" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: observation_projection_work_components:fk:observation_projection_work_components_work_id_observation_projection_work_id_fk
ALTER TABLE "agent_workflow"."observation_projection_work_components" ADD CONSTRAINT "observation_projection_work_components_work_id_obs_be8b76ecf26a" FOREIGN KEY ("work_id") REFERENCES "agent_workflow"."observation_projection_work" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- function: observation_projection_changes:agents
CREATE FUNCTION "agent_workflow"."obs_delta_agents_8c70b25cbbbe"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'agents',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: agents:observation-change
CREATE TRIGGER "obs_delta_agents_8c70b25cbbbe" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."agents" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_agents_8c70b25cbbbe"();

-- function: observation_projection_changes:intent_sessions
CREATE FUNCTION "agent_workflow"."obs_delta_intent_sessions_f4fc994cf568"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'intent_sessions',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: intent_sessions:observation-change
CREATE TRIGGER "obs_delta_intent_sessions_f4fc994cf568" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."intent_sessions" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_intent_sessions_f4fc994cf568"();

-- function: observation_projection_changes:intent_turn_events
CREATE FUNCTION "agent_workflow"."obs_delta_intent_turn_events_9577a85373ce"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'intent_turn_events',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'turn_id',CAST(OLD."turn_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT),'source',CAST(OLD."source" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'turn_id',CAST(NEW."turn_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT),'source',CAST(NEW."source" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: intent_turn_events:observation-change
CREATE TRIGGER "obs_delta_intent_turn_events_9577a85373ce" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."intent_turn_events" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_intent_turn_events_9577a85373ce"();

-- function: observation_projection_changes:intent_turns
CREATE FUNCTION "agent_workflow"."obs_delta_intent_turns_a0c059001e55"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'intent_turns',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'capture_root_session_id',CAST(OLD."capture_root_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'capture_root_session_id',CAST(NEW."capture_root_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: intent_turns:observation-change
CREATE TRIGGER "obs_delta_intent_turns_a0c059001e55" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."intent_turns" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_intent_turns_a0c059001e55"();

-- function: observation_projection_changes:mcp_runtime_test_events
CREATE FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_events_3026f434cf19"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'mcp_runtime_test_events',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'test_session_id',CAST(OLD."test_session_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT),'source',CAST(OLD."source" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'test_session_id',CAST(NEW."test_session_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT),'source',CAST(NEW."source" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: mcp_runtime_test_events:observation-change
CREATE TRIGGER "obs_delta_mcp_runtime_test_events_3026f434cf19" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."mcp_runtime_test_events" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_events_3026f434cf19"();

-- function: observation_projection_changes:mcp_runtime_test_sessions
CREATE FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_sessions_9f19ae79a165"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'mcp_runtime_test_sessions',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'mcp_id',CAST(OLD."mcp_id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT),'runtime_row_id',CAST(OLD."runtime_row_id" AS TEXT),'runtime_name',CAST(OLD."runtime_name" AS TEXT),'runtime_protocol',CAST(OLD."runtime_protocol" AS TEXT),'runtime_snapshot_json',CAST(OLD."runtime_snapshot_json" AS TEXT),'runtime_binary_path',CAST(OLD."runtime_binary_path" AS TEXT),'runtime_session_id',CAST(OLD."runtime_session_id" AS TEXT),'native_session_state',CAST(OLD."native_session_state" AS TEXT),'session_version',CAST(OLD."session_version" AS TEXT),'scratch_root',CAST(OLD."scratch_root" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'mcp_id',CAST(NEW."mcp_id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT),'runtime_row_id',CAST(NEW."runtime_row_id" AS TEXT),'runtime_name',CAST(NEW."runtime_name" AS TEXT),'runtime_protocol',CAST(NEW."runtime_protocol" AS TEXT),'runtime_snapshot_json',CAST(NEW."runtime_snapshot_json" AS TEXT),'runtime_binary_path',CAST(NEW."runtime_binary_path" AS TEXT),'runtime_session_id',CAST(NEW."runtime_session_id" AS TEXT),'native_session_state',CAST(NEW."native_session_state" AS TEXT),'session_version',CAST(NEW."session_version" AS TEXT),'scratch_root',CAST(NEW."scratch_root" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: mcp_runtime_test_sessions:observation-change
CREATE TRIGGER "obs_delta_mcp_runtime_test_sessions_9f19ae79a165" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."mcp_runtime_test_sessions" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_sessions_9f19ae79a165"();

-- function: observation_projection_changes:mcp_runtime_test_turns
CREATE FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_turns_5facdc2dda15"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'mcp_runtime_test_turns',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: mcp_runtime_test_turns:observation-change
CREATE TRIGGER "obs_delta_mcp_runtime_test_turns_5facdc2dda15" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."mcp_runtime_test_turns" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_turns_5facdc2dda15"();

-- function: observation_projection_changes:memory_distill_events
CREATE FUNCTION "agent_workflow"."obs_delta_memory_distill_events_9222b906089a"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'memory_distill_events',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'distill_job_id',CAST(OLD."distill_job_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'distill_job_id',CAST(NEW."distill_job_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: memory_distill_events:observation-change
CREATE TRIGGER "obs_delta_memory_distill_events_9222b906089a" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."memory_distill_events" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_memory_distill_events_9222b906089a"();

-- function: observation_projection_changes:memory_distill_jobs
CREATE FUNCTION "agent_workflow"."obs_delta_memory_distill_jobs_7c1cff75edd4"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'memory_distill_jobs',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'source_kind',CAST(OLD."source_kind" AS TEXT),'source_event_id',CAST(OLD."source_event_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'opencode_session_id',CAST(OLD."opencode_session_id" AS TEXT),'user_prompt_md',CAST(OLD."user_prompt_md" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'source_kind',CAST(NEW."source_kind" AS TEXT),'source_event_id',CAST(NEW."source_event_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'opencode_session_id',CAST(NEW."opencode_session_id" AS TEXT),'user_prompt_md',CAST(NEW."user_prompt_md" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: memory_distill_jobs:observation-change
CREATE TRIGGER "obs_delta_memory_distill_jobs_7c1cff75edd4" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."memory_distill_jobs" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_memory_distill_jobs_7c1cff75edd4"();

-- function: observation_projection_changes:node_run_events
CREATE FUNCTION "agent_workflow"."obs_delta_node_run_events_01109c2fd4cf"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'node_run_events',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: node_run_events:observation-change
CREATE TRIGGER "obs_delta_node_run_events_01109c2fd4cf" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."node_run_events" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_node_run_events_01109c2fd4cf"();

-- function: observation_projection_changes:node_runs
CREATE FUNCTION "agent_workflow"."obs_delta_node_runs_d3d6de02630e"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'node_runs',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'parent_node_run_id',CAST(OLD."parent_node_run_id" AS TEXT),'opencode_session_id',CAST(OLD."opencode_session_id" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'runtime_binary',CAST(OLD."runtime_binary" AS TEXT),'runtime_params_json',CAST(OLD."runtime_params_json" AS TEXT),'runtime_inventory_json',CAST(OLD."runtime_inventory_json" AS TEXT),'agent_override_name',CAST(OLD."agent_override_name" AS TEXT),'agent_override_id',CAST(OLD."agent_override_id" AS TEXT),'child_task_id',CAST(OLD."child_task_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'parent_node_run_id',CAST(NEW."parent_node_run_id" AS TEXT),'opencode_session_id',CAST(NEW."opencode_session_id" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'runtime_binary',CAST(NEW."runtime_binary" AS TEXT),'runtime_params_json',CAST(NEW."runtime_params_json" AS TEXT),'runtime_inventory_json',CAST(NEW."runtime_inventory_json" AS TEXT),'agent_override_name',CAST(NEW."agent_override_name" AS TEXT),'agent_override_id',CAST(NEW."agent_override_id" AS TEXT),'child_task_id',CAST(NEW."child_task_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: node_runs:observation-change
CREATE TRIGGER "obs_delta_node_runs_d3d6de02630e" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."node_runs" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_node_runs_d3d6de02630e"();

-- function: observation_projection_changes:observation_invocations
CREATE FUNCTION "agent_workflow"."obs_delta_observation_invocations_ddde8c4db0d6"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_invocations',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'$invocation',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{invocationId}')='string' THEN OLD."document"::jsonb #>> '{invocationId}' ELSE NULL END ELSE NULL END,'$attempt',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{nodeRunId}')='string' THEN OLD."document"::jsonb #>> '{nodeRunId}' ELSE NULL END ELSE NULL END,'$agent',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{agentId}')='string' THEN OLD."document"::jsonb #>> '{agentId}' ELSE NULL END ELSE NULL END,'$runtime',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{authority,runtime,registrationId}')='string' THEN OLD."document"::jsonb #>> '{authority,runtime,registrationId}' ELSE NULL END ELSE NULL END)::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'$invocation',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{invocationId}')='string' THEN NEW."document"::jsonb #>> '{invocationId}' ELSE NULL END ELSE NULL END,'$attempt',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{nodeRunId}')='string' THEN NEW."document"::jsonb #>> '{nodeRunId}' ELSE NULL END ELSE NULL END,'$agent',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{agentId}')='string' THEN NEW."document"::jsonb #>> '{agentId}' ELSE NULL END ELSE NULL END,'$runtime',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{authority,runtime,registrationId}')='string' THEN NEW."document"::jsonb #>> '{authority,runtime,registrationId}' ELSE NULL END ELSE NULL END)::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_invocations:observation-change
CREATE TRIGGER "obs_delta_observation_invocations_ddde8c4db0d6" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_invocations" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_invocations_ddde8c4db0d6"();

-- function: observation_projection_changes:observation_platform_records
CREATE FUNCTION "agent_workflow"."obs_delta_observation_platform_records_b9c238a11799"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_platform_records',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'source_key',CAST(OLD."source_key" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'source_key',CAST(NEW."source_key" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_platform_records:observation-change
CREATE TRIGGER "obs_delta_observation_platform_records_b9c238a11799" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_platform_records" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_platform_records_b9c238a11799"();

-- function: observation_projection_changes:observation_platform_sources
CREATE FUNCTION "agent_workflow"."obs_delta_observation_platform_sources_0d51a229caf9"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_platform_sources',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'$platformSource',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{binding,sourceId}')='string' THEN OLD."document"::jsonb #>> '{binding,sourceId}' ELSE NULL END ELSE NULL END,'$platformProject',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{binding,projectId}')='string' THEN OLD."document"::jsonb #>> '{binding,projectId}' ELSE NULL END ELSE NULL END,'$platformTask',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{binding,taskId}')='string' THEN OLD."document"::jsonb #>> '{binding,taskId}' ELSE NULL END ELSE NULL END)::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'$platformSource',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{binding,sourceId}')='string' THEN NEW."document"::jsonb #>> '{binding,sourceId}' ELSE NULL END ELSE NULL END,'$platformProject',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{binding,projectId}')='string' THEN NEW."document"::jsonb #>> '{binding,projectId}' ELSE NULL END ELSE NULL END,'$platformTask',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{binding,taskId}')='string' THEN NEW."document"::jsonb #>> '{binding,taskId}' ELSE NULL END ELSE NULL END)::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_platform_sources:observation-change
CREATE TRIGGER "obs_delta_observation_platform_sources_0d51a229caf9" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_platform_sources" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_platform_sources_0d51a229caf9"();

-- function: observation_projection_changes:observation_price_heads
CREATE FUNCTION "agent_workflow"."obs_delta_observation_price_heads_e45105caf86d"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_price_heads',CASE WHEN TG_OP='DELETE' THEN json_build_object('registration_id',CAST(OLD."registration_id" AS TEXT))::text ELSE json_build_object('registration_id',CAST(NEW."registration_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('registration_id',CAST(OLD."registration_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('registration_id',CAST(NEW."registration_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_price_heads:observation-change
CREATE TRIGGER "obs_delta_observation_price_heads_e45105caf86d" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_price_heads" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_price_heads_e45105caf86d"();

-- function: observation_projection_changes:observation_price_versions
CREATE FUNCTION "agent_workflow"."obs_delta_observation_price_versions_40e139831493"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_price_versions',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_price_versions:observation-change
CREATE TRIGGER "obs_delta_observation_price_versions_40e139831493" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_price_versions" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_price_versions_40e139831493"();

-- function: observation_projection_changes:observation_usage_captures
CREATE FUNCTION "agent_workflow"."obs_delta_observation_usage_captures_69ed66269937"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_usage_captures',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'source_cursor',CAST(OLD."source_cursor" AS TEXT),'native_root_key',CAST(OLD."native_root_key" AS TEXT),'$root',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{evidence,capture,rootSessionId}')='string' THEN OLD."document"::jsonb #>> '{evidence,capture,rootSessionId}' ELSE NULL END ELSE NULL END)::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'source_cursor',CAST(NEW."source_cursor" AS TEXT),'native_root_key',CAST(NEW."native_root_key" AS TEXT),'$root',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{evidence,capture,rootSessionId}')='string' THEN NEW."document"::jsonb #>> '{evidence,capture,rootSessionId}' ELSE NULL END ELSE NULL END)::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_usage_captures:observation-change
CREATE TRIGGER "obs_delta_observation_usage_captures_69ed66269937" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_usage_captures" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_usage_captures_69ed66269937"();

-- function: observation_projection_changes:observation_usage_current
CREATE FUNCTION "agent_workflow"."obs_delta_observation_usage_current_5c718590978a"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_usage_current',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'$invocation',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{measurement,invocationId}')='string' THEN OLD."document"::jsonb #>> '{measurement,invocationId}' ELSE NULL END ELSE NULL END,'$root',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{measurement,scope,root}')='string' THEN OLD."document"::jsonb #>> '{measurement,scope,root}' ELSE NULL END ELSE NULL END)::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'$invocation',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{measurement,invocationId}')='string' THEN NEW."document"::jsonb #>> '{measurement,invocationId}' ELSE NULL END ELSE NULL END,'$root',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{measurement,scope,root}')='string' THEN NEW."document"::jsonb #>> '{measurement,scope,root}' ELSE NULL END ELSE NULL END)::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_usage_current:observation-change
CREATE TRIGGER "obs_delta_observation_usage_current_5c718590978a" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_usage_current" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_usage_current_5c718590978a"();

-- function: observation_projection_changes:observation_usage_events
CREATE FUNCTION "agent_workflow"."obs_delta_observation_usage_events_20955815b204"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_usage_events',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'record_key',CAST(OLD."record_key" AS TEXT),'$invocation',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{invocationId}')='string' THEN OLD."document"::jsonb #>> '{invocationId}' ELSE NULL END ELSE NULL END,'$task',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{taskId}')='string' THEN OLD."document"::jsonb #>> '{taskId}' ELSE NULL END ELSE NULL END,'$root',CASE WHEN pg_input_is_valid(OLD."document",'jsonb') THEN CASE WHEN jsonb_typeof(OLD."document"::jsonb #> '{scope,root}')='string' THEN OLD."document"::jsonb #>> '{scope,root}' ELSE NULL END ELSE NULL END)::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'record_key',CAST(NEW."record_key" AS TEXT),'$invocation',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{invocationId}')='string' THEN NEW."document"::jsonb #>> '{invocationId}' ELSE NULL END ELSE NULL END,'$task',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{taskId}')='string' THEN NEW."document"::jsonb #>> '{taskId}' ELSE NULL END ELSE NULL END,'$root',CASE WHEN pg_input_is_valid(NEW."document",'jsonb') THEN CASE WHEN jsonb_typeof(NEW."document"::jsonb #> '{scope,root}')='string' THEN NEW."document"::jsonb #>> '{scope,root}' ELSE NULL END ELSE NULL END)::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_usage_events:observation-change
CREATE TRIGGER "obs_delta_observation_usage_events_20955815b204" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_usage_events" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_usage_events_20955815b204"();

-- function: observation_projection_changes:observation_usage_native_records
CREATE FUNCTION "agent_workflow"."obs_delta_observation_usage_native_rec_80ccf5536f6c"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_usage_native_records',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'native_source',CAST(OLD."native_source" AS TEXT),'native_root',CAST(OLD."native_root" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'native_source',CAST(NEW."native_source" AS TEXT),'native_root',CAST(NEW."native_root" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_usage_native_records:observation-change
CREATE TRIGGER "obs_delta_observation_usage_native_rec_80ccf5536f6c" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_usage_native_records" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_usage_native_rec_80ccf5536f6c"();

-- function: observation_projection_changes:observation_usage_sources
CREATE FUNCTION "agent_workflow"."obs_delta_observation_usage_sources_b509b15c3b1b"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'observation_usage_sources',CASE WHEN TG_OP='DELETE' THEN json_build_object('source_id',CAST(OLD."source_id" AS TEXT))::text ELSE json_build_object('source_id',CAST(NEW."source_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('source_id',CAST(OLD."source_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('source_id',CAST(NEW."source_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: observation_usage_sources:observation-change
CREATE TRIGGER "obs_delta_observation_usage_sources_b509b15c3b1b" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."observation_usage_sources" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_observation_usage_sources_b509b15c3b1b"();

-- function: observation_projection_changes:system_agent_native_usage_emissions
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_em_364e7e46c5e0"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_emissions',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT),'source_row_id',CAST(OLD."source_row_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT),'source_row_id',CAST(NEW."source_row_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_emissions:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_em_364e7e46c5e0" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_emissions" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_em_364e7e46c5e0"();

-- function: observation_projection_changes:system_agent_native_usage_pass_heads
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_ba37186c0936"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_pass_heads',CASE WHEN TG_OP='DELETE' THEN json_build_object('key',CAST(OLD."key" AS TEXT))::text ELSE json_build_object('key',CAST(NEW."key" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('key',CAST(OLD."key" AS TEXT),'pass_id',CAST(OLD."pass_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('key',CAST(NEW."key" AS TEXT),'pass_id',CAST(NEW."pass_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_pass_heads:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_ba37186c0936" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_pass_heads" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_ba37186c0936"();

-- function: observation_projection_changes:system_agent_native_usage_pass_pages
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_771477690e2b"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_pass_pages',CASE WHEN TG_OP='DELETE' THEN json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT))::text ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_pass_pages:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_771477690e2b" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_pass_pages" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_771477690e2b"();

-- function: observation_projection_changes:system_agent_native_usage_passes
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_6520d2339bb5"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_passes',CASE WHEN TG_OP='DELETE' THEN json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT))::text ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'invocation_id',CAST(OLD."invocation_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT),'root_created_at',CAST(OLD."root_created_at" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'invocation_id',CAST(NEW."invocation_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT),'root_created_at',CAST(NEW."root_created_at" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_passes:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_6520d2339bb5" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_passes" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_6520d2339bb5"();

-- function: observation_projection_changes:system_agent_native_usage_preparations
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pr_ec4ab414cf07"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_preparations',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_preparations:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_pr_ec4ab414cf07" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_preparations" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pr_ec4ab414cf07"();

-- function: observation_projection_changes:system_agent_native_usage_revision_heads
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_re_1baf88801307"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_revision_heads',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_revision_heads:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_re_1baf88801307" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_revision_heads" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_re_1baf88801307"();

-- function: observation_projection_changes:system_agent_native_usage_root_heads
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_9ed202dd645c"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_root_heads',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'first_root_session_id',CAST(OLD."first_root_session_id" AS TEXT),'last_root_session_id',CAST(OLD."last_root_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'first_root_session_id',CAST(NEW."first_root_session_id" AS TEXT),'last_root_session_id',CAST(NEW."last_root_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_root_heads:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_9ed202dd645c" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_root_heads" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_9ed202dd645c"();

-- function: observation_projection_changes:system_agent_native_usage_root_results
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_60f7ad4db013"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_root_results',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_root_results:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_60f7ad4db013" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_root_results" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_60f7ad4db013"();

-- function: observation_projection_changes:system_agent_native_usage_root_sets
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_64e30e7a3e2c"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_root_sets',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'root_digest',CAST(OLD."root_digest" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'root_digest',CAST(NEW."root_digest" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_root_sets:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_64e30e7a3e2c" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_root_sets" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_64e30e7a3e2c"();

-- function: observation_projection_changes:system_agent_native_usage_root_transitions
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_32f58d5077c1"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_root_transitions',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_root_transitions:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_32f58d5077c1" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_root_transitions" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_32f58d5077c1"();

-- function: observation_projection_changes:system_agent_native_usage_session_parents
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_se_71b41666d29a"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_session_parents',CASE WHEN TG_OP='DELETE' THEN json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT))::text ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_session_parents:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_se_71b41666d29a" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_session_parents" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_se_71b41666d29a"();

-- function: observation_projection_changes:system_agent_native_usage_step_members
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_st_7414b1fb4392"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_step_members',CASE WHEN TG_OP='DELETE' THEN json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT))::text ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_step_members:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_st_7414b1fb4392" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_step_members" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_st_7414b1fb4392"();

-- function: observation_projection_changes:system_agent_native_usage_store_bindings
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_st_d569eb209fc4"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_native_usage_store_bindings',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(OLD."before_owner_receipt_id" AS TEXT),'source_generation',CAST(OLD."source_generation" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(NEW."before_owner_receipt_id" AS TEXT),'source_generation',CAST(NEW."source_generation" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_native_usage_store_bindings:observation-change
CREATE TRIGGER "obs_delta_system_agent_native_usage_st_d569eb209fc4" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_native_usage_store_bindings" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_st_d569eb209fc4"();

-- function: observation_projection_changes:system_agent_observation_groups
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_observation_gro_f79391caed8d"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_observation_groups',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'parent_task_id',CAST(OLD."parent_task_id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'parent_task_id',CAST(NEW."parent_task_id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_observation_groups:observation-change
CREATE TRIGGER "obs_delta_system_agent_observation_gro_f79391caed8d" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_observation_groups" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_observation_gro_f79391caed8d"();

-- function: observation_projection_changes:system_agent_observation_owners
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_observation_own_67b3c6637001"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_observation_owners',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'group_id',CAST(OLD."group_id" AS TEXT),'agent_id',CAST(OLD."agent_id" AS TEXT),'agent_name',CAST(OLD."agent_name" AS TEXT),'agent_revision',CAST(OLD."agent_revision" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'owner_nonce',CAST(OLD."owner_nonce" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'group_id',CAST(NEW."group_id" AS TEXT),'agent_id',CAST(NEW."agent_id" AS TEXT),'agent_name',CAST(NEW."agent_name" AS TEXT),'agent_revision',CAST(NEW."agent_revision" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'owner_nonce',CAST(NEW."owner_nonce" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_observation_owners:observation-change
CREATE TRIGGER "obs_delta_system_agent_observation_own_67b3c6637001" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_observation_owners" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_observation_own_67b3c6637001"();

-- function: observation_projection_changes:system_agent_observation_sources
CREATE FUNCTION "agent_workflow"."obs_delta_system_agent_observation_sou_e2eb3c17fdf9"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'system_agent_observation_sources',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: system_agent_observation_sources:observation-change
CREATE TRIGGER "obs_delta_system_agent_observation_sou_e2eb3c17fdf9" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."system_agent_observation_sources" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_system_agent_observation_sou_e2eb3c17fdf9"();

-- function: observation_projection_changes:task_collaborators
CREATE FUNCTION "agent_workflow"."obs_delta_task_collaborators_a2cc5248664c"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_collaborators',CASE WHEN TG_OP='DELETE' THEN json_build_object('task_id',CAST(OLD."task_id" AS TEXT),'user_id',CAST(OLD."user_id" AS TEXT),'role',CAST(OLD."role" AS TEXT))::text ELSE json_build_object('task_id',CAST(NEW."task_id" AS TEXT),'user_id',CAST(NEW."user_id" AS TEXT),'role',CAST(NEW."role" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('task_id',CAST(OLD."task_id" AS TEXT),'user_id',CAST(OLD."user_id" AS TEXT),'role',CAST(OLD."role" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('task_id',CAST(NEW."task_id" AS TEXT),'user_id',CAST(NEW."user_id" AS TEXT),'role',CAST(NEW."role" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_collaborators:observation-change
CREATE TRIGGER "obs_delta_task_collaborators_a2cc5248664c" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_collaborators" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_collaborators_a2cc5248664c"();

-- function: observation_projection_changes:task_execution_native_usage_emissions
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__c8b1327ae70a"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_emissions',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT),'source_row_id',CAST(OLD."source_row_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT),'source_row_id',CAST(NEW."source_row_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_emissions:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__c8b1327ae70a" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_emissions" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__c8b1327ae70a"();

-- function: observation_projection_changes:task_execution_native_usage_pass_heads
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__65f2373ec8b0"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_pass_heads',CASE WHEN TG_OP='DELETE' THEN json_build_object('key',CAST(OLD."key" AS TEXT))::text ELSE json_build_object('key',CAST(NEW."key" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('key',CAST(OLD."key" AS TEXT),'pass_id',CAST(OLD."pass_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('key',CAST(NEW."key" AS TEXT),'pass_id',CAST(NEW."pass_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_pass_heads:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__65f2373ec8b0" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_pass_heads" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__65f2373ec8b0"();

-- function: observation_projection_changes:task_execution_native_usage_pass_pages
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__a6a06b98c7fd"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_pass_pages',CASE WHEN TG_OP='DELETE' THEN json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT))::text ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_pass_pages:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__a6a06b98c7fd" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_pass_pages" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__a6a06b98c7fd"();

-- function: observation_projection_changes:task_execution_native_usage_passes
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__bdc22d8b4973"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_passes',CASE WHEN TG_OP='DELETE' THEN json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT))::text ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'invocation_id',CAST(OLD."invocation_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT),'root_created_at',CAST(OLD."root_created_at" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'invocation_id',CAST(NEW."invocation_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT),'root_created_at',CAST(NEW."root_created_at" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_passes:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__bdc22d8b4973" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_passes" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__bdc22d8b4973"();

-- function: observation_projection_changes:task_execution_native_usage_preparations
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__4253a159b085"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_preparations',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_preparations:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__4253a159b085" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_preparations" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__4253a159b085"();

-- function: observation_projection_changes:task_execution_native_usage_revision_heads
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__93d68d4e5e09"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_revision_heads',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_revision_heads:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__93d68d4e5e09" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_revision_heads" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__93d68d4e5e09"();

-- function: observation_projection_changes:task_execution_native_usage_root_heads
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__a5adc08382bc"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_root_heads',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'first_root_session_id',CAST(OLD."first_root_session_id" AS TEXT),'last_root_session_id',CAST(OLD."last_root_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'first_root_session_id',CAST(NEW."first_root_session_id" AS TEXT),'last_root_session_id',CAST(NEW."last_root_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_root_heads:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__a5adc08382bc" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_root_heads" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__a5adc08382bc"();

-- function: observation_projection_changes:task_execution_native_usage_root_results
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__d6f5b5fad9a7"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_root_results',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_root_results:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__d6f5b5fad9a7" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_root_results" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__d6f5b5fad9a7"();

-- function: observation_projection_changes:task_execution_native_usage_root_sets
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__84a2186b134d"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_root_sets',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'root_digest',CAST(OLD."root_digest" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'root_digest',CAST(NEW."root_digest" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_root_sets:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__84a2186b134d" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_root_sets" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__84a2186b134d"();

-- function: observation_projection_changes:task_execution_native_usage_root_transitions
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__e20c6c58809d"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_root_transitions',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_root_transitions:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__e20c6c58809d" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_root_transitions" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__e20c6c58809d"();

-- function: observation_projection_changes:task_execution_native_usage_session_parents
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__1503f7a42ca6"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_session_parents',CASE WHEN TG_OP='DELETE' THEN json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT))::text ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_session_parents:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__1503f7a42ca6" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_session_parents" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__1503f7a42ca6"();

-- function: observation_projection_changes:task_execution_native_usage_step_members
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__7d6b31fa31e2"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_step_members',CASE WHEN TG_OP='DELETE' THEN json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT))::text ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_step_members:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__7d6b31fa31e2" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_step_members" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__7d6b31fa31e2"();

-- function: observation_projection_changes:task_execution_native_usage_store_bindings
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__cac99809a707"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_native_usage_store_bindings',CASE WHEN TG_OP='DELETE' THEN json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT))::text ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(OLD."before_owner_receipt_id" AS TEXT),'source_generation',CAST(OLD."source_generation" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(NEW."before_owner_receipt_id" AS TEXT),'source_generation',CAST(NEW."source_generation" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_native_usage_store_bindings:observation-change
CREATE TRIGGER "obs_delta_task_execution_native_usage__cac99809a707" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_native_usage_store_bindings" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__cac99809a707"();

-- function: observation_projection_changes:task_execution_observation_sources
CREATE FUNCTION "agent_workflow"."obs_delta_task_execution_observation_s_47fab48faf75"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_execution_observation_sources',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_execution_observation_sources:observation-change
CREATE TRIGGER "obs_delta_task_execution_observation_s_47fab48faf75" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_execution_observation_sources" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_execution_observation_s_47fab48faf75"();

-- function: observation_projection_changes:task_repos
CREATE FUNCTION "agent_workflow"."obs_delta_task_repos_e002384bcdaf"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'task_repos',CASE WHEN TG_OP='DELETE' THEN json_build_object('task_id',CAST(OLD."task_id" AS TEXT),'repo_index',CAST(OLD."repo_index" AS TEXT))::text ELSE json_build_object('task_id',CAST(NEW."task_id" AS TEXT),'repo_index',CAST(NEW."repo_index" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('task_id',CAST(OLD."task_id" AS TEXT),'repo_index',CAST(OLD."repo_index" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('task_id',CAST(NEW."task_id" AS TEXT),'repo_index',CAST(NEW."repo_index" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: task_repos:observation-change
CREATE TRIGGER "obs_delta_task_repos_e002384bcdaf" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."task_repos" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_task_repos_e002384bcdaf"();

-- function: observation_projection_changes:tasks
CREATE FUNCTION "agent_workflow"."obs_delta_tasks_085154084c74"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'tasks',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT),'repo_group_id',CAST(OLD."repo_group_id" AS TEXT),'repo_group_name',CAST(OLD."repo_group_name" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT),'git_user_name',CAST(OLD."git_user_name" AS TEXT),'git_user_email',CAST(OLD."git_user_email" AS TEXT),'scheduled_task_id',CAST(OLD."scheduled_task_id" AS TEXT),'source_termination_binding',CAST(OLD."source_termination_binding" AS TEXT),'source_termination_launch_rev',CAST(OLD."source_termination_launch_rev" AS TEXT),'source_termination_fence',CAST(OLD."source_termination_fence" AS TEXT),'source_termination_effect_rev',CAST(OLD."source_termination_effect_rev" AS TEXT),'source_agent_name',CAST(OLD."source_agent_name" AS TEXT),'source_agent_id',CAST(OLD."source_agent_id" AS TEXT),'parent_task_id',CAST(OLD."parent_task_id" AS TEXT),'parent_node_run_id',CAST(OLD."parent_node_run_id" AS TEXT),'invocation_depth',CAST(OLD."invocation_depth" AS TEXT),'root_task_id',CAST(OLD."root_task_id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT),'repo_group_id',CAST(NEW."repo_group_id" AS TEXT),'repo_group_name',CAST(NEW."repo_group_name" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT),'git_user_name',CAST(NEW."git_user_name" AS TEXT),'git_user_email',CAST(NEW."git_user_email" AS TEXT),'scheduled_task_id',CAST(NEW."scheduled_task_id" AS TEXT),'source_termination_binding',CAST(NEW."source_termination_binding" AS TEXT),'source_termination_launch_rev',CAST(NEW."source_termination_launch_rev" AS TEXT),'source_termination_fence',CAST(NEW."source_termination_fence" AS TEXT),'source_termination_effect_rev',CAST(NEW."source_termination_effect_rev" AS TEXT),'source_agent_name',CAST(NEW."source_agent_name" AS TEXT),'source_agent_id',CAST(NEW."source_agent_id" AS TEXT),'parent_task_id',CAST(NEW."parent_task_id" AS TEXT),'parent_node_run_id',CAST(NEW."parent_node_run_id" AS TEXT),'invocation_depth',CAST(NEW."invocation_depth" AS TEXT),'root_task_id',CAST(NEW."root_task_id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: tasks:observation-change
CREATE TRIGGER "obs_delta_tasks_085154084c74" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."tasks" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_tasks_085154084c74"();

-- function: observation_projection_changes:users
CREATE FUNCTION "agent_workflow"."obs_delta_users_7dfb4cf67742"() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO "agent_workflow"."observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,'users',CASE WHEN TG_OP='DELETE' THEN json_build_object('id',CAST(OLD."id" AS TEXT))::text ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE json_build_object('id',CAST(OLD."id" AS TEXT))::text END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE json_build_object('id',CAST(NEW."id" AS TEXT))::text END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$;

-- trigger: users:observation-change
CREATE TRIGGER "obs_delta_users_7dfb4cf67742" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"."users" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"."obs_delta_users_7dfb4cf67742"();

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:6bd17728b5c120475ca8955d629b9c669a89087371adddeb2ee59da58585e1d7', active_table_count = 252, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:92f680cc5dacd69f83f87650ec1b6a9e7b21189911ade7780a8f507525c1a68d' RETURNING contract_digest;
