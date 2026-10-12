CREATE INDEX `observation_projection_history_scope_day` ON `observation_projection_history` (`kind`,`section`,`component`,`cohort_at`,`key`);--> statement-breakpoint
CREATE INDEX `observation_projection_work_unapplied` ON `observation_projection_work` (`applied_revision`,`id`);
--> statement-breakpoint
CREATE TRIGGER "obs_delta_agents_8c70b25cbbbe_insert" AFTER INSERT ON "agents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'agents',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_agents_8c70b25cbbbe_update" AFTER UPDATE ON "agents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'agents',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_agents_8c70b25cbbbe_delete" AFTER DELETE ON "agents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'agents',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_sessions_f4fc994cf568_insert" AFTER INSERT ON "intent_sessions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_sessions',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_sessions_f4fc994cf568_update" AFTER UPDATE ON "intent_sessions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_sessions',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_sessions_f4fc994cf568_delete" AFTER DELETE ON "intent_sessions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_sessions',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_turn_events_9577a85373ce_insert" AFTER INSERT ON "intent_turn_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_turn_events',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'turn_id',CAST(NEW."turn_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT),'source',CAST(NEW."source" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_turn_events_9577a85373ce_update" AFTER UPDATE ON "intent_turn_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_turn_events',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'turn_id',CAST(OLD."turn_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT),'source',CAST(OLD."source" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'turn_id',CAST(NEW."turn_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT),'source',CAST(NEW."source" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_turn_events_9577a85373ce_delete" AFTER DELETE ON "intent_turn_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_turn_events',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'turn_id',CAST(OLD."turn_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT),'source',CAST(OLD."source" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_turns_a0c059001e55_insert" AFTER INSERT ON "intent_turns" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_turns',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'capture_root_session_id',CAST(NEW."capture_root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_turns_a0c059001e55_update" AFTER UPDATE ON "intent_turns" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_turns',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'capture_root_session_id',CAST(OLD."capture_root_session_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'capture_root_session_id',CAST(NEW."capture_root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_intent_turns_a0c059001e55_delete" AFTER DELETE ON "intent_turns" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'intent_turns',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'capture_root_session_id',CAST(OLD."capture_root_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_events_3026f434cf19_insert" AFTER INSERT ON "mcp_runtime_test_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_events',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'test_session_id',CAST(NEW."test_session_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT),'source',CAST(NEW."source" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_events_3026f434cf19_update" AFTER UPDATE ON "mcp_runtime_test_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_events',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'test_session_id',CAST(OLD."test_session_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT),'source',CAST(OLD."source" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'test_session_id',CAST(NEW."test_session_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT),'source',CAST(NEW."source" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_events_3026f434cf19_delete" AFTER DELETE ON "mcp_runtime_test_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_events',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'test_session_id',CAST(OLD."test_session_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT),'source',CAST(OLD."source" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_sessions_9f19ae79a165_insert" AFTER INSERT ON "mcp_runtime_test_sessions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_sessions',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'mcp_id',CAST(NEW."mcp_id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT),'runtime_row_id',CAST(NEW."runtime_row_id" AS TEXT),'runtime_name',CAST(NEW."runtime_name" AS TEXT),'runtime_protocol',CAST(NEW."runtime_protocol" AS TEXT),'runtime_snapshot_json',CAST(NEW."runtime_snapshot_json" AS TEXT),'runtime_binary_path',CAST(NEW."runtime_binary_path" AS TEXT),'runtime_session_id',CAST(NEW."runtime_session_id" AS TEXT),'native_session_state',CAST(NEW."native_session_state" AS TEXT),'session_version',CAST(NEW."session_version" AS TEXT),'scratch_root',CAST(NEW."scratch_root" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_sessions_9f19ae79a165_update" AFTER UPDATE ON "mcp_runtime_test_sessions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_sessions',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'mcp_id',CAST(OLD."mcp_id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT),'runtime_row_id',CAST(OLD."runtime_row_id" AS TEXT),'runtime_name',CAST(OLD."runtime_name" AS TEXT),'runtime_protocol',CAST(OLD."runtime_protocol" AS TEXT),'runtime_snapshot_json',CAST(OLD."runtime_snapshot_json" AS TEXT),'runtime_binary_path',CAST(OLD."runtime_binary_path" AS TEXT),'runtime_session_id',CAST(OLD."runtime_session_id" AS TEXT),'native_session_state',CAST(OLD."native_session_state" AS TEXT),'session_version',CAST(OLD."session_version" AS TEXT),'scratch_root',CAST(OLD."scratch_root" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'mcp_id',CAST(NEW."mcp_id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT),'runtime_row_id',CAST(NEW."runtime_row_id" AS TEXT),'runtime_name',CAST(NEW."runtime_name" AS TEXT),'runtime_protocol',CAST(NEW."runtime_protocol" AS TEXT),'runtime_snapshot_json',CAST(NEW."runtime_snapshot_json" AS TEXT),'runtime_binary_path',CAST(NEW."runtime_binary_path" AS TEXT),'runtime_session_id',CAST(NEW."runtime_session_id" AS TEXT),'native_session_state',CAST(NEW."native_session_state" AS TEXT),'session_version',CAST(NEW."session_version" AS TEXT),'scratch_root',CAST(NEW."scratch_root" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_sessions_9f19ae79a165_delete" AFTER DELETE ON "mcp_runtime_test_sessions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_sessions',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'mcp_id',CAST(OLD."mcp_id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT),'runtime_row_id',CAST(OLD."runtime_row_id" AS TEXT),'runtime_name',CAST(OLD."runtime_name" AS TEXT),'runtime_protocol',CAST(OLD."runtime_protocol" AS TEXT),'runtime_snapshot_json',CAST(OLD."runtime_snapshot_json" AS TEXT),'runtime_binary_path',CAST(OLD."runtime_binary_path" AS TEXT),'runtime_session_id',CAST(OLD."runtime_session_id" AS TEXT),'native_session_state',CAST(OLD."native_session_state" AS TEXT),'session_version',CAST(OLD."session_version" AS TEXT),'scratch_root',CAST(OLD."scratch_root" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_turns_5facdc2dda15_insert" AFTER INSERT ON "mcp_runtime_test_turns" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_turns',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_turns_5facdc2dda15_update" AFTER UPDATE ON "mcp_runtime_test_turns" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_turns',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_mcp_runtime_test_turns_5facdc2dda15_delete" AFTER DELETE ON "mcp_runtime_test_turns" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'mcp_runtime_test_turns',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_memory_distill_events_9222b906089a_insert" AFTER INSERT ON "memory_distill_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'memory_distill_events',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'distill_job_id',CAST(NEW."distill_job_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_memory_distill_events_9222b906089a_update" AFTER UPDATE ON "memory_distill_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'memory_distill_events',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'distill_job_id',CAST(OLD."distill_job_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'distill_job_id',CAST(NEW."distill_job_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_memory_distill_events_9222b906089a_delete" AFTER DELETE ON "memory_distill_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'memory_distill_events',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'distill_job_id',CAST(OLD."distill_job_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_memory_distill_jobs_7c1cff75edd4_insert" AFTER INSERT ON "memory_distill_jobs" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'memory_distill_jobs',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'source_kind',CAST(NEW."source_kind" AS TEXT),'source_event_id',CAST(NEW."source_event_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'opencode_session_id',CAST(NEW."opencode_session_id" AS TEXT),'user_prompt_md',CAST(NEW."user_prompt_md" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_memory_distill_jobs_7c1cff75edd4_update" AFTER UPDATE ON "memory_distill_jobs" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'memory_distill_jobs',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'source_kind',CAST(OLD."source_kind" AS TEXT),'source_event_id',CAST(OLD."source_event_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'opencode_session_id',CAST(OLD."opencode_session_id" AS TEXT),'user_prompt_md',CAST(OLD."user_prompt_md" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'source_kind',CAST(NEW."source_kind" AS TEXT),'source_event_id',CAST(NEW."source_event_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'opencode_session_id',CAST(NEW."opencode_session_id" AS TEXT),'user_prompt_md',CAST(NEW."user_prompt_md" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_memory_distill_jobs_7c1cff75edd4_delete" AFTER DELETE ON "memory_distill_jobs" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'memory_distill_jobs',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'source_kind',CAST(OLD."source_kind" AS TEXT),'source_event_id',CAST(OLD."source_event_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'opencode_session_id',CAST(OLD."opencode_session_id" AS TEXT),'user_prompt_md',CAST(OLD."user_prompt_md" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_node_run_events_01109c2fd4cf_insert" AFTER INSERT ON "node_run_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'node_run_events',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_node_run_events_01109c2fd4cf_update" AFTER UPDATE ON "node_run_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'node_run_events',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_node_run_events_01109c2fd4cf_delete" AFTER DELETE ON "node_run_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'node_run_events',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_node_runs_d3d6de02630e_insert" AFTER INSERT ON "node_runs" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'node_runs',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'parent_node_run_id',CAST(NEW."parent_node_run_id" AS TEXT),'opencode_session_id',CAST(NEW."opencode_session_id" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'runtime_binary',CAST(NEW."runtime_binary" AS TEXT),'runtime_params_json',CAST(NEW."runtime_params_json" AS TEXT),'runtime_inventory_json',CAST(NEW."runtime_inventory_json" AS TEXT),'agent_override_name',CAST(NEW."agent_override_name" AS TEXT),'agent_override_id',CAST(NEW."agent_override_id" AS TEXT),'child_task_id',CAST(NEW."child_task_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_node_runs_d3d6de02630e_update" AFTER UPDATE ON "node_runs" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'node_runs',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'parent_node_run_id',CAST(OLD."parent_node_run_id" AS TEXT),'opencode_session_id',CAST(OLD."opencode_session_id" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'runtime_binary',CAST(OLD."runtime_binary" AS TEXT),'runtime_params_json',CAST(OLD."runtime_params_json" AS TEXT),'runtime_inventory_json',CAST(OLD."runtime_inventory_json" AS TEXT),'agent_override_name',CAST(OLD."agent_override_name" AS TEXT),'agent_override_id',CAST(OLD."agent_override_id" AS TEXT),'child_task_id',CAST(OLD."child_task_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'parent_node_run_id',CAST(NEW."parent_node_run_id" AS TEXT),'opencode_session_id',CAST(NEW."opencode_session_id" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'runtime_binary',CAST(NEW."runtime_binary" AS TEXT),'runtime_params_json',CAST(NEW."runtime_params_json" AS TEXT),'runtime_inventory_json',CAST(NEW."runtime_inventory_json" AS TEXT),'agent_override_name',CAST(NEW."agent_override_name" AS TEXT),'agent_override_id',CAST(NEW."agent_override_id" AS TEXT),'child_task_id',CAST(NEW."child_task_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_node_runs_d3d6de02630e_delete" AFTER DELETE ON "node_runs" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'node_runs',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'parent_node_run_id',CAST(OLD."parent_node_run_id" AS TEXT),'opencode_session_id',CAST(OLD."opencode_session_id" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'runtime_binary',CAST(OLD."runtime_binary" AS TEXT),'runtime_params_json',CAST(OLD."runtime_params_json" AS TEXT),'runtime_inventory_json',CAST(OLD."runtime_inventory_json" AS TEXT),'agent_override_name',CAST(OLD."agent_override_name" AS TEXT),'agent_override_id',CAST(OLD."agent_override_id" AS TEXT),'child_task_id',CAST(OLD."child_task_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_invocations_ddde8c4db0d6_insert" AFTER INSERT ON "observation_invocations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_invocations',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'$invocation',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.invocationId')='text' THEN CAST(json_extract(NEW."document",'$.invocationId') AS TEXT) ELSE NULL END,'$attempt',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.nodeRunId')='text' THEN CAST(json_extract(NEW."document",'$.nodeRunId') AS TEXT) ELSE NULL END,'$agent',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.agentId')='text' THEN CAST(json_extract(NEW."document",'$.agentId') AS TEXT) ELSE NULL END,'$runtime',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.authority.runtime.registrationId')='text' THEN CAST(json_extract(NEW."document",'$.authority.runtime.registrationId') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_invocations_ddde8c4db0d6_update" AFTER UPDATE ON "observation_invocations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_invocations',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'$invocation',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.invocationId')='text' THEN CAST(json_extract(OLD."document",'$.invocationId') AS TEXT) ELSE NULL END,'$attempt',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.nodeRunId')='text' THEN CAST(json_extract(OLD."document",'$.nodeRunId') AS TEXT) ELSE NULL END,'$agent',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.agentId')='text' THEN CAST(json_extract(OLD."document",'$.agentId') AS TEXT) ELSE NULL END,'$runtime',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.authority.runtime.registrationId')='text' THEN CAST(json_extract(OLD."document",'$.authority.runtime.registrationId') AS TEXT) ELSE NULL END),json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'$invocation',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.invocationId')='text' THEN CAST(json_extract(NEW."document",'$.invocationId') AS TEXT) ELSE NULL END,'$attempt',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.nodeRunId')='text' THEN CAST(json_extract(NEW."document",'$.nodeRunId') AS TEXT) ELSE NULL END,'$agent',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.agentId')='text' THEN CAST(json_extract(NEW."document",'$.agentId') AS TEXT) ELSE NULL END,'$runtime',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.authority.runtime.registrationId')='text' THEN CAST(json_extract(NEW."document",'$.authority.runtime.registrationId') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_invocations_ddde8c4db0d6_delete" AFTER DELETE ON "observation_invocations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_invocations',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'$invocation',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.invocationId')='text' THEN CAST(json_extract(OLD."document",'$.invocationId') AS TEXT) ELSE NULL END,'$attempt',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.nodeRunId')='text' THEN CAST(json_extract(OLD."document",'$.nodeRunId') AS TEXT) ELSE NULL END,'$agent',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.agentId')='text' THEN CAST(json_extract(OLD."document",'$.agentId') AS TEXT) ELSE NULL END,'$runtime',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.authority.runtime.registrationId')='text' THEN CAST(json_extract(OLD."document",'$.authority.runtime.registrationId') AS TEXT) ELSE NULL END),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_platform_records_b9c238a11799_insert" AFTER INSERT ON "observation_platform_records" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_platform_records',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'source_key',CAST(NEW."source_key" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_platform_records_b9c238a11799_update" AFTER UPDATE ON "observation_platform_records" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_platform_records',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'source_key',CAST(OLD."source_key" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'source_key',CAST(NEW."source_key" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_platform_records_b9c238a11799_delete" AFTER DELETE ON "observation_platform_records" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_platform_records',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'source_key',CAST(OLD."source_key" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_platform_sources_0d51a229caf9_insert" AFTER INSERT ON "observation_platform_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_platform_sources',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'$platformSource',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.binding.sourceId')='text' THEN CAST(json_extract(NEW."document",'$.binding.sourceId') AS TEXT) ELSE NULL END,'$platformProject',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.binding.projectId')='text' THEN CAST(json_extract(NEW."document",'$.binding.projectId') AS TEXT) ELSE NULL END,'$platformTask',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.binding.taskId')='text' THEN CAST(json_extract(NEW."document",'$.binding.taskId') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_platform_sources_0d51a229caf9_update" AFTER UPDATE ON "observation_platform_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_platform_sources',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'$platformSource',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.binding.sourceId')='text' THEN CAST(json_extract(OLD."document",'$.binding.sourceId') AS TEXT) ELSE NULL END,'$platformProject',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.binding.projectId')='text' THEN CAST(json_extract(OLD."document",'$.binding.projectId') AS TEXT) ELSE NULL END,'$platformTask',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.binding.taskId')='text' THEN CAST(json_extract(OLD."document",'$.binding.taskId') AS TEXT) ELSE NULL END),json_object('id',CAST(NEW."id" AS TEXT),'$platformSource',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.binding.sourceId')='text' THEN CAST(json_extract(NEW."document",'$.binding.sourceId') AS TEXT) ELSE NULL END,'$platformProject',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.binding.projectId')='text' THEN CAST(json_extract(NEW."document",'$.binding.projectId') AS TEXT) ELSE NULL END,'$platformTask',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.binding.taskId')='text' THEN CAST(json_extract(NEW."document",'$.binding.taskId') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_platform_sources_0d51a229caf9_delete" AFTER DELETE ON "observation_platform_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_platform_sources',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'$platformSource',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.binding.sourceId')='text' THEN CAST(json_extract(OLD."document",'$.binding.sourceId') AS TEXT) ELSE NULL END,'$platformProject',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.binding.projectId')='text' THEN CAST(json_extract(OLD."document",'$.binding.projectId') AS TEXT) ELSE NULL END,'$platformTask',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.binding.taskId')='text' THEN CAST(json_extract(OLD."document",'$.binding.taskId') AS TEXT) ELSE NULL END),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_price_heads_e45105caf86d_insert" AFTER INSERT ON "observation_price_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_price_heads',json_object('registration_id',CAST(NEW."registration_id" AS TEXT)),'insert',NULL,json_object('registration_id',CAST(NEW."registration_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_price_heads_e45105caf86d_update" AFTER UPDATE ON "observation_price_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_price_heads',json_object('registration_id',CAST(NEW."registration_id" AS TEXT)),'update',json_object('registration_id',CAST(OLD."registration_id" AS TEXT)),json_object('registration_id',CAST(NEW."registration_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_price_heads_e45105caf86d_delete" AFTER DELETE ON "observation_price_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_price_heads',json_object('registration_id',CAST(OLD."registration_id" AS TEXT)),'delete',json_object('registration_id',CAST(OLD."registration_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_price_versions_40e139831493_insert" AFTER INSERT ON "observation_price_versions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_price_versions',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_price_versions_40e139831493_update" AFTER UPDATE ON "observation_price_versions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_price_versions',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_price_versions_40e139831493_delete" AFTER DELETE ON "observation_price_versions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_price_versions',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_captures_69ed66269937_insert" AFTER INSERT ON "observation_usage_captures" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_captures',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'source_cursor',CAST(NEW."source_cursor" AS TEXT),'native_root_key',CAST(NEW."native_root_key" AS TEXT),'$root',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.evidence.capture.rootSessionId')='text' THEN CAST(json_extract(NEW."document",'$.evidence.capture.rootSessionId') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_captures_69ed66269937_update" AFTER UPDATE ON "observation_usage_captures" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_captures',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'source_cursor',CAST(OLD."source_cursor" AS TEXT),'native_root_key',CAST(OLD."native_root_key" AS TEXT),'$root',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.evidence.capture.rootSessionId')='text' THEN CAST(json_extract(OLD."document",'$.evidence.capture.rootSessionId') AS TEXT) ELSE NULL END),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'source_cursor',CAST(NEW."source_cursor" AS TEXT),'native_root_key',CAST(NEW."native_root_key" AS TEXT),'$root',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.evidence.capture.rootSessionId')='text' THEN CAST(json_extract(NEW."document",'$.evidence.capture.rootSessionId') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_captures_69ed66269937_delete" AFTER DELETE ON "observation_usage_captures" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_captures',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'source_cursor',CAST(OLD."source_cursor" AS TEXT),'native_root_key',CAST(OLD."native_root_key" AS TEXT),'$root',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.evidence.capture.rootSessionId')='text' THEN CAST(json_extract(OLD."document",'$.evidence.capture.rootSessionId') AS TEXT) ELSE NULL END),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_current_5c718590978a_insert" AFTER INSERT ON "observation_usage_current" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_current',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'$invocation',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.measurement.invocationId')='text' THEN CAST(json_extract(NEW."document",'$.measurement.invocationId') AS TEXT) ELSE NULL END,'$root',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.measurement.scope.root')='text' THEN CAST(json_extract(NEW."document",'$.measurement.scope.root') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_current_5c718590978a_update" AFTER UPDATE ON "observation_usage_current" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_current',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'$invocation',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.measurement.invocationId')='text' THEN CAST(json_extract(OLD."document",'$.measurement.invocationId') AS TEXT) ELSE NULL END,'$root',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.measurement.scope.root')='text' THEN CAST(json_extract(OLD."document",'$.measurement.scope.root') AS TEXT) ELSE NULL END),json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'$invocation',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.measurement.invocationId')='text' THEN CAST(json_extract(NEW."document",'$.measurement.invocationId') AS TEXT) ELSE NULL END,'$root',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.measurement.scope.root')='text' THEN CAST(json_extract(NEW."document",'$.measurement.scope.root') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_current_5c718590978a_delete" AFTER DELETE ON "observation_usage_current" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_current',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'$invocation',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.measurement.invocationId')='text' THEN CAST(json_extract(OLD."document",'$.measurement.invocationId') AS TEXT) ELSE NULL END,'$root',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.measurement.scope.root')='text' THEN CAST(json_extract(OLD."document",'$.measurement.scope.root') AS TEXT) ELSE NULL END),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_events_20955815b204_insert" AFTER INSERT ON "observation_usage_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_events',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'record_key',CAST(NEW."record_key" AS TEXT),'$invocation',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.invocationId')='text' THEN CAST(json_extract(NEW."document",'$.invocationId') AS TEXT) ELSE NULL END,'$task',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.taskId')='text' THEN CAST(json_extract(NEW."document",'$.taskId') AS TEXT) ELSE NULL END,'$root',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.scope.root')='text' THEN CAST(json_extract(NEW."document",'$.scope.root') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_events_20955815b204_update" AFTER UPDATE ON "observation_usage_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_events',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'record_key',CAST(OLD."record_key" AS TEXT),'$invocation',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.invocationId')='text' THEN CAST(json_extract(OLD."document",'$.invocationId') AS TEXT) ELSE NULL END,'$task',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.taskId')='text' THEN CAST(json_extract(OLD."document",'$.taskId') AS TEXT) ELSE NULL END,'$root',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.scope.root')='text' THEN CAST(json_extract(OLD."document",'$.scope.root') AS TEXT) ELSE NULL END),json_object('id',CAST(NEW."id" AS TEXT),'source_id',CAST(NEW."source_id" AS TEXT),'record_key',CAST(NEW."record_key" AS TEXT),'$invocation',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.invocationId')='text' THEN CAST(json_extract(NEW."document",'$.invocationId') AS TEXT) ELSE NULL END,'$task',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.taskId')='text' THEN CAST(json_extract(NEW."document",'$.taskId') AS TEXT) ELSE NULL END,'$root',CASE WHEN json_valid(NEW."document") AND json_type(NEW."document",'$.scope.root')='text' THEN CAST(json_extract(NEW."document",'$.scope.root') AS TEXT) ELSE NULL END),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_events_20955815b204_delete" AFTER DELETE ON "observation_usage_events" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_events',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'source_id',CAST(OLD."source_id" AS TEXT),'record_key',CAST(OLD."record_key" AS TEXT),'$invocation',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.invocationId')='text' THEN CAST(json_extract(OLD."document",'$.invocationId') AS TEXT) ELSE NULL END,'$task',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.taskId')='text' THEN CAST(json_extract(OLD."document",'$.taskId') AS TEXT) ELSE NULL END,'$root',CASE WHEN json_valid(OLD."document") AND json_type(OLD."document",'$.scope.root')='text' THEN CAST(json_extract(OLD."document",'$.scope.root') AS TEXT) ELSE NULL END),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_native_rec_80ccf5536f6c_insert" AFTER INSERT ON "observation_usage_native_records" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_native_records',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'native_source',CAST(NEW."native_source" AS TEXT),'native_root',CAST(NEW."native_root" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_native_rec_80ccf5536f6c_update" AFTER UPDATE ON "observation_usage_native_records" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_native_records',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'native_source',CAST(OLD."native_source" AS TEXT),'native_root',CAST(OLD."native_root" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'native_source',CAST(NEW."native_source" AS TEXT),'native_root',CAST(NEW."native_root" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_native_rec_80ccf5536f6c_delete" AFTER DELETE ON "observation_usage_native_records" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_native_records',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'native_source',CAST(OLD."native_source" AS TEXT),'native_root',CAST(OLD."native_root" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_sources_b509b15c3b1b_insert" AFTER INSERT ON "observation_usage_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_sources',json_object('source_id',CAST(NEW."source_id" AS TEXT)),'insert',NULL,json_object('source_id',CAST(NEW."source_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_sources_b509b15c3b1b_update" AFTER UPDATE ON "observation_usage_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_sources',json_object('source_id',CAST(NEW."source_id" AS TEXT)),'update',json_object('source_id',CAST(OLD."source_id" AS TEXT)),json_object('source_id',CAST(NEW."source_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_observation_usage_sources_b509b15c3b1b_delete" AFTER DELETE ON "observation_usage_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'observation_usage_sources',json_object('source_id',CAST(OLD."source_id" AS TEXT)),'delete',json_object('source_id',CAST(OLD."source_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_em_364e7e46c5e0_insert" AFTER INSERT ON "system_agent_native_usage_emissions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_emissions',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT),'source_row_id',CAST(NEW."source_row_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_em_364e7e46c5e0_update" AFTER UPDATE ON "system_agent_native_usage_emissions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_emissions',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT),'source_row_id',CAST(OLD."source_row_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT),'source_row_id',CAST(NEW."source_row_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_em_364e7e46c5e0_delete" AFTER DELETE ON "system_agent_native_usage_emissions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_emissions',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT),'source_row_id',CAST(OLD."source_row_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_ba37186c0936_insert" AFTER INSERT ON "system_agent_native_usage_pass_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_pass_heads',json_object('key',CAST(NEW."key" AS TEXT)),'insert',NULL,json_object('key',CAST(NEW."key" AS TEXT),'pass_id',CAST(NEW."pass_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_ba37186c0936_update" AFTER UPDATE ON "system_agent_native_usage_pass_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_pass_heads',json_object('key',CAST(NEW."key" AS TEXT)),'update',json_object('key',CAST(OLD."key" AS TEXT),'pass_id',CAST(OLD."pass_id" AS TEXT)),json_object('key',CAST(NEW."key" AS TEXT),'pass_id',CAST(NEW."pass_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_ba37186c0936_delete" AFTER DELETE ON "system_agent_native_usage_pass_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_pass_heads',json_object('key',CAST(OLD."key" AS TEXT)),'delete',json_object('key',CAST(OLD."key" AS TEXT),'pass_id',CAST(OLD."pass_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_771477690e2b_insert" AFTER INSERT ON "system_agent_native_usage_pass_pages" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_pass_pages',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT)),'insert',NULL,json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_771477690e2b_update" AFTER UPDATE ON "system_agent_native_usage_pass_pages" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_pass_pages',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT)),'update',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT)),json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_771477690e2b_delete" AFTER DELETE ON "system_agent_native_usage_pass_pages" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_pass_pages',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT)),'delete',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_6520d2339bb5_insert" AFTER INSERT ON "system_agent_native_usage_passes" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_passes',json_object('pass_id',CAST(NEW."pass_id" AS TEXT)),'insert',NULL,json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'invocation_id',CAST(NEW."invocation_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT),'root_created_at',CAST(NEW."root_created_at" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_6520d2339bb5_update" AFTER UPDATE ON "system_agent_native_usage_passes" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_passes',json_object('pass_id',CAST(NEW."pass_id" AS TEXT)),'update',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'invocation_id',CAST(OLD."invocation_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT),'root_created_at',CAST(OLD."root_created_at" AS TEXT)),json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'invocation_id',CAST(NEW."invocation_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT),'root_created_at',CAST(NEW."root_created_at" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pa_6520d2339bb5_delete" AFTER DELETE ON "system_agent_native_usage_passes" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_passes',json_object('pass_id',CAST(OLD."pass_id" AS TEXT)),'delete',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'invocation_id',CAST(OLD."invocation_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT),'root_created_at',CAST(OLD."root_created_at" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pr_ec4ab414cf07_insert" AFTER INSERT ON "system_agent_native_usage_preparations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_preparations',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pr_ec4ab414cf07_update" AFTER UPDATE ON "system_agent_native_usage_preparations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_preparations',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_pr_ec4ab414cf07_delete" AFTER DELETE ON "system_agent_native_usage_preparations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_preparations',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_re_1baf88801307_insert" AFTER INSERT ON "system_agent_native_usage_revision_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_revision_heads',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_re_1baf88801307_update" AFTER UPDATE ON "system_agent_native_usage_revision_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_revision_heads',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_re_1baf88801307_delete" AFTER DELETE ON "system_agent_native_usage_revision_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_revision_heads',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_9ed202dd645c_insert" AFTER INSERT ON "system_agent_native_usage_root_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_heads',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'first_root_session_id',CAST(NEW."first_root_session_id" AS TEXT),'last_root_session_id',CAST(NEW."last_root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_9ed202dd645c_update" AFTER UPDATE ON "system_agent_native_usage_root_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_heads',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'first_root_session_id',CAST(OLD."first_root_session_id" AS TEXT),'last_root_session_id',CAST(OLD."last_root_session_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'first_root_session_id',CAST(NEW."first_root_session_id" AS TEXT),'last_root_session_id',CAST(NEW."last_root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_9ed202dd645c_delete" AFTER DELETE ON "system_agent_native_usage_root_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_heads',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'first_root_session_id',CAST(OLD."first_root_session_id" AS TEXT),'last_root_session_id',CAST(OLD."last_root_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_60f7ad4db013_insert" AFTER INSERT ON "system_agent_native_usage_root_results" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_results',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_60f7ad4db013_update" AFTER UPDATE ON "system_agent_native_usage_root_results" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_results',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_60f7ad4db013_delete" AFTER DELETE ON "system_agent_native_usage_root_results" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_results',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_64e30e7a3e2c_insert" AFTER INSERT ON "system_agent_native_usage_root_sets" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_sets',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'root_digest',CAST(NEW."root_digest" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_64e30e7a3e2c_update" AFTER UPDATE ON "system_agent_native_usage_root_sets" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_sets',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'root_digest',CAST(OLD."root_digest" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'root_digest',CAST(NEW."root_digest" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_64e30e7a3e2c_delete" AFTER DELETE ON "system_agent_native_usage_root_sets" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_sets',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'root_digest',CAST(OLD."root_digest" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_32f58d5077c1_insert" AFTER INSERT ON "system_agent_native_usage_root_transitions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_transitions',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_32f58d5077c1_update" AFTER UPDATE ON "system_agent_native_usage_root_transitions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_transitions',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_ro_32f58d5077c1_delete" AFTER DELETE ON "system_agent_native_usage_root_transitions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_root_transitions',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_se_71b41666d29a_insert" AFTER INSERT ON "system_agent_native_usage_session_parents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_session_parents',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),'insert',NULL,json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_se_71b41666d29a_update" AFTER UPDATE ON "system_agent_native_usage_session_parents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_session_parents',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),'update',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT)),json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_se_71b41666d29a_delete" AFTER DELETE ON "system_agent_native_usage_session_parents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_session_parents',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT)),'delete',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_st_7414b1fb4392_insert" AFTER INSERT ON "system_agent_native_usage_step_members" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_step_members',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT)),'insert',NULL,json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_st_7414b1fb4392_update" AFTER UPDATE ON "system_agent_native_usage_step_members" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_step_members',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT)),'update',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT)),json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_st_7414b1fb4392_delete" AFTER DELETE ON "system_agent_native_usage_step_members" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_step_members',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT)),'delete',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_st_d569eb209fc4_insert" AFTER INSERT ON "system_agent_native_usage_store_bindings" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_store_bindings',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(NEW."before_owner_receipt_id" AS TEXT),'source_generation',CAST(NEW."source_generation" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_st_d569eb209fc4_update" AFTER UPDATE ON "system_agent_native_usage_store_bindings" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_store_bindings',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(OLD."before_owner_receipt_id" AS TEXT),'source_generation',CAST(OLD."source_generation" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(NEW."before_owner_receipt_id" AS TEXT),'source_generation',CAST(NEW."source_generation" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_native_usage_st_d569eb209fc4_delete" AFTER DELETE ON "system_agent_native_usage_store_bindings" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_native_usage_store_bindings',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(OLD."before_owner_receipt_id" AS TEXT),'source_generation',CAST(OLD."source_generation" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_gro_f79391caed8d_insert" AFTER INSERT ON "system_agent_observation_groups" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_groups',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'parent_task_id',CAST(NEW."parent_task_id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_gro_f79391caed8d_update" AFTER UPDATE ON "system_agent_observation_groups" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_groups',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'parent_task_id',CAST(OLD."parent_task_id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'parent_task_id',CAST(NEW."parent_task_id" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_gro_f79391caed8d_delete" AFTER DELETE ON "system_agent_observation_groups" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_groups',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'parent_task_id',CAST(OLD."parent_task_id" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_own_67b3c6637001_insert" AFTER INSERT ON "system_agent_observation_owners" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_owners',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'group_id',CAST(NEW."group_id" AS TEXT),'agent_id',CAST(NEW."agent_id" AS TEXT),'agent_name',CAST(NEW."agent_name" AS TEXT),'agent_revision',CAST(NEW."agent_revision" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'owner_nonce',CAST(NEW."owner_nonce" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_own_67b3c6637001_update" AFTER UPDATE ON "system_agent_observation_owners" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_owners',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'group_id',CAST(OLD."group_id" AS TEXT),'agent_id',CAST(OLD."agent_id" AS TEXT),'agent_name',CAST(OLD."agent_name" AS TEXT),'agent_revision',CAST(OLD."agent_revision" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'owner_nonce',CAST(OLD."owner_nonce" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'group_id',CAST(NEW."group_id" AS TEXT),'agent_id',CAST(NEW."agent_id" AS TEXT),'agent_name',CAST(NEW."agent_name" AS TEXT),'agent_revision',CAST(NEW."agent_revision" AS TEXT),'runtime',CAST(NEW."runtime" AS TEXT),'owner_nonce',CAST(NEW."owner_nonce" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_own_67b3c6637001_delete" AFTER DELETE ON "system_agent_observation_owners" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_owners',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'group_id',CAST(OLD."group_id" AS TEXT),'agent_id',CAST(OLD."agent_id" AS TEXT),'agent_name',CAST(OLD."agent_name" AS TEXT),'agent_revision',CAST(OLD."agent_revision" AS TEXT),'runtime',CAST(OLD."runtime" AS TEXT),'owner_nonce',CAST(OLD."owner_nonce" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_sou_e2eb3c17fdf9_insert" AFTER INSERT ON "system_agent_observation_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_sources',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_sou_e2eb3c17fdf9_update" AFTER UPDATE ON "system_agent_observation_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_sources',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_system_agent_observation_sou_e2eb3c17fdf9_delete" AFTER DELETE ON "system_agent_observation_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'system_agent_observation_sources',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_collaborators_a2cc5248664c_insert" AFTER INSERT ON "task_collaborators" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_collaborators',json_object('task_id',CAST(NEW."task_id" AS TEXT),'user_id',CAST(NEW."user_id" AS TEXT),'role',CAST(NEW."role" AS TEXT)),'insert',NULL,json_object('task_id',CAST(NEW."task_id" AS TEXT),'user_id',CAST(NEW."user_id" AS TEXT),'role',CAST(NEW."role" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_collaborators_a2cc5248664c_update" AFTER UPDATE ON "task_collaborators" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_collaborators',json_object('task_id',CAST(NEW."task_id" AS TEXT),'user_id',CAST(NEW."user_id" AS TEXT),'role',CAST(NEW."role" AS TEXT)),'update',json_object('task_id',CAST(OLD."task_id" AS TEXT),'user_id',CAST(OLD."user_id" AS TEXT),'role',CAST(OLD."role" AS TEXT)),json_object('task_id',CAST(NEW."task_id" AS TEXT),'user_id',CAST(NEW."user_id" AS TEXT),'role',CAST(NEW."role" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_collaborators_a2cc5248664c_delete" AFTER DELETE ON "task_collaborators" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_collaborators',json_object('task_id',CAST(OLD."task_id" AS TEXT),'user_id',CAST(OLD."user_id" AS TEXT),'role',CAST(OLD."role" AS TEXT)),'delete',json_object('task_id',CAST(OLD."task_id" AS TEXT),'user_id',CAST(OLD."user_id" AS TEXT),'role',CAST(OLD."role" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__c8b1327ae70a_insert" AFTER INSERT ON "task_execution_native_usage_emissions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_emissions',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT),'source_row_id',CAST(NEW."source_row_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__c8b1327ae70a_update" AFTER UPDATE ON "task_execution_native_usage_emissions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_emissions',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT),'source_row_id',CAST(OLD."source_row_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'event_id',CAST(NEW."event_id" AS TEXT),'source_row_id',CAST(NEW."source_row_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__c8b1327ae70a_delete" AFTER DELETE ON "task_execution_native_usage_emissions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_emissions',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'event_id',CAST(OLD."event_id" AS TEXT),'source_row_id',CAST(OLD."source_row_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__65f2373ec8b0_insert" AFTER INSERT ON "task_execution_native_usage_pass_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_pass_heads',json_object('key',CAST(NEW."key" AS TEXT)),'insert',NULL,json_object('key',CAST(NEW."key" AS TEXT),'pass_id',CAST(NEW."pass_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__65f2373ec8b0_update" AFTER UPDATE ON "task_execution_native_usage_pass_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_pass_heads',json_object('key',CAST(NEW."key" AS TEXT)),'update',json_object('key',CAST(OLD."key" AS TEXT),'pass_id',CAST(OLD."pass_id" AS TEXT)),json_object('key',CAST(NEW."key" AS TEXT),'pass_id',CAST(NEW."pass_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__65f2373ec8b0_delete" AFTER DELETE ON "task_execution_native_usage_pass_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_pass_heads',json_object('key',CAST(OLD."key" AS TEXT)),'delete',json_object('key',CAST(OLD."key" AS TEXT),'pass_id',CAST(OLD."pass_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__a6a06b98c7fd_insert" AFTER INSERT ON "task_execution_native_usage_pass_pages" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_pass_pages',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT)),'insert',NULL,json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__a6a06b98c7fd_update" AFTER UPDATE ON "task_execution_native_usage_pass_pages" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_pass_pages',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT)),'update',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT)),json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'ordinal',CAST(NEW."ordinal" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__a6a06b98c7fd_delete" AFTER DELETE ON "task_execution_native_usage_pass_pages" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_pass_pages',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT)),'delete',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'ordinal',CAST(OLD."ordinal" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__bdc22d8b4973_insert" AFTER INSERT ON "task_execution_native_usage_passes" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_passes',json_object('pass_id',CAST(NEW."pass_id" AS TEXT)),'insert',NULL,json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'invocation_id',CAST(NEW."invocation_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT),'root_created_at',CAST(NEW."root_created_at" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__bdc22d8b4973_update" AFTER UPDATE ON "task_execution_native_usage_passes" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_passes',json_object('pass_id',CAST(NEW."pass_id" AS TEXT)),'update',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'invocation_id',CAST(OLD."invocation_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT),'root_created_at',CAST(OLD."root_created_at" AS TEXT)),json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'invocation_id',CAST(NEW."invocation_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT),'root_created_at',CAST(NEW."root_created_at" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__bdc22d8b4973_delete" AFTER DELETE ON "task_execution_native_usage_passes" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_passes',json_object('pass_id',CAST(OLD."pass_id" AS TEXT)),'delete',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'invocation_id',CAST(OLD."invocation_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT),'root_created_at',CAST(OLD."root_created_at" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__4253a159b085_insert" AFTER INSERT ON "task_execution_native_usage_preparations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_preparations',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__4253a159b085_update" AFTER UPDATE ON "task_execution_native_usage_preparations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_preparations',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'owner_receipt_id',CAST(NEW."owner_receipt_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__4253a159b085_delete" AFTER DELETE ON "task_execution_native_usage_preparations" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_preparations',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'owner_receipt_id',CAST(OLD."owner_receipt_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__93d68d4e5e09_insert" AFTER INSERT ON "task_execution_native_usage_revision_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_revision_heads',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__93d68d4e5e09_update" AFTER UPDATE ON "task_execution_native_usage_revision_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_revision_heads',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'record_id',CAST(NEW."record_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__93d68d4e5e09_delete" AFTER DELETE ON "task_execution_native_usage_revision_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_revision_heads',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'record_id',CAST(OLD."record_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__a5adc08382bc_insert" AFTER INSERT ON "task_execution_native_usage_root_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_heads',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'first_root_session_id',CAST(NEW."first_root_session_id" AS TEXT),'last_root_session_id',CAST(NEW."last_root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__a5adc08382bc_update" AFTER UPDATE ON "task_execution_native_usage_root_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_heads',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'first_root_session_id',CAST(OLD."first_root_session_id" AS TEXT),'last_root_session_id',CAST(OLD."last_root_session_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT),'first_root_session_id',CAST(NEW."first_root_session_id" AS TEXT),'last_root_session_id',CAST(NEW."last_root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__a5adc08382bc_delete" AFTER DELETE ON "task_execution_native_usage_root_heads" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_heads',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT),'first_root_session_id',CAST(OLD."first_root_session_id" AS TEXT),'last_root_session_id',CAST(OLD."last_root_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__d6f5b5fad9a7_insert" AFTER INSERT ON "task_execution_native_usage_root_results" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_results',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__d6f5b5fad9a7_update" AFTER UPDATE ON "task_execution_native_usage_root_results" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_results',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'result_id',CAST(NEW."result_id" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__d6f5b5fad9a7_delete" AFTER DELETE ON "task_execution_native_usage_root_results" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_results',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'result_id',CAST(OLD."result_id" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__84a2186b134d_insert" AFTER INSERT ON "task_execution_native_usage_root_sets" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_sets',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'root_digest',CAST(NEW."root_digest" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__84a2186b134d_update" AFTER UPDATE ON "task_execution_native_usage_root_sets" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_sets',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'root_digest',CAST(OLD."root_digest" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'root_digest',CAST(NEW."root_digest" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__84a2186b134d_delete" AFTER DELETE ON "task_execution_native_usage_root_sets" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_sets',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'root_digest',CAST(OLD."root_digest" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__e20c6c58809d_insert" AFTER INSERT ON "task_execution_native_usage_root_transitions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_transitions',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__e20c6c58809d_update" AFTER UPDATE ON "task_execution_native_usage_root_transitions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_transitions',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'ordinal_key',CAST(NEW."ordinal_key" AS TEXT),'root_session_id',CAST(NEW."root_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__e20c6c58809d_delete" AFTER DELETE ON "task_execution_native_usage_root_transitions" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_root_transitions',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'ordinal_key',CAST(OLD."ordinal_key" AS TEXT),'root_session_id',CAST(OLD."root_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__1503f7a42ca6_insert" AFTER INSERT ON "task_execution_native_usage_session_parents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_session_parents',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),'insert',NULL,json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__1503f7a42ca6_update" AFTER UPDATE ON "task_execution_native_usage_session_parents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_session_parents',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),'update',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT)),json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT),'parent_session_id',CAST(NEW."parent_session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__1503f7a42ca6_delete" AFTER DELETE ON "task_execution_native_usage_session_parents" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_session_parents',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT)),'delete',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT),'parent_session_id',CAST(OLD."parent_session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__7d6b31fa31e2_insert" AFTER INSERT ON "task_execution_native_usage_step_members" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_step_members',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT)),'insert',NULL,json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__7d6b31fa31e2_update" AFTER UPDATE ON "task_execution_native_usage_step_members" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_step_members',json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT)),'update',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT)),json_object('pass_id',CAST(NEW."pass_id" AS TEXT),'step_id',CAST(NEW."step_id" AS TEXT),'session_id',CAST(NEW."session_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__7d6b31fa31e2_delete" AFTER DELETE ON "task_execution_native_usage_step_members" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_step_members',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT)),'delete',json_object('pass_id',CAST(OLD."pass_id" AS TEXT),'step_id',CAST(OLD."step_id" AS TEXT),'session_id',CAST(OLD."session_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__cac99809a707_insert" AFTER INSERT ON "task_execution_native_usage_store_bindings" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_store_bindings',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'insert',NULL,json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(NEW."before_owner_receipt_id" AS TEXT),'source_generation',CAST(NEW."source_generation" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__cac99809a707_update" AFTER UPDATE ON "task_execution_native_usage_store_bindings" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_store_bindings',json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT)),'update',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(OLD."before_owner_receipt_id" AS TEXT),'source_generation',CAST(OLD."source_generation" AS TEXT)),json_object('invocation_id',CAST(NEW."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(NEW."before_owner_receipt_id" AS TEXT),'source_generation',CAST(NEW."source_generation" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_native_usage__cac99809a707_delete" AFTER DELETE ON "task_execution_native_usage_store_bindings" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_native_usage_store_bindings',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT)),'delete',json_object('invocation_id',CAST(OLD."invocation_id" AS TEXT),'before_owner_receipt_id',CAST(OLD."before_owner_receipt_id" AS TEXT),'source_generation',CAST(OLD."source_generation" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_observation_s_47fab48faf75_insert" AFTER INSERT ON "task_execution_observation_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_observation_sources',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_observation_s_47fab48faf75_update" AFTER UPDATE ON "task_execution_observation_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_observation_sources',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'task_id',CAST(NEW."task_id" AS TEXT),'node_run_id',CAST(NEW."node_run_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_execution_observation_s_47fab48faf75_delete" AFTER DELETE ON "task_execution_observation_sources" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_execution_observation_sources',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'task_id',CAST(OLD."task_id" AS TEXT),'node_run_id',CAST(OLD."node_run_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_repos_e002384bcdaf_insert" AFTER INSERT ON "task_repos" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_repos',json_object('task_id',CAST(NEW."task_id" AS TEXT),'repo_index',CAST(NEW."repo_index" AS TEXT)),'insert',NULL,json_object('task_id',CAST(NEW."task_id" AS TEXT),'repo_index',CAST(NEW."repo_index" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_repos_e002384bcdaf_update" AFTER UPDATE ON "task_repos" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_repos',json_object('task_id',CAST(NEW."task_id" AS TEXT),'repo_index',CAST(NEW."repo_index" AS TEXT)),'update',json_object('task_id',CAST(OLD."task_id" AS TEXT),'repo_index',CAST(OLD."repo_index" AS TEXT)),json_object('task_id',CAST(NEW."task_id" AS TEXT),'repo_index',CAST(NEW."repo_index" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_task_repos_e002384bcdaf_delete" AFTER DELETE ON "task_repos" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'task_repos',json_object('task_id',CAST(OLD."task_id" AS TEXT),'repo_index',CAST(OLD."repo_index" AS TEXT)),'delete',json_object('task_id',CAST(OLD."task_id" AS TEXT),'repo_index',CAST(OLD."repo_index" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_tasks_085154084c74_insert" AFTER INSERT ON "tasks" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'tasks',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT),'repo_group_id',CAST(NEW."repo_group_id" AS TEXT),'repo_group_name',CAST(NEW."repo_group_name" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT),'git_user_name',CAST(NEW."git_user_name" AS TEXT),'git_user_email',CAST(NEW."git_user_email" AS TEXT),'scheduled_task_id',CAST(NEW."scheduled_task_id" AS TEXT),'source_termination_binding',CAST(NEW."source_termination_binding" AS TEXT),'source_termination_launch_rev',CAST(NEW."source_termination_launch_rev" AS TEXT),'source_termination_fence',CAST(NEW."source_termination_fence" AS TEXT),'source_termination_effect_rev',CAST(NEW."source_termination_effect_rev" AS TEXT),'source_agent_name',CAST(NEW."source_agent_name" AS TEXT),'source_agent_id',CAST(NEW."source_agent_id" AS TEXT),'parent_task_id',CAST(NEW."parent_task_id" AS TEXT),'parent_node_run_id',CAST(NEW."parent_node_run_id" AS TEXT),'invocation_depth',CAST(NEW."invocation_depth" AS TEXT),'root_task_id',CAST(NEW."root_task_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_tasks_085154084c74_update" AFTER UPDATE ON "tasks" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'tasks',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT),'repo_group_id',CAST(OLD."repo_group_id" AS TEXT),'repo_group_name',CAST(OLD."repo_group_name" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT),'git_user_name',CAST(OLD."git_user_name" AS TEXT),'git_user_email',CAST(OLD."git_user_email" AS TEXT),'scheduled_task_id',CAST(OLD."scheduled_task_id" AS TEXT),'source_termination_binding',CAST(OLD."source_termination_binding" AS TEXT),'source_termination_launch_rev',CAST(OLD."source_termination_launch_rev" AS TEXT),'source_termination_fence',CAST(OLD."source_termination_fence" AS TEXT),'source_termination_effect_rev',CAST(OLD."source_termination_effect_rev" AS TEXT),'source_agent_name',CAST(OLD."source_agent_name" AS TEXT),'source_agent_id',CAST(OLD."source_agent_id" AS TEXT),'parent_task_id',CAST(OLD."parent_task_id" AS TEXT),'parent_node_run_id',CAST(OLD."parent_node_run_id" AS TEXT),'invocation_depth',CAST(OLD."invocation_depth" AS TEXT),'root_task_id',CAST(OLD."root_task_id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT),'repo_group_id',CAST(NEW."repo_group_id" AS TEXT),'repo_group_name',CAST(NEW."repo_group_name" AS TEXT),'owner_user_id',CAST(NEW."owner_user_id" AS TEXT),'git_user_name',CAST(NEW."git_user_name" AS TEXT),'git_user_email',CAST(NEW."git_user_email" AS TEXT),'scheduled_task_id',CAST(NEW."scheduled_task_id" AS TEXT),'source_termination_binding',CAST(NEW."source_termination_binding" AS TEXT),'source_termination_launch_rev',CAST(NEW."source_termination_launch_rev" AS TEXT),'source_termination_fence',CAST(NEW."source_termination_fence" AS TEXT),'source_termination_effect_rev',CAST(NEW."source_termination_effect_rev" AS TEXT),'source_agent_name',CAST(NEW."source_agent_name" AS TEXT),'source_agent_id',CAST(NEW."source_agent_id" AS TEXT),'parent_task_id',CAST(NEW."parent_task_id" AS TEXT),'parent_node_run_id',CAST(NEW."parent_node_run_id" AS TEXT),'invocation_depth',CAST(NEW."invocation_depth" AS TEXT),'root_task_id',CAST(NEW."root_task_id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_tasks_085154084c74_delete" AFTER DELETE ON "tasks" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'tasks',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT),'repo_group_id',CAST(OLD."repo_group_id" AS TEXT),'repo_group_name',CAST(OLD."repo_group_name" AS TEXT),'owner_user_id',CAST(OLD."owner_user_id" AS TEXT),'git_user_name',CAST(OLD."git_user_name" AS TEXT),'git_user_email',CAST(OLD."git_user_email" AS TEXT),'scheduled_task_id',CAST(OLD."scheduled_task_id" AS TEXT),'source_termination_binding',CAST(OLD."source_termination_binding" AS TEXT),'source_termination_launch_rev',CAST(OLD."source_termination_launch_rev" AS TEXT),'source_termination_fence',CAST(OLD."source_termination_fence" AS TEXT),'source_termination_effect_rev',CAST(OLD."source_termination_effect_rev" AS TEXT),'source_agent_name',CAST(OLD."source_agent_name" AS TEXT),'source_agent_id',CAST(OLD."source_agent_id" AS TEXT),'parent_task_id',CAST(OLD."parent_task_id" AS TEXT),'parent_node_run_id',CAST(OLD."parent_node_run_id" AS TEXT),'invocation_depth',CAST(OLD."invocation_depth" AS TEXT),'root_task_id',CAST(OLD."root_task_id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_users_7dfb4cf67742_insert" AFTER INSERT ON "users" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'users',json_object('id',CAST(NEW."id" AS TEXT)),'insert',NULL,json_object('id',CAST(NEW."id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_users_7dfb4cf67742_update" AFTER UPDATE ON "users" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'users',json_object('id',CAST(NEW."id" AS TEXT)),'update',json_object('id',CAST(OLD."id" AS TEXT)),json_object('id',CAST(NEW."id" AS TEXT)),CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE TRIGGER "obs_delta_users_7dfb4cf67742_delete" AFTER DELETE ON "users" BEGIN
INSERT INTO "observation_projection_changes" ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),'users',json_object('id',CAST(OLD."id" AS TEXT)),'delete',json_object('id',CAST(OLD."id" AS TEXT)),NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END;
--> statement-breakpoint
CREATE INDEX `observation_projection_changes_ready` ON `observation_projection_changes` (`completed`,`retry_at`,`created_at`,`id`);
