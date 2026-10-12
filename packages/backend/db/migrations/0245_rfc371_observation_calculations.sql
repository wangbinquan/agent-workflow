CREATE TABLE `observation_calculation_rows` (
	`cache_key` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`cache_key`, `namespace`, `key`),
	FOREIGN KEY (`cache_key`) REFERENCES `observation_calculation_versions`(`cache_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `observation_calculation_versions` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_source_revisions` (
	`source_id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL
);
--> statement-breakpoint
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('agents',lower(hex(randomblob(16)))),('intent_sessions',lower(hex(randomblob(16)))),('intent_turn_events',lower(hex(randomblob(16)))),('intent_turns',lower(hex(randomblob(16)))),('mcp_runtime_test_events',lower(hex(randomblob(16)))),('mcp_runtime_test_sessions',lower(hex(randomblob(16)))),('mcp_runtime_test_turns',lower(hex(randomblob(16)))),('memory_distill_events',lower(hex(randomblob(16)))),('memory_distill_jobs',lower(hex(randomblob(16)))),('node_run_events',lower(hex(randomblob(16)))),('node_runs',lower(hex(randomblob(16)))),('observation_invocations',lower(hex(randomblob(16)))),('observation_platform_records',lower(hex(randomblob(16)))),('observation_platform_sources',lower(hex(randomblob(16)))),('observation_price_heads',lower(hex(randomblob(16)))),('observation_price_versions',lower(hex(randomblob(16)))),('observation_usage_captures',lower(hex(randomblob(16)))),('observation_usage_current',lower(hex(randomblob(16)))),('observation_usage_events',lower(hex(randomblob(16)))),('observation_usage_native_records',lower(hex(randomblob(16)))),('observation_usage_sources',lower(hex(randomblob(16)))),('system_agent_native_usage_emissions',lower(hex(randomblob(16)))),('system_agent_native_usage_pass_heads',lower(hex(randomblob(16)))),('system_agent_native_usage_pass_pages',lower(hex(randomblob(16)))),('system_agent_native_usage_passes',lower(hex(randomblob(16)))),('system_agent_native_usage_preparations',lower(hex(randomblob(16)))),('system_agent_native_usage_revision_heads',lower(hex(randomblob(16)))),('system_agent_native_usage_root_heads',lower(hex(randomblob(16)))),('system_agent_native_usage_root_results',lower(hex(randomblob(16)))),('system_agent_native_usage_root_sets',lower(hex(randomblob(16)))),('system_agent_native_usage_root_transitions',lower(hex(randomblob(16)))),('system_agent_native_usage_session_parents',lower(hex(randomblob(16)))),('system_agent_native_usage_step_members',lower(hex(randomblob(16)))),('system_agent_native_usage_store_bindings',lower(hex(randomblob(16)))),('system_agent_observation_groups',lower(hex(randomblob(16)))),('system_agent_observation_owners',lower(hex(randomblob(16)))),('system_agent_observation_sources',lower(hex(randomblob(16)))),('task_collaborators',lower(hex(randomblob(16)))),('task_execution_native_usage_emissions',lower(hex(randomblob(16)))),('task_execution_native_usage_pass_heads',lower(hex(randomblob(16)))),('task_execution_native_usage_pass_pages',lower(hex(randomblob(16)))),('task_execution_native_usage_passes',lower(hex(randomblob(16)))),('task_execution_native_usage_preparations',lower(hex(randomblob(16)))),('task_execution_native_usage_revision_heads',lower(hex(randomblob(16)))),('task_execution_native_usage_root_heads',lower(hex(randomblob(16)))),('task_execution_native_usage_root_results',lower(hex(randomblob(16)))),('task_execution_native_usage_root_sets',lower(hex(randomblob(16)))),('task_execution_native_usage_root_transitions',lower(hex(randomblob(16)))),('task_execution_native_usage_session_parents',lower(hex(randomblob(16)))),('task_execution_native_usage_step_members',lower(hex(randomblob(16)))),('task_execution_native_usage_store_bindings',lower(hex(randomblob(16)))),('task_execution_observation_sources',lower(hex(randomblob(16)))),('task_repos',lower(hex(randomblob(16)))),('tasks',lower(hex(randomblob(16)))),('users',lower(hex(randomblob(16))));
--> statement-breakpoint
CREATE TRIGGER "obs_src_agents_8c70b25cbbbe_insert" AFTER INSERT ON "agents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('agents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_agents_8c70b25cbbbe_update" AFTER UPDATE ON "agents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('agents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_agents_8c70b25cbbbe_delete" AFTER DELETE ON "agents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('agents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_sessions_f4fc994cf568_insert" AFTER INSERT ON "intent_sessions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_sessions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_sessions_f4fc994cf568_update" AFTER UPDATE ON "intent_sessions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_sessions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_sessions_f4fc994cf568_delete" AFTER DELETE ON "intent_sessions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_sessions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_turn_events_9577a85373ce_insert" AFTER INSERT ON "intent_turn_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_turn_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_turn_events_9577a85373ce_update" AFTER UPDATE ON "intent_turn_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_turn_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_turn_events_9577a85373ce_delete" AFTER DELETE ON "intent_turn_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_turn_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_turns_a0c059001e55_insert" AFTER INSERT ON "intent_turns" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_turns',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_turns_a0c059001e55_update" AFTER UPDATE ON "intent_turns" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_turns',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_intent_turns_a0c059001e55_delete" AFTER DELETE ON "intent_turns" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('intent_turns',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_insert" AFTER INSERT ON "mcp_runtime_test_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_update" AFTER UPDATE ON "mcp_runtime_test_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_delete" AFTER DELETE ON "mcp_runtime_test_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_insert" AFTER INSERT ON "mcp_runtime_test_sessions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_sessions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_update" AFTER UPDATE ON "mcp_runtime_test_sessions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_sessions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_delete" AFTER DELETE ON "mcp_runtime_test_sessions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_sessions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_insert" AFTER INSERT ON "mcp_runtime_test_turns" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_turns',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_update" AFTER UPDATE ON "mcp_runtime_test_turns" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_turns',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_delete" AFTER DELETE ON "mcp_runtime_test_turns" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('mcp_runtime_test_turns',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_memory_distill_events_9222b906089a_insert" AFTER INSERT ON "memory_distill_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_memory_distill_events_9222b906089a_update" AFTER UPDATE ON "memory_distill_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_memory_distill_events_9222b906089a_delete" AFTER DELETE ON "memory_distill_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_insert" AFTER INSERT ON "memory_distill_jobs" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_jobs',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_update" AFTER UPDATE ON "memory_distill_jobs" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_jobs',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_delete" AFTER DELETE ON "memory_distill_jobs" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('memory_distill_jobs',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_node_run_events_01109c2fd4cf_insert" AFTER INSERT ON "node_run_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('node_run_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_node_run_events_01109c2fd4cf_update" AFTER UPDATE ON "node_run_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('node_run_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_node_run_events_01109c2fd4cf_delete" AFTER DELETE ON "node_run_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('node_run_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_node_runs_d3d6de02630e_insert" AFTER INSERT ON "node_runs" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('node_runs',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_node_runs_d3d6de02630e_update" AFTER UPDATE ON "node_runs" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('node_runs',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_node_runs_d3d6de02630e_delete" AFTER DELETE ON "node_runs" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('node_runs',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_insert" AFTER INSERT ON "observation_invocations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_invocations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_update" AFTER UPDATE ON "observation_invocations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_invocations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_delete" AFTER DELETE ON "observation_invocations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_invocations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_platform_records_b9c238a11799_insert" AFTER INSERT ON "observation_platform_records" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_records',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_platform_records_b9c238a11799_update" AFTER UPDATE ON "observation_platform_records" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_records',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_platform_records_b9c238a11799_delete" AFTER DELETE ON "observation_platform_records" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_records',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_insert" AFTER INSERT ON "observation_platform_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_update" AFTER UPDATE ON "observation_platform_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_delete" AFTER DELETE ON "observation_platform_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_platform_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_price_heads_e45105caf86d_insert" AFTER INSERT ON "observation_price_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_price_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_price_heads_e45105caf86d_update" AFTER UPDATE ON "observation_price_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_price_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_price_heads_e45105caf86d_delete" AFTER DELETE ON "observation_price_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_price_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_price_versions_40e139831493_insert" AFTER INSERT ON "observation_price_versions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_price_versions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_price_versions_40e139831493_update" AFTER UPDATE ON "observation_price_versions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_price_versions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_price_versions_40e139831493_delete" AFTER DELETE ON "observation_price_versions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_price_versions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_captures_69ed66269937_insert" AFTER INSERT ON "observation_usage_captures" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_captures',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_captures_69ed66269937_update" AFTER UPDATE ON "observation_usage_captures" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_captures',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_captures_69ed66269937_delete" AFTER DELETE ON "observation_usage_captures" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_captures',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_current_5c718590978a_insert" AFTER INSERT ON "observation_usage_current" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_current',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_current_5c718590978a_update" AFTER UPDATE ON "observation_usage_current" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_current',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_current_5c718590978a_delete" AFTER DELETE ON "observation_usage_current" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_current',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_events_20955815b204_insert" AFTER INSERT ON "observation_usage_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_events_20955815b204_update" AFTER UPDATE ON "observation_usage_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_events_20955815b204_delete" AFTER DELETE ON "observation_usage_events" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_events',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_insert" AFTER INSERT ON "observation_usage_native_records" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_native_records',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_update" AFTER UPDATE ON "observation_usage_native_records" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_native_records',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_delete" AFTER DELETE ON "observation_usage_native_records" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_native_records',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_insert" AFTER INSERT ON "observation_usage_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_update" AFTER UPDATE ON "observation_usage_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_delete" AFTER DELETE ON "observation_usage_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('observation_usage_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_insert" AFTER INSERT ON "system_agent_native_usage_emissions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_emissions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_update" AFTER UPDATE ON "system_agent_native_usage_emissions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_emissions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_delete" AFTER DELETE ON "system_agent_native_usage_emissions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_emissions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_insert" AFTER INSERT ON "system_agent_native_usage_pass_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_update" AFTER UPDATE ON "system_agent_native_usage_pass_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_delete" AFTER DELETE ON "system_agent_native_usage_pass_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_insert" AFTER INSERT ON "system_agent_native_usage_pass_pages" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_pages',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_update" AFTER UPDATE ON "system_agent_native_usage_pass_pages" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_pages',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_delete" AFTER DELETE ON "system_agent_native_usage_pass_pages" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_pass_pages',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_insert" AFTER INSERT ON "system_agent_native_usage_passes" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_passes',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_update" AFTER UPDATE ON "system_agent_native_usage_passes" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_passes',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_delete" AFTER DELETE ON "system_agent_native_usage_passes" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_passes',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_insert" AFTER INSERT ON "system_agent_native_usage_preparations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_preparations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_update" AFTER UPDATE ON "system_agent_native_usage_preparations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_preparations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_delete" AFTER DELETE ON "system_agent_native_usage_preparations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_preparations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_insert" AFTER INSERT ON "system_agent_native_usage_revision_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_revision_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_update" AFTER UPDATE ON "system_agent_native_usage_revision_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_revision_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_delete" AFTER DELETE ON "system_agent_native_usage_revision_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_revision_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_insert" AFTER INSERT ON "system_agent_native_usage_root_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_update" AFTER UPDATE ON "system_agent_native_usage_root_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_delete" AFTER DELETE ON "system_agent_native_usage_root_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_insert" AFTER INSERT ON "system_agent_native_usage_root_results" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_results',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_update" AFTER UPDATE ON "system_agent_native_usage_root_results" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_results',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_delete" AFTER DELETE ON "system_agent_native_usage_root_results" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_results',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_insert" AFTER INSERT ON "system_agent_native_usage_root_sets" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_sets',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_update" AFTER UPDATE ON "system_agent_native_usage_root_sets" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_sets',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_delete" AFTER DELETE ON "system_agent_native_usage_root_sets" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_sets',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_insert" AFTER INSERT ON "system_agent_native_usage_root_transitions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_transitions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_update" AFTER UPDATE ON "system_agent_native_usage_root_transitions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_transitions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_delete" AFTER DELETE ON "system_agent_native_usage_root_transitions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_root_transitions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_insert" AFTER INSERT ON "system_agent_native_usage_session_parents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_session_parents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_update" AFTER UPDATE ON "system_agent_native_usage_session_parents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_session_parents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_delete" AFTER DELETE ON "system_agent_native_usage_session_parents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_session_parents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_insert" AFTER INSERT ON "system_agent_native_usage_step_members" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_step_members',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_update" AFTER UPDATE ON "system_agent_native_usage_step_members" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_step_members',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_delete" AFTER DELETE ON "system_agent_native_usage_step_members" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_step_members',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_insert" AFTER INSERT ON "system_agent_native_usage_store_bindings" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_store_bindings',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_update" AFTER UPDATE ON "system_agent_native_usage_store_bindings" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_store_bindings',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_delete" AFTER DELETE ON "system_agent_native_usage_store_bindings" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_native_usage_store_bindings',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_insert" AFTER INSERT ON "system_agent_observation_groups" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_groups',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_update" AFTER UPDATE ON "system_agent_observation_groups" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_groups',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_delete" AFTER DELETE ON "system_agent_observation_groups" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_groups',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_insert" AFTER INSERT ON "system_agent_observation_owners" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_owners',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_update" AFTER UPDATE ON "system_agent_observation_owners" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_owners',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_delete" AFTER DELETE ON "system_agent_observation_owners" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_owners',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_insert" AFTER INSERT ON "system_agent_observation_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_update" AFTER UPDATE ON "system_agent_observation_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_delete" AFTER DELETE ON "system_agent_observation_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('system_agent_observation_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_collaborators_a2cc5248664c_insert" AFTER INSERT ON "task_collaborators" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_collaborators',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_collaborators_a2cc5248664c_update" AFTER UPDATE ON "task_collaborators" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_collaborators',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_collaborators_a2cc5248664c_delete" AFTER DELETE ON "task_collaborators" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_collaborators',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_insert" AFTER INSERT ON "task_execution_native_usage_emissions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_emissions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_update" AFTER UPDATE ON "task_execution_native_usage_emissions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_emissions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_delete" AFTER DELETE ON "task_execution_native_usage_emissions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_emissions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_insert" AFTER INSERT ON "task_execution_native_usage_pass_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_update" AFTER UPDATE ON "task_execution_native_usage_pass_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_delete" AFTER DELETE ON "task_execution_native_usage_pass_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_insert" AFTER INSERT ON "task_execution_native_usage_pass_pages" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_pages',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_update" AFTER UPDATE ON "task_execution_native_usage_pass_pages" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_pages',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_delete" AFTER DELETE ON "task_execution_native_usage_pass_pages" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_pass_pages',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_insert" AFTER INSERT ON "task_execution_native_usage_passes" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_passes',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_update" AFTER UPDATE ON "task_execution_native_usage_passes" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_passes',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_delete" AFTER DELETE ON "task_execution_native_usage_passes" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_passes',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__4253a159b085_insert" AFTER INSERT ON "task_execution_native_usage_preparations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_preparations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__4253a159b085_update" AFTER UPDATE ON "task_execution_native_usage_preparations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_preparations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__4253a159b085_delete" AFTER DELETE ON "task_execution_native_usage_preparations" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_preparations',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_insert" AFTER INSERT ON "task_execution_native_usage_revision_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_revision_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_update" AFTER UPDATE ON "task_execution_native_usage_revision_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_revision_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_delete" AFTER DELETE ON "task_execution_native_usage_revision_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_revision_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_insert" AFTER INSERT ON "task_execution_native_usage_root_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_update" AFTER UPDATE ON "task_execution_native_usage_root_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_delete" AFTER DELETE ON "task_execution_native_usage_root_heads" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_heads',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_insert" AFTER INSERT ON "task_execution_native_usage_root_results" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_results',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_update" AFTER UPDATE ON "task_execution_native_usage_root_results" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_results',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_delete" AFTER DELETE ON "task_execution_native_usage_root_results" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_results',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_insert" AFTER INSERT ON "task_execution_native_usage_root_sets" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_sets',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_update" AFTER UPDATE ON "task_execution_native_usage_root_sets" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_sets',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_delete" AFTER DELETE ON "task_execution_native_usage_root_sets" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_sets',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_insert" AFTER INSERT ON "task_execution_native_usage_root_transitions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_transitions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_update" AFTER UPDATE ON "task_execution_native_usage_root_transitions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_transitions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_delete" AFTER DELETE ON "task_execution_native_usage_root_transitions" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_root_transitions',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_insert" AFTER INSERT ON "task_execution_native_usage_session_parents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_session_parents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_update" AFTER UPDATE ON "task_execution_native_usage_session_parents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_session_parents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_delete" AFTER DELETE ON "task_execution_native_usage_session_parents" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_session_parents',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_insert" AFTER INSERT ON "task_execution_native_usage_step_members" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_step_members',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_update" AFTER UPDATE ON "task_execution_native_usage_step_members" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_step_members',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_delete" AFTER DELETE ON "task_execution_native_usage_step_members" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_step_members',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__cac99809a707_insert" AFTER INSERT ON "task_execution_native_usage_store_bindings" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_store_bindings',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__cac99809a707_update" AFTER UPDATE ON "task_execution_native_usage_store_bindings" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_store_bindings',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_native_usage__cac99809a707_delete" AFTER DELETE ON "task_execution_native_usage_store_bindings" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_native_usage_store_bindings',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_insert" AFTER INSERT ON "task_execution_observation_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_observation_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_update" AFTER UPDATE ON "task_execution_observation_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_observation_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_delete" AFTER DELETE ON "task_execution_observation_sources" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_execution_observation_sources',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_repos_e002384bcdaf_insert" AFTER INSERT ON "task_repos" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_repos',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_repos_e002384bcdaf_update" AFTER UPDATE ON "task_repos" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_repos',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_task_repos_e002384bcdaf_delete" AFTER DELETE ON "task_repos" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('task_repos',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_tasks_085154084c74_insert" AFTER INSERT ON "tasks" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('tasks',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_tasks_085154084c74_update" AFTER UPDATE ON "tasks" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('tasks',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_tasks_085154084c74_delete" AFTER DELETE ON "tasks" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('tasks',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_users_7dfb4cf67742_insert" AFTER INSERT ON "users" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('users',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_users_7dfb4cf67742_update" AFTER UPDATE ON "users" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('users',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "obs_src_users_7dfb4cf67742_delete" AFTER DELETE ON "users" BEGIN
INSERT INTO "observation_source_revisions" ("source_id","revision") VALUES ('users',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END;
