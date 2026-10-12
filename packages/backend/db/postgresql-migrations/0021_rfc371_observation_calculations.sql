-- table: observation_calculation_rows
CREATE TABLE "agent_workflow"."observation_calculation_rows" (
  "cache_key" TEXT COLLATE "C" NOT NULL,
  "namespace" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_calculation_rows_pkey" PRIMARY KEY ("cache_key", "namespace", "key")
);

-- table: observation_calculation_versions
CREATE TABLE "agent_workflow"."observation_calculation_versions" (
  "cache_key" TEXT COLLATE "C" NOT NULL,
  "source_key" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_calculation_versions_pkey" PRIMARY KEY ("cache_key")
);

-- table: observation_source_revisions
CREATE TABLE "agent_workflow"."observation_source_revisions" (
  "source_id" TEXT COLLATE "C" NOT NULL,
  "revision" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_source_revisions_pkey" PRIMARY KEY ("source_id")
);

-- constraint: observation_calculation_rows:fk:observation_calculation_rows_cache_key_observation_calculation_versions_cache_key_fk
ALTER TABLE "agent_workflow"."observation_calculation_rows" ADD CONSTRAINT "observation_calculation_rows_cache_key_observation_de0a90343bb0" FOREIGN KEY ("cache_key") REFERENCES "agent_workflow"."observation_calculation_versions" ("cache_key") ON UPDATE NO ACTION ON DELETE CASCADE;

-- metadata: observation_source_revisions:initial-revisions
INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('agents',gen_random_uuid()::text),('intent_sessions',gen_random_uuid()::text),('intent_turn_events',gen_random_uuid()::text),('intent_turns',gen_random_uuid()::text),('mcp_runtime_test_events',gen_random_uuid()::text),('mcp_runtime_test_sessions',gen_random_uuid()::text),('mcp_runtime_test_turns',gen_random_uuid()::text),('memory_distill_events',gen_random_uuid()::text),('memory_distill_jobs',gen_random_uuid()::text),('node_run_events',gen_random_uuid()::text),('node_runs',gen_random_uuid()::text),('observation_invocations',gen_random_uuid()::text),('observation_platform_records',gen_random_uuid()::text),('observation_platform_sources',gen_random_uuid()::text),('observation_price_heads',gen_random_uuid()::text),('observation_price_versions',gen_random_uuid()::text),('observation_usage_captures',gen_random_uuid()::text),('observation_usage_current',gen_random_uuid()::text),('observation_usage_events',gen_random_uuid()::text),('observation_usage_native_records',gen_random_uuid()::text),('observation_usage_sources',gen_random_uuid()::text),('system_agent_native_usage_emissions',gen_random_uuid()::text),('system_agent_native_usage_pass_heads',gen_random_uuid()::text),('system_agent_native_usage_pass_pages',gen_random_uuid()::text),('system_agent_native_usage_passes',gen_random_uuid()::text),('system_agent_native_usage_preparations',gen_random_uuid()::text),('system_agent_native_usage_revision_heads',gen_random_uuid()::text),('system_agent_native_usage_root_heads',gen_random_uuid()::text),('system_agent_native_usage_root_results',gen_random_uuid()::text),('system_agent_native_usage_root_sets',gen_random_uuid()::text),('system_agent_native_usage_root_transitions',gen_random_uuid()::text),('system_agent_native_usage_session_parents',gen_random_uuid()::text),('system_agent_native_usage_step_members',gen_random_uuid()::text),('system_agent_native_usage_store_bindings',gen_random_uuid()::text),('system_agent_observation_groups',gen_random_uuid()::text),('system_agent_observation_owners',gen_random_uuid()::text),('system_agent_observation_sources',gen_random_uuid()::text),('task_collaborators',gen_random_uuid()::text),('task_execution_native_usage_emissions',gen_random_uuid()::text),('task_execution_native_usage_pass_heads',gen_random_uuid()::text),('task_execution_native_usage_pass_pages',gen_random_uuid()::text),('task_execution_native_usage_passes',gen_random_uuid()::text),('task_execution_native_usage_preparations',gen_random_uuid()::text),('task_execution_native_usage_revision_heads',gen_random_uuid()::text),('task_execution_native_usage_root_heads',gen_random_uuid()::text),('task_execution_native_usage_root_results',gen_random_uuid()::text),('task_execution_native_usage_root_sets',gen_random_uuid()::text),('task_execution_native_usage_root_transitions',gen_random_uuid()::text),('task_execution_native_usage_session_parents',gen_random_uuid()::text),('task_execution_native_usage_step_members',gen_random_uuid()::text),('task_execution_native_usage_store_bindings',gen_random_uuid()::text),('task_execution_observation_sources',gen_random_uuid()::text),('task_repos',gen_random_uuid()::text),('tasks',gen_random_uuid()::text),('users',gen_random_uuid()::text);

-- function: observation_source_revisions:agents:insert
CREATE FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('agents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: agents:observation-source:insert
CREATE TRIGGER "obs_src_agents_8c70b25cbbbe_insert" AFTER INSERT ON "agent_workflow"."agents" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_insert"();

-- function: observation_source_revisions:agents:update
CREATE FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('agents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: agents:observation-source:update
CREATE TRIGGER "obs_src_agents_8c70b25cbbbe_update" AFTER UPDATE ON "agent_workflow"."agents" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_update"();

-- function: observation_source_revisions:agents:delete
CREATE FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('agents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: agents:observation-source:delete
CREATE TRIGGER "obs_src_agents_8c70b25cbbbe_delete" AFTER DELETE ON "agent_workflow"."agents" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_delete"();

-- function: observation_source_revisions:intent_sessions:insert
CREATE FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_sessions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_sessions:observation-source:insert
CREATE TRIGGER "obs_src_intent_sessions_f4fc994cf568_insert" AFTER INSERT ON "agent_workflow"."intent_sessions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_insert"();

-- function: observation_source_revisions:intent_sessions:update
CREATE FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_sessions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_sessions:observation-source:update
CREATE TRIGGER "obs_src_intent_sessions_f4fc994cf568_update" AFTER UPDATE ON "agent_workflow"."intent_sessions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_update"();

-- function: observation_source_revisions:intent_sessions:delete
CREATE FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_sessions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_sessions:observation-source:delete
CREATE TRIGGER "obs_src_intent_sessions_f4fc994cf568_delete" AFTER DELETE ON "agent_workflow"."intent_sessions" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_delete"();

-- function: observation_source_revisions:intent_turn_events:insert
CREATE FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_turn_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_turn_events:observation-source:insert
CREATE TRIGGER "obs_src_intent_turn_events_9577a85373ce_insert" AFTER INSERT ON "agent_workflow"."intent_turn_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_insert"();

-- function: observation_source_revisions:intent_turn_events:update
CREATE FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_turn_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_turn_events:observation-source:update
CREATE TRIGGER "obs_src_intent_turn_events_9577a85373ce_update" AFTER UPDATE ON "agent_workflow"."intent_turn_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_update"();

-- function: observation_source_revisions:intent_turn_events:delete
CREATE FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_turn_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_turn_events:observation-source:delete
CREATE TRIGGER "obs_src_intent_turn_events_9577a85373ce_delete" AFTER DELETE ON "agent_workflow"."intent_turn_events" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_delete"();

-- function: observation_source_revisions:intent_turns:insert
CREATE FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_turns',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_turns:observation-source:insert
CREATE TRIGGER "obs_src_intent_turns_a0c059001e55_insert" AFTER INSERT ON "agent_workflow"."intent_turns" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_insert"();

-- function: observation_source_revisions:intent_turns:update
CREATE FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_turns',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_turns:observation-source:update
CREATE TRIGGER "obs_src_intent_turns_a0c059001e55_update" AFTER UPDATE ON "agent_workflow"."intent_turns" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_update"();

-- function: observation_source_revisions:intent_turns:delete
CREATE FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('intent_turns',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: intent_turns:observation-source:delete
CREATE TRIGGER "obs_src_intent_turns_a0c059001e55_delete" AFTER DELETE ON "agent_workflow"."intent_turns" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_delete"();

-- function: observation_source_revisions:mcp_runtime_test_events:insert
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_events:observation-source:insert
CREATE TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_insert" AFTER INSERT ON "agent_workflow"."mcp_runtime_test_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_insert"();

-- function: observation_source_revisions:mcp_runtime_test_events:update
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_events:observation-source:update
CREATE TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_update" AFTER UPDATE ON "agent_workflow"."mcp_runtime_test_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_update"();

-- function: observation_source_revisions:mcp_runtime_test_events:delete
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_events:observation-source:delete
CREATE TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_delete" AFTER DELETE ON "agent_workflow"."mcp_runtime_test_events" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_delete"();

-- function: observation_source_revisions:mcp_runtime_test_sessions:insert
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_sessions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_sessions:observation-source:insert
CREATE TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_insert" AFTER INSERT ON "agent_workflow"."mcp_runtime_test_sessions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_insert"();

-- function: observation_source_revisions:mcp_runtime_test_sessions:update
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_sessions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_sessions:observation-source:update
CREATE TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_update" AFTER UPDATE ON "agent_workflow"."mcp_runtime_test_sessions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_update"();

-- function: observation_source_revisions:mcp_runtime_test_sessions:delete
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_sessions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_sessions:observation-source:delete
CREATE TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_delete" AFTER DELETE ON "agent_workflow"."mcp_runtime_test_sessions" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_delete"();

-- function: observation_source_revisions:mcp_runtime_test_turns:insert
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_turns',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_turns:observation-source:insert
CREATE TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_insert" AFTER INSERT ON "agent_workflow"."mcp_runtime_test_turns" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_insert"();

-- function: observation_source_revisions:mcp_runtime_test_turns:update
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_turns',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_turns:observation-source:update
CREATE TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_update" AFTER UPDATE ON "agent_workflow"."mcp_runtime_test_turns" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_update"();

-- function: observation_source_revisions:mcp_runtime_test_turns:delete
CREATE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_turns',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: mcp_runtime_test_turns:observation-source:delete
CREATE TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_delete" AFTER DELETE ON "agent_workflow"."mcp_runtime_test_turns" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_delete"();

-- function: observation_source_revisions:memory_distill_events:insert
CREATE FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: memory_distill_events:observation-source:insert
CREATE TRIGGER "obs_src_memory_distill_events_9222b906089a_insert" AFTER INSERT ON "agent_workflow"."memory_distill_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_insert"();

-- function: observation_source_revisions:memory_distill_events:update
CREATE FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: memory_distill_events:observation-source:update
CREATE TRIGGER "obs_src_memory_distill_events_9222b906089a_update" AFTER UPDATE ON "agent_workflow"."memory_distill_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_update"();

-- function: observation_source_revisions:memory_distill_events:delete
CREATE FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: memory_distill_events:observation-source:delete
CREATE TRIGGER "obs_src_memory_distill_events_9222b906089a_delete" AFTER DELETE ON "agent_workflow"."memory_distill_events" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_delete"();

-- function: observation_source_revisions:memory_distill_jobs:insert
CREATE FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_jobs',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: memory_distill_jobs:observation-source:insert
CREATE TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_insert" AFTER INSERT ON "agent_workflow"."memory_distill_jobs" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_insert"();

-- function: observation_source_revisions:memory_distill_jobs:update
CREATE FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_jobs',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: memory_distill_jobs:observation-source:update
CREATE TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_update" AFTER UPDATE ON "agent_workflow"."memory_distill_jobs" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_update"();

-- function: observation_source_revisions:memory_distill_jobs:delete
CREATE FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_jobs',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: memory_distill_jobs:observation-source:delete
CREATE TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_delete" AFTER DELETE ON "agent_workflow"."memory_distill_jobs" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_delete"();

-- function: observation_source_revisions:node_run_events:insert
CREATE FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('node_run_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: node_run_events:observation-source:insert
CREATE TRIGGER "obs_src_node_run_events_01109c2fd4cf_insert" AFTER INSERT ON "agent_workflow"."node_run_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_insert"();

-- function: observation_source_revisions:node_run_events:update
CREATE FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('node_run_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: node_run_events:observation-source:update
CREATE TRIGGER "obs_src_node_run_events_01109c2fd4cf_update" AFTER UPDATE ON "agent_workflow"."node_run_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_update"();

-- function: observation_source_revisions:node_run_events:delete
CREATE FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('node_run_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: node_run_events:observation-source:delete
CREATE TRIGGER "obs_src_node_run_events_01109c2fd4cf_delete" AFTER DELETE ON "agent_workflow"."node_run_events" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_delete"();

-- function: observation_source_revisions:node_runs:insert
CREATE FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('node_runs',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: node_runs:observation-source:insert
CREATE TRIGGER "obs_src_node_runs_d3d6de02630e_insert" AFTER INSERT ON "agent_workflow"."node_runs" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_insert"();

-- function: observation_source_revisions:node_runs:update
CREATE FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('node_runs',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: node_runs:observation-source:update
CREATE TRIGGER "obs_src_node_runs_d3d6de02630e_update" AFTER UPDATE ON "agent_workflow"."node_runs" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_update"();

-- function: observation_source_revisions:node_runs:delete
CREATE FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('node_runs',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: node_runs:observation-source:delete
CREATE TRIGGER "obs_src_node_runs_d3d6de02630e_delete" AFTER DELETE ON "agent_workflow"."node_runs" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_delete"();

-- function: observation_source_revisions:observation_invocations:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_invocations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_invocations:observation-source:insert
CREATE TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_insert" AFTER INSERT ON "agent_workflow"."observation_invocations" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_insert"();

-- function: observation_source_revisions:observation_invocations:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_invocations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_invocations:observation-source:update
CREATE TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_update" AFTER UPDATE ON "agent_workflow"."observation_invocations" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_update"();

-- function: observation_source_revisions:observation_invocations:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_invocations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_invocations:observation-source:delete
CREATE TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_delete" AFTER DELETE ON "agent_workflow"."observation_invocations" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_delete"();

-- function: observation_source_revisions:observation_platform_records:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_records',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_platform_records:observation-source:insert
CREATE TRIGGER "obs_src_observation_platform_records_b9c238a11799_insert" AFTER INSERT ON "agent_workflow"."observation_platform_records" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_insert"();

-- function: observation_source_revisions:observation_platform_records:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_records',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_platform_records:observation-source:update
CREATE TRIGGER "obs_src_observation_platform_records_b9c238a11799_update" AFTER UPDATE ON "agent_workflow"."observation_platform_records" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_update"();

-- function: observation_source_revisions:observation_platform_records:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_records',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_platform_records:observation-source:delete
CREATE TRIGGER "obs_src_observation_platform_records_b9c238a11799_delete" AFTER DELETE ON "agent_workflow"."observation_platform_records" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_delete"();

-- function: observation_source_revisions:observation_platform_sources:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_platform_sources:observation-source:insert
CREATE TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_insert" AFTER INSERT ON "agent_workflow"."observation_platform_sources" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_insert"();

-- function: observation_source_revisions:observation_platform_sources:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_platform_sources:observation-source:update
CREATE TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_update" AFTER UPDATE ON "agent_workflow"."observation_platform_sources" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_update"();

-- function: observation_source_revisions:observation_platform_sources:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_platform_sources:observation-source:delete
CREATE TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_delete" AFTER DELETE ON "agent_workflow"."observation_platform_sources" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_delete"();

-- function: observation_source_revisions:observation_price_heads:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_price_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_price_heads:observation-source:insert
CREATE TRIGGER "obs_src_observation_price_heads_e45105caf86d_insert" AFTER INSERT ON "agent_workflow"."observation_price_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_insert"();

-- function: observation_source_revisions:observation_price_heads:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_price_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_price_heads:observation-source:update
CREATE TRIGGER "obs_src_observation_price_heads_e45105caf86d_update" AFTER UPDATE ON "agent_workflow"."observation_price_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_update"();

-- function: observation_source_revisions:observation_price_heads:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_price_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_price_heads:observation-source:delete
CREATE TRIGGER "obs_src_observation_price_heads_e45105caf86d_delete" AFTER DELETE ON "agent_workflow"."observation_price_heads" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_delete"();

-- function: observation_source_revisions:observation_price_versions:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_price_versions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_price_versions:observation-source:insert
CREATE TRIGGER "obs_src_observation_price_versions_40e139831493_insert" AFTER INSERT ON "agent_workflow"."observation_price_versions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_insert"();

-- function: observation_source_revisions:observation_price_versions:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_price_versions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_price_versions:observation-source:update
CREATE TRIGGER "obs_src_observation_price_versions_40e139831493_update" AFTER UPDATE ON "agent_workflow"."observation_price_versions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_update"();

-- function: observation_source_revisions:observation_price_versions:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_price_versions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_price_versions:observation-source:delete
CREATE TRIGGER "obs_src_observation_price_versions_40e139831493_delete" AFTER DELETE ON "agent_workflow"."observation_price_versions" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_delete"();

-- function: observation_source_revisions:observation_usage_captures:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_captures',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_captures:observation-source:insert
CREATE TRIGGER "obs_src_observation_usage_captures_69ed66269937_insert" AFTER INSERT ON "agent_workflow"."observation_usage_captures" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_insert"();

-- function: observation_source_revisions:observation_usage_captures:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_captures',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_captures:observation-source:update
CREATE TRIGGER "obs_src_observation_usage_captures_69ed66269937_update" AFTER UPDATE ON "agent_workflow"."observation_usage_captures" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_update"();

-- function: observation_source_revisions:observation_usage_captures:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_captures',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_captures:observation-source:delete
CREATE TRIGGER "obs_src_observation_usage_captures_69ed66269937_delete" AFTER DELETE ON "agent_workflow"."observation_usage_captures" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_delete"();

-- function: observation_source_revisions:observation_usage_current:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_current',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_current:observation-source:insert
CREATE TRIGGER "obs_src_observation_usage_current_5c718590978a_insert" AFTER INSERT ON "agent_workflow"."observation_usage_current" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_insert"();

-- function: observation_source_revisions:observation_usage_current:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_current',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_current:observation-source:update
CREATE TRIGGER "obs_src_observation_usage_current_5c718590978a_update" AFTER UPDATE ON "agent_workflow"."observation_usage_current" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_update"();

-- function: observation_source_revisions:observation_usage_current:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_current',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_current:observation-source:delete
CREATE TRIGGER "obs_src_observation_usage_current_5c718590978a_delete" AFTER DELETE ON "agent_workflow"."observation_usage_current" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_delete"();

-- function: observation_source_revisions:observation_usage_events:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_events:observation-source:insert
CREATE TRIGGER "obs_src_observation_usage_events_20955815b204_insert" AFTER INSERT ON "agent_workflow"."observation_usage_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_insert"();

-- function: observation_source_revisions:observation_usage_events:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_events:observation-source:update
CREATE TRIGGER "obs_src_observation_usage_events_20955815b204_update" AFTER UPDATE ON "agent_workflow"."observation_usage_events" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_update"();

-- function: observation_source_revisions:observation_usage_events:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_events',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_events:observation-source:delete
CREATE TRIGGER "obs_src_observation_usage_events_20955815b204_delete" AFTER DELETE ON "agent_workflow"."observation_usage_events" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_delete"();

-- function: observation_source_revisions:observation_usage_native_records:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_native_records',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_native_records:observation-source:insert
CREATE TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_insert" AFTER INSERT ON "agent_workflow"."observation_usage_native_records" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_insert"();

-- function: observation_source_revisions:observation_usage_native_records:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_native_records',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_native_records:observation-source:update
CREATE TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_update" AFTER UPDATE ON "agent_workflow"."observation_usage_native_records" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_update"();

-- function: observation_source_revisions:observation_usage_native_records:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_native_records',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_native_records:observation-source:delete
CREATE TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_delete" AFTER DELETE ON "agent_workflow"."observation_usage_native_records" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_delete"();

-- function: observation_source_revisions:observation_usage_sources:insert
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_sources:observation-source:insert
CREATE TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_insert" AFTER INSERT ON "agent_workflow"."observation_usage_sources" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_insert"();

-- function: observation_source_revisions:observation_usage_sources:update
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_sources:observation-source:update
CREATE TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_update" AFTER UPDATE ON "agent_workflow"."observation_usage_sources" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_update"();

-- function: observation_source_revisions:observation_usage_sources:delete
CREATE FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: observation_usage_sources:observation-source:delete
CREATE TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_delete" AFTER DELETE ON "agent_workflow"."observation_usage_sources" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_delete"();

-- function: observation_source_revisions:system_agent_native_usage_emissions:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_emissions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_emissions:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_emissions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_insert"();

-- function: observation_source_revisions:system_agent_native_usage_emissions:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_emissions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_emissions:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_emissions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_update"();

-- function: observation_source_revisions:system_agent_native_usage_emissions:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_emissions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_emissions:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_emissions" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_delete"();

-- function: observation_source_revisions:system_agent_native_usage_pass_heads:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_pass_heads:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_pass_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_insert"();

-- function: observation_source_revisions:system_agent_native_usage_pass_heads:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_pass_heads:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_pass_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_update"();

-- function: observation_source_revisions:system_agent_native_usage_pass_heads:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_pass_heads:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_pass_heads" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_delete"();

-- function: observation_source_revisions:system_agent_native_usage_pass_pages:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_pages',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_pass_pages:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_pass_pages" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_insert"();

-- function: observation_source_revisions:system_agent_native_usage_pass_pages:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_pages',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_pass_pages:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_pass_pages" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_update"();

-- function: observation_source_revisions:system_agent_native_usage_pass_pages:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_pages',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_pass_pages:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_pass_pages" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_delete"();

-- function: observation_source_revisions:system_agent_native_usage_passes:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_passes',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_passes:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_passes" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_insert"();

-- function: observation_source_revisions:system_agent_native_usage_passes:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_passes',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_passes:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_passes" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_update"();

-- function: observation_source_revisions:system_agent_native_usage_passes:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_passes',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_passes:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_passes" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_delete"();

-- function: observation_source_revisions:system_agent_native_usage_preparations:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_preparations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_preparations:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_preparations" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_insert"();

-- function: observation_source_revisions:system_agent_native_usage_preparations:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_preparations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_preparations:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_preparations" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_update"();

-- function: observation_source_revisions:system_agent_native_usage_preparations:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_preparations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_preparations:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_preparations" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_delete"();

-- function: observation_source_revisions:system_agent_native_usage_revision_heads:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_revision_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_revision_heads:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_revision_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_insert"();

-- function: observation_source_revisions:system_agent_native_usage_revision_heads:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_revision_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_revision_heads:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_revision_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_update"();

-- function: observation_source_revisions:system_agent_native_usage_revision_heads:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_revision_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_revision_heads:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_revision_heads" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_delete"();

-- function: observation_source_revisions:system_agent_native_usage_root_heads:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_heads:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_root_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_insert"();

-- function: observation_source_revisions:system_agent_native_usage_root_heads:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_heads:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_root_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_update"();

-- function: observation_source_revisions:system_agent_native_usage_root_heads:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_heads:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_root_heads" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_delete"();

-- function: observation_source_revisions:system_agent_native_usage_root_results:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_results',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_results:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_root_results" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_insert"();

-- function: observation_source_revisions:system_agent_native_usage_root_results:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_results',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_results:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_root_results" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_update"();

-- function: observation_source_revisions:system_agent_native_usage_root_results:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_results',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_results:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_root_results" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_delete"();

-- function: observation_source_revisions:system_agent_native_usage_root_sets:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_sets',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_sets:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_root_sets" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_insert"();

-- function: observation_source_revisions:system_agent_native_usage_root_sets:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_sets',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_sets:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_root_sets" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_update"();

-- function: observation_source_revisions:system_agent_native_usage_root_sets:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_sets',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_sets:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_root_sets" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_delete"();

-- function: observation_source_revisions:system_agent_native_usage_root_transitions:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_transitions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_transitions:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_root_transitions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_insert"();

-- function: observation_source_revisions:system_agent_native_usage_root_transitions:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_transitions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_transitions:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_root_transitions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_update"();

-- function: observation_source_revisions:system_agent_native_usage_root_transitions:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_transitions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_root_transitions:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_root_transitions" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_delete"();

-- function: observation_source_revisions:system_agent_native_usage_session_parents:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_session_parents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_session_parents:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_session_parents" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_insert"();

-- function: observation_source_revisions:system_agent_native_usage_session_parents:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_session_parents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_session_parents:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_session_parents" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_update"();

-- function: observation_source_revisions:system_agent_native_usage_session_parents:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_session_parents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_session_parents:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_session_parents" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_delete"();

-- function: observation_source_revisions:system_agent_native_usage_step_members:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_step_members',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_step_members:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_step_members" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_insert"();

-- function: observation_source_revisions:system_agent_native_usage_step_members:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_step_members',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_step_members:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_step_members" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_update"();

-- function: observation_source_revisions:system_agent_native_usage_step_members:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_step_members',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_step_members:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_step_members" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_delete"();

-- function: observation_source_revisions:system_agent_native_usage_store_bindings:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_store_bindings',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_store_bindings:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_insert" AFTER INSERT ON "agent_workflow"."system_agent_native_usage_store_bindings" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_insert"();

-- function: observation_source_revisions:system_agent_native_usage_store_bindings:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_store_bindings',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_store_bindings:observation-source:update
CREATE TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_update" AFTER UPDATE ON "agent_workflow"."system_agent_native_usage_store_bindings" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_update"();

-- function: observation_source_revisions:system_agent_native_usage_store_bindings:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_store_bindings',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_native_usage_store_bindings:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_delete" AFTER DELETE ON "agent_workflow"."system_agent_native_usage_store_bindings" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_delete"();

-- function: observation_source_revisions:system_agent_observation_groups:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_groups',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_groups:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_insert" AFTER INSERT ON "agent_workflow"."system_agent_observation_groups" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_insert"();

-- function: observation_source_revisions:system_agent_observation_groups:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_groups',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_groups:observation-source:update
CREATE TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_update" AFTER UPDATE ON "agent_workflow"."system_agent_observation_groups" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_update"();

-- function: observation_source_revisions:system_agent_observation_groups:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_groups',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_groups:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_delete" AFTER DELETE ON "agent_workflow"."system_agent_observation_groups" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_delete"();

-- function: observation_source_revisions:system_agent_observation_owners:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_owners',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_owners:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_insert" AFTER INSERT ON "agent_workflow"."system_agent_observation_owners" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_insert"();

-- function: observation_source_revisions:system_agent_observation_owners:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_owners',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_owners:observation-source:update
CREATE TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_update" AFTER UPDATE ON "agent_workflow"."system_agent_observation_owners" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_update"();

-- function: observation_source_revisions:system_agent_observation_owners:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_owners',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_owners:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_delete" AFTER DELETE ON "agent_workflow"."system_agent_observation_owners" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_delete"();

-- function: observation_source_revisions:system_agent_observation_sources:insert
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_sources:observation-source:insert
CREATE TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_insert" AFTER INSERT ON "agent_workflow"."system_agent_observation_sources" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_insert"();

-- function: observation_source_revisions:system_agent_observation_sources:update
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_sources:observation-source:update
CREATE TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_update" AFTER UPDATE ON "agent_workflow"."system_agent_observation_sources" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_update"();

-- function: observation_source_revisions:system_agent_observation_sources:delete
CREATE FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: system_agent_observation_sources:observation-source:delete
CREATE TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_delete" AFTER DELETE ON "agent_workflow"."system_agent_observation_sources" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_delete"();

-- function: observation_source_revisions:task_collaborators:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_collaborators',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_collaborators:observation-source:insert
CREATE TRIGGER "obs_src_task_collaborators_a2cc5248664c_insert" AFTER INSERT ON "agent_workflow"."task_collaborators" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_insert"();

-- function: observation_source_revisions:task_collaborators:update
CREATE FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_collaborators',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_collaborators:observation-source:update
CREATE TRIGGER "obs_src_task_collaborators_a2cc5248664c_update" AFTER UPDATE ON "agent_workflow"."task_collaborators" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_update"();

-- function: observation_source_revisions:task_collaborators:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_collaborators',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_collaborators:observation-source:delete
CREATE TRIGGER "obs_src_task_collaborators_a2cc5248664c_delete" AFTER DELETE ON "agent_workflow"."task_collaborators" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_delete"();

-- function: observation_source_revisions:task_execution_native_usage_emissions:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_emissions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_emissions:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_emissions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_insert"();

-- function: observation_source_revisions:task_execution_native_usage_emissions:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_emissions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_emissions:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_emissions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_update"();

-- function: observation_source_revisions:task_execution_native_usage_emissions:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_emissions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_emissions:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_emissions" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_delete"();

-- function: observation_source_revisions:task_execution_native_usage_pass_heads:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_pass_heads:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_pass_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_insert"();

-- function: observation_source_revisions:task_execution_native_usage_pass_heads:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_pass_heads:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_pass_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_update"();

-- function: observation_source_revisions:task_execution_native_usage_pass_heads:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_pass_heads:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_pass_heads" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_delete"();

-- function: observation_source_revisions:task_execution_native_usage_pass_pages:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_pages',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_pass_pages:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_pass_pages" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_insert"();

-- function: observation_source_revisions:task_execution_native_usage_pass_pages:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_pages',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_pass_pages:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_pass_pages" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_update"();

-- function: observation_source_revisions:task_execution_native_usage_pass_pages:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_pages',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_pass_pages:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_pass_pages" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_delete"();

-- function: observation_source_revisions:task_execution_native_usage_passes:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_passes',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_passes:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_passes" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_insert"();

-- function: observation_source_revisions:task_execution_native_usage_passes:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_passes',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_passes:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_passes" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_update"();

-- function: observation_source_revisions:task_execution_native_usage_passes:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_passes',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_passes:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_passes" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_delete"();

-- function: observation_source_revisions:task_execution_native_usage_preparations:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_preparations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_preparations:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__4253a159b085_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_preparations" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_insert"();

-- function: observation_source_revisions:task_execution_native_usage_preparations:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_preparations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_preparations:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__4253a159b085_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_preparations" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_update"();

-- function: observation_source_revisions:task_execution_native_usage_preparations:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_preparations',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_preparations:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__4253a159b085_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_preparations" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_delete"();

-- function: observation_source_revisions:task_execution_native_usage_revision_heads:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_revision_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_revision_heads:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_revision_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_insert"();

-- function: observation_source_revisions:task_execution_native_usage_revision_heads:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_revision_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_revision_heads:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_revision_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_update"();

-- function: observation_source_revisions:task_execution_native_usage_revision_heads:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_revision_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_revision_heads:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_revision_heads" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_delete"();

-- function: observation_source_revisions:task_execution_native_usage_root_heads:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_heads:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_root_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_insert"();

-- function: observation_source_revisions:task_execution_native_usage_root_heads:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_heads:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_root_heads" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_update"();

-- function: observation_source_revisions:task_execution_native_usage_root_heads:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_heads',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_heads:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_root_heads" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_delete"();

-- function: observation_source_revisions:task_execution_native_usage_root_results:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_results',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_results:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_root_results" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_insert"();

-- function: observation_source_revisions:task_execution_native_usage_root_results:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_results',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_results:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_root_results" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_update"();

-- function: observation_source_revisions:task_execution_native_usage_root_results:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_results',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_results:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_root_results" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_delete"();

-- function: observation_source_revisions:task_execution_native_usage_root_sets:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_sets',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_sets:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_root_sets" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_insert"();

-- function: observation_source_revisions:task_execution_native_usage_root_sets:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_sets',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_sets:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_root_sets" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_update"();

-- function: observation_source_revisions:task_execution_native_usage_root_sets:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_sets',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_sets:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_root_sets" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_delete"();

-- function: observation_source_revisions:task_execution_native_usage_root_transitions:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_transitions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_transitions:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_root_transitions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_insert"();

-- function: observation_source_revisions:task_execution_native_usage_root_transitions:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_transitions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_transitions:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_root_transitions" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_update"();

-- function: observation_source_revisions:task_execution_native_usage_root_transitions:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_transitions',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_root_transitions:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_root_transitions" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_delete"();

-- function: observation_source_revisions:task_execution_native_usage_session_parents:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_session_parents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_session_parents:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_session_parents" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_insert"();

-- function: observation_source_revisions:task_execution_native_usage_session_parents:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_session_parents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_session_parents:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_session_parents" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_update"();

-- function: observation_source_revisions:task_execution_native_usage_session_parents:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_session_parents',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_session_parents:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_session_parents" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_delete"();

-- function: observation_source_revisions:task_execution_native_usage_step_members:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_step_members',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_step_members:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_step_members" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_insert"();

-- function: observation_source_revisions:task_execution_native_usage_step_members:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_step_members',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_step_members:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_step_members" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_update"();

-- function: observation_source_revisions:task_execution_native_usage_step_members:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_step_members',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_step_members:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_step_members" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_delete"();

-- function: observation_source_revisions:task_execution_native_usage_store_bindings:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_store_bindings',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_store_bindings:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_native_usage__cac99809a707_insert" AFTER INSERT ON "agent_workflow"."task_execution_native_usage_store_bindings" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_insert"();

-- function: observation_source_revisions:task_execution_native_usage_store_bindings:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_store_bindings',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_store_bindings:observation-source:update
CREATE TRIGGER "obs_src_task_execution_native_usage__cac99809a707_update" AFTER UPDATE ON "agent_workflow"."task_execution_native_usage_store_bindings" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_update"();

-- function: observation_source_revisions:task_execution_native_usage_store_bindings:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_store_bindings',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_native_usage_store_bindings:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_native_usage__cac99809a707_delete" AFTER DELETE ON "agent_workflow"."task_execution_native_usage_store_bindings" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_delete"();

-- function: observation_source_revisions:task_execution_observation_sources:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_observation_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_observation_sources:observation-source:insert
CREATE TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_insert" AFTER INSERT ON "agent_workflow"."task_execution_observation_sources" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_insert"();

-- function: observation_source_revisions:task_execution_observation_sources:update
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_observation_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_observation_sources:observation-source:update
CREATE TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_update" AFTER UPDATE ON "agent_workflow"."task_execution_observation_sources" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_update"();

-- function: observation_source_revisions:task_execution_observation_sources:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_execution_observation_sources',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_execution_observation_sources:observation-source:delete
CREATE TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_delete" AFTER DELETE ON "agent_workflow"."task_execution_observation_sources" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_delete"();

-- function: observation_source_revisions:task_repos:insert
CREATE FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_repos',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_repos:observation-source:insert
CREATE TRIGGER "obs_src_task_repos_e002384bcdaf_insert" AFTER INSERT ON "agent_workflow"."task_repos" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_insert"();

-- function: observation_source_revisions:task_repos:update
CREATE FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_repos',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_repos:observation-source:update
CREATE TRIGGER "obs_src_task_repos_e002384bcdaf_update" AFTER UPDATE ON "agent_workflow"."task_repos" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_update"();

-- function: observation_source_revisions:task_repos:delete
CREATE FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('task_repos',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: task_repos:observation-source:delete
CREATE TRIGGER "obs_src_task_repos_e002384bcdaf_delete" AFTER DELETE ON "agent_workflow"."task_repos" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_delete"();

-- function: observation_source_revisions:tasks:insert
CREATE FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('tasks',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: tasks:observation-source:insert
CREATE TRIGGER "obs_src_tasks_085154084c74_insert" AFTER INSERT ON "agent_workflow"."tasks" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_insert"();

-- function: observation_source_revisions:tasks:update
CREATE FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('tasks',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: tasks:observation-source:update
CREATE TRIGGER "obs_src_tasks_085154084c74_update" AFTER UPDATE ON "agent_workflow"."tasks" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_update"();

-- function: observation_source_revisions:tasks:delete
CREATE FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('tasks',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: tasks:observation-source:delete
CREATE TRIGGER "obs_src_tasks_085154084c74_delete" AFTER DELETE ON "agent_workflow"."tasks" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_delete"();

-- function: observation_source_revisions:users:insert
CREATE FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('users',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: users:observation-source:insert
CREATE TRIGGER "obs_src_users_7dfb4cf67742_insert" AFTER INSERT ON "agent_workflow"."users" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_insert"();

-- function: observation_source_revisions:users:update
CREATE FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_new_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('users',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: users:observation-source:update
CREATE TRIGGER "obs_src_users_7dfb4cf67742_update" AFTER UPDATE ON "agent_workflow"."users" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_update"();

-- function: observation_source_revisions:users:delete
CREATE FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM aw_old_rows) THEN
    INSERT INTO "agent_workflow"."observation_source_revisions" ("source_id","revision") VALUES ('users',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$;

-- trigger: users:observation-source:delete
CREATE TRIGGER "obs_src_users_7dfb4cf67742_delete" AFTER DELETE ON "agent_workflow"."users" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_delete"();

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:75bf736d0ce25c25e293ba78e82d378ccca540edc2807fa27345d4f8c33dcd27', active_table_count = 238, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:4b1883057f5a2b4096f238e5a2d088f856af2df07fa808db9cde7a08e10ca989' RETURNING contract_digest;
