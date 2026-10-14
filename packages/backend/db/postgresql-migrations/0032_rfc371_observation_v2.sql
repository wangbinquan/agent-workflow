-- trigger: retire:observation_report_pages:retained:insert
DROP TRIGGER "observation_report_pages_retained_insert" ON "agent_workflow"."observation_report_pages";

-- trigger: retire:observation_report_pages:retained:update
DROP TRIGGER "observation_report_pages_retained_update" ON "agent_workflow"."observation_report_pages";

-- trigger: retire:observation_report_pages:retained:delete
DROP TRIGGER "observation_report_pages_retained_delete" ON "agent_workflow"."observation_report_pages";

-- trigger: retire:observation_report_rows:retained:insert
DROP TRIGGER "observation_report_rows_retained_insert" ON "agent_workflow"."observation_report_rows";

-- trigger: retire:observation_report_rows:retained:update
DROP TRIGGER "observation_report_rows_retained_update" ON "agent_workflow"."observation_report_rows";

-- trigger: retire:observation_report_rows:retained:delete
DROP TRIGGER "observation_report_rows_retained_delete" ON "agent_workflow"."observation_report_rows";

-- trigger: retire:observation_report_counts:retained:insert
DROP TRIGGER "observation_report_counts_retained_insert" ON "agent_workflow"."observation_report_counts";

-- trigger: retire:observation_report_counts:retained:update
DROP TRIGGER "observation_report_counts_retained_update" ON "agent_workflow"."observation_report_counts";

-- trigger: retire:observation_report_counts:retained:delete
DROP TRIGGER "observation_report_counts_retained_delete" ON "agent_workflow"."observation_report_counts";

-- trigger: retire:observation_report_receipts:retained:insert
DROP TRIGGER "observation_report_receipts_retained_insert" ON "agent_workflow"."observation_report_receipts";

-- trigger: retire:observation_report_receipts:retained:update
DROP TRIGGER "observation_report_receipts_retained_update" ON "agent_workflow"."observation_report_receipts";

-- trigger: retire:observation_report_receipts:retained:delete
DROP TRIGGER "observation_report_receipts_retained_delete" ON "agent_workflow"."observation_report_receipts";

-- trigger: retire:agents:observation-source:insert
DROP TRIGGER "obs_src_agents_8c70b25cbbbe_insert" ON "agent_workflow"."agents";

-- trigger: retire:agents:observation-source:update
DROP TRIGGER "obs_src_agents_8c70b25cbbbe_update" ON "agent_workflow"."agents";

-- trigger: retire:agents:observation-source:delete
DROP TRIGGER "obs_src_agents_8c70b25cbbbe_delete" ON "agent_workflow"."agents";

-- trigger: retire:intent_sessions:observation-source:insert
DROP TRIGGER "obs_src_intent_sessions_f4fc994cf568_insert" ON "agent_workflow"."intent_sessions";

-- trigger: retire:intent_sessions:observation-source:update
DROP TRIGGER "obs_src_intent_sessions_f4fc994cf568_update" ON "agent_workflow"."intent_sessions";

-- trigger: retire:intent_sessions:observation-source:delete
DROP TRIGGER "obs_src_intent_sessions_f4fc994cf568_delete" ON "agent_workflow"."intent_sessions";

-- trigger: retire:intent_turn_events:observation-source:insert
DROP TRIGGER "obs_src_intent_turn_events_9577a85373ce_insert" ON "agent_workflow"."intent_turn_events";

-- trigger: retire:intent_turn_events:observation-source:update
DROP TRIGGER "obs_src_intent_turn_events_9577a85373ce_update" ON "agent_workflow"."intent_turn_events";

-- trigger: retire:intent_turn_events:observation-source:delete
DROP TRIGGER "obs_src_intent_turn_events_9577a85373ce_delete" ON "agent_workflow"."intent_turn_events";

-- trigger: retire:intent_turns:observation-source:insert
DROP TRIGGER "obs_src_intent_turns_a0c059001e55_insert" ON "agent_workflow"."intent_turns";

-- trigger: retire:intent_turns:observation-source:update
DROP TRIGGER "obs_src_intent_turns_a0c059001e55_update" ON "agent_workflow"."intent_turns";

-- trigger: retire:intent_turns:observation-source:delete
DROP TRIGGER "obs_src_intent_turns_a0c059001e55_delete" ON "agent_workflow"."intent_turns";

-- trigger: retire:mcp_runtime_test_events:observation-source:insert
DROP TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_insert" ON "agent_workflow"."mcp_runtime_test_events";

-- trigger: retire:mcp_runtime_test_events:observation-source:update
DROP TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_update" ON "agent_workflow"."mcp_runtime_test_events";

-- trigger: retire:mcp_runtime_test_events:observation-source:delete
DROP TRIGGER "obs_src_mcp_runtime_test_events_3026f434cf19_delete" ON "agent_workflow"."mcp_runtime_test_events";

-- trigger: retire:mcp_runtime_test_sessions:observation-source:insert
DROP TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_insert" ON "agent_workflow"."mcp_runtime_test_sessions";

-- trigger: retire:mcp_runtime_test_sessions:observation-source:update
DROP TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_update" ON "agent_workflow"."mcp_runtime_test_sessions";

-- trigger: retire:mcp_runtime_test_sessions:observation-source:delete
DROP TRIGGER "obs_src_mcp_runtime_test_sessions_9f19ae79a165_delete" ON "agent_workflow"."mcp_runtime_test_sessions";

-- trigger: retire:mcp_runtime_test_turns:observation-source:insert
DROP TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_insert" ON "agent_workflow"."mcp_runtime_test_turns";

-- trigger: retire:mcp_runtime_test_turns:observation-source:update
DROP TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_update" ON "agent_workflow"."mcp_runtime_test_turns";

-- trigger: retire:mcp_runtime_test_turns:observation-source:delete
DROP TRIGGER "obs_src_mcp_runtime_test_turns_5facdc2dda15_delete" ON "agent_workflow"."mcp_runtime_test_turns";

-- trigger: retire:memory_distill_events:observation-source:insert
DROP TRIGGER "obs_src_memory_distill_events_9222b906089a_insert" ON "agent_workflow"."memory_distill_events";

-- trigger: retire:memory_distill_events:observation-source:update
DROP TRIGGER "obs_src_memory_distill_events_9222b906089a_update" ON "agent_workflow"."memory_distill_events";

-- trigger: retire:memory_distill_events:observation-source:delete
DROP TRIGGER "obs_src_memory_distill_events_9222b906089a_delete" ON "agent_workflow"."memory_distill_events";

-- trigger: retire:memory_distill_jobs:observation-source:insert
DROP TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_insert" ON "agent_workflow"."memory_distill_jobs";

-- trigger: retire:memory_distill_jobs:observation-source:update
DROP TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_update" ON "agent_workflow"."memory_distill_jobs";

-- trigger: retire:memory_distill_jobs:observation-source:delete
DROP TRIGGER "obs_src_memory_distill_jobs_7c1cff75edd4_delete" ON "agent_workflow"."memory_distill_jobs";

-- trigger: retire:node_run_events:observation-source:insert
DROP TRIGGER "obs_src_node_run_events_01109c2fd4cf_insert" ON "agent_workflow"."node_run_events";

-- trigger: retire:node_run_events:observation-source:update
DROP TRIGGER "obs_src_node_run_events_01109c2fd4cf_update" ON "agent_workflow"."node_run_events";

-- trigger: retire:node_run_events:observation-source:delete
DROP TRIGGER "obs_src_node_run_events_01109c2fd4cf_delete" ON "agent_workflow"."node_run_events";

-- trigger: retire:node_runs:observation-source:insert
DROP TRIGGER "obs_src_node_runs_d3d6de02630e_insert" ON "agent_workflow"."node_runs";

-- trigger: retire:node_runs:observation-source:update
DROP TRIGGER "obs_src_node_runs_d3d6de02630e_update" ON "agent_workflow"."node_runs";

-- trigger: retire:node_runs:observation-source:delete
DROP TRIGGER "obs_src_node_runs_d3d6de02630e_delete" ON "agent_workflow"."node_runs";

-- trigger: retire:observation_invocations:observation-source:insert
DROP TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_insert" ON "agent_workflow"."observation_invocations";

-- trigger: retire:observation_invocations:observation-source:update
DROP TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_update" ON "agent_workflow"."observation_invocations";

-- trigger: retire:observation_invocations:observation-source:delete
DROP TRIGGER "obs_src_observation_invocations_ddde8c4db0d6_delete" ON "agent_workflow"."observation_invocations";

-- trigger: retire:observation_platform_records:observation-source:insert
DROP TRIGGER "obs_src_observation_platform_records_b9c238a11799_insert" ON "agent_workflow"."observation_platform_records";

-- trigger: retire:observation_platform_records:observation-source:update
DROP TRIGGER "obs_src_observation_platform_records_b9c238a11799_update" ON "agent_workflow"."observation_platform_records";

-- trigger: retire:observation_platform_records:observation-source:delete
DROP TRIGGER "obs_src_observation_platform_records_b9c238a11799_delete" ON "agent_workflow"."observation_platform_records";

-- trigger: retire:observation_platform_sources:observation-source:insert
DROP TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_insert" ON "agent_workflow"."observation_platform_sources";

-- trigger: retire:observation_platform_sources:observation-source:update
DROP TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_update" ON "agent_workflow"."observation_platform_sources";

-- trigger: retire:observation_platform_sources:observation-source:delete
DROP TRIGGER "obs_src_observation_platform_sources_0d51a229caf9_delete" ON "agent_workflow"."observation_platform_sources";

-- trigger: retire:observation_price_heads:observation-source:insert
DROP TRIGGER "obs_src_observation_price_heads_e45105caf86d_insert" ON "agent_workflow"."observation_price_heads";

-- trigger: retire:observation_price_heads:observation-source:update
DROP TRIGGER "obs_src_observation_price_heads_e45105caf86d_update" ON "agent_workflow"."observation_price_heads";

-- trigger: retire:observation_price_heads:observation-source:delete
DROP TRIGGER "obs_src_observation_price_heads_e45105caf86d_delete" ON "agent_workflow"."observation_price_heads";

-- trigger: retire:observation_price_versions:observation-source:insert
DROP TRIGGER "obs_src_observation_price_versions_40e139831493_insert" ON "agent_workflow"."observation_price_versions";

-- trigger: retire:observation_price_versions:observation-source:update
DROP TRIGGER "obs_src_observation_price_versions_40e139831493_update" ON "agent_workflow"."observation_price_versions";

-- trigger: retire:observation_price_versions:observation-source:delete
DROP TRIGGER "obs_src_observation_price_versions_40e139831493_delete" ON "agent_workflow"."observation_price_versions";

-- trigger: retire:observation_usage_captures:observation-source:insert
DROP TRIGGER "obs_src_observation_usage_captures_69ed66269937_insert" ON "agent_workflow"."observation_usage_captures";

-- trigger: retire:observation_usage_captures:observation-source:update
DROP TRIGGER "obs_src_observation_usage_captures_69ed66269937_update" ON "agent_workflow"."observation_usage_captures";

-- trigger: retire:observation_usage_captures:observation-source:delete
DROP TRIGGER "obs_src_observation_usage_captures_69ed66269937_delete" ON "agent_workflow"."observation_usage_captures";

-- trigger: retire:observation_usage_current:observation-source:insert
DROP TRIGGER "obs_src_observation_usage_current_5c718590978a_insert" ON "agent_workflow"."observation_usage_current";

-- trigger: retire:observation_usage_current:observation-source:update
DROP TRIGGER "obs_src_observation_usage_current_5c718590978a_update" ON "agent_workflow"."observation_usage_current";

-- trigger: retire:observation_usage_current:observation-source:delete
DROP TRIGGER "obs_src_observation_usage_current_5c718590978a_delete" ON "agent_workflow"."observation_usage_current";

-- trigger: retire:observation_usage_events:observation-source:insert
DROP TRIGGER "obs_src_observation_usage_events_20955815b204_insert" ON "agent_workflow"."observation_usage_events";

-- trigger: retire:observation_usage_events:observation-source:update
DROP TRIGGER "obs_src_observation_usage_events_20955815b204_update" ON "agent_workflow"."observation_usage_events";

-- trigger: retire:observation_usage_events:observation-source:delete
DROP TRIGGER "obs_src_observation_usage_events_20955815b204_delete" ON "agent_workflow"."observation_usage_events";

-- trigger: retire:observation_usage_native_records:observation-source:insert
DROP TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_insert" ON "agent_workflow"."observation_usage_native_records";

-- trigger: retire:observation_usage_native_records:observation-source:update
DROP TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_update" ON "agent_workflow"."observation_usage_native_records";

-- trigger: retire:observation_usage_native_records:observation-source:delete
DROP TRIGGER "obs_src_observation_usage_native_rec_80ccf5536f6c_delete" ON "agent_workflow"."observation_usage_native_records";

-- trigger: retire:observation_usage_sources:observation-source:insert
DROP TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_insert" ON "agent_workflow"."observation_usage_sources";

-- trigger: retire:observation_usage_sources:observation-source:update
DROP TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_update" ON "agent_workflow"."observation_usage_sources";

-- trigger: retire:observation_usage_sources:observation-source:delete
DROP TRIGGER "obs_src_observation_usage_sources_b509b15c3b1b_delete" ON "agent_workflow"."observation_usage_sources";

-- trigger: retire:system_agent_native_usage_emissions:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_insert" ON "agent_workflow"."system_agent_native_usage_emissions";

-- trigger: retire:system_agent_native_usage_emissions:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_update" ON "agent_workflow"."system_agent_native_usage_emissions";

-- trigger: retire:system_agent_native_usage_emissions:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_em_364e7e46c5e0_delete" ON "agent_workflow"."system_agent_native_usage_emissions";

-- trigger: retire:system_agent_native_usage_pass_heads:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_insert" ON "agent_workflow"."system_agent_native_usage_pass_heads";

-- trigger: retire:system_agent_native_usage_pass_heads:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_update" ON "agent_workflow"."system_agent_native_usage_pass_heads";

-- trigger: retire:system_agent_native_usage_pass_heads:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_pa_ba37186c0936_delete" ON "agent_workflow"."system_agent_native_usage_pass_heads";

-- trigger: retire:system_agent_native_usage_pass_pages:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_insert" ON "agent_workflow"."system_agent_native_usage_pass_pages";

-- trigger: retire:system_agent_native_usage_pass_pages:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_update" ON "agent_workflow"."system_agent_native_usage_pass_pages";

-- trigger: retire:system_agent_native_usage_pass_pages:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_pa_771477690e2b_delete" ON "agent_workflow"."system_agent_native_usage_pass_pages";

-- trigger: retire:system_agent_native_usage_passes:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_insert" ON "agent_workflow"."system_agent_native_usage_passes";

-- trigger: retire:system_agent_native_usage_passes:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_update" ON "agent_workflow"."system_agent_native_usage_passes";

-- trigger: retire:system_agent_native_usage_passes:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_pa_6520d2339bb5_delete" ON "agent_workflow"."system_agent_native_usage_passes";

-- trigger: retire:system_agent_native_usage_preparations:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_insert" ON "agent_workflow"."system_agent_native_usage_preparations";

-- trigger: retire:system_agent_native_usage_preparations:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_update" ON "agent_workflow"."system_agent_native_usage_preparations";

-- trigger: retire:system_agent_native_usage_preparations:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_pr_ec4ab414cf07_delete" ON "agent_workflow"."system_agent_native_usage_preparations";

-- trigger: retire:system_agent_native_usage_revision_heads:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_insert" ON "agent_workflow"."system_agent_native_usage_revision_heads";

-- trigger: retire:system_agent_native_usage_revision_heads:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_update" ON "agent_workflow"."system_agent_native_usage_revision_heads";

-- trigger: retire:system_agent_native_usage_revision_heads:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_re_1baf88801307_delete" ON "agent_workflow"."system_agent_native_usage_revision_heads";

-- trigger: retire:system_agent_native_usage_root_heads:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_insert" ON "agent_workflow"."system_agent_native_usage_root_heads";

-- trigger: retire:system_agent_native_usage_root_heads:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_update" ON "agent_workflow"."system_agent_native_usage_root_heads";

-- trigger: retire:system_agent_native_usage_root_heads:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_ro_9ed202dd645c_delete" ON "agent_workflow"."system_agent_native_usage_root_heads";

-- trigger: retire:system_agent_native_usage_root_results:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_insert" ON "agent_workflow"."system_agent_native_usage_root_results";

-- trigger: retire:system_agent_native_usage_root_results:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_update" ON "agent_workflow"."system_agent_native_usage_root_results";

-- trigger: retire:system_agent_native_usage_root_results:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_ro_60f7ad4db013_delete" ON "agent_workflow"."system_agent_native_usage_root_results";

-- trigger: retire:system_agent_native_usage_root_sets:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_insert" ON "agent_workflow"."system_agent_native_usage_root_sets";

-- trigger: retire:system_agent_native_usage_root_sets:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_update" ON "agent_workflow"."system_agent_native_usage_root_sets";

-- trigger: retire:system_agent_native_usage_root_sets:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_ro_64e30e7a3e2c_delete" ON "agent_workflow"."system_agent_native_usage_root_sets";

-- trigger: retire:system_agent_native_usage_root_transitions:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_insert" ON "agent_workflow"."system_agent_native_usage_root_transitions";

-- trigger: retire:system_agent_native_usage_root_transitions:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_update" ON "agent_workflow"."system_agent_native_usage_root_transitions";

-- trigger: retire:system_agent_native_usage_root_transitions:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_ro_32f58d5077c1_delete" ON "agent_workflow"."system_agent_native_usage_root_transitions";

-- trigger: retire:system_agent_native_usage_session_parents:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_insert" ON "agent_workflow"."system_agent_native_usage_session_parents";

-- trigger: retire:system_agent_native_usage_session_parents:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_update" ON "agent_workflow"."system_agent_native_usage_session_parents";

-- trigger: retire:system_agent_native_usage_session_parents:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_se_71b41666d29a_delete" ON "agent_workflow"."system_agent_native_usage_session_parents";

-- trigger: retire:system_agent_native_usage_step_members:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_insert" ON "agent_workflow"."system_agent_native_usage_step_members";

-- trigger: retire:system_agent_native_usage_step_members:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_update" ON "agent_workflow"."system_agent_native_usage_step_members";

-- trigger: retire:system_agent_native_usage_step_members:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_st_7414b1fb4392_delete" ON "agent_workflow"."system_agent_native_usage_step_members";

-- trigger: retire:system_agent_native_usage_store_bindings:observation-source:insert
DROP TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_insert" ON "agent_workflow"."system_agent_native_usage_store_bindings";

-- trigger: retire:system_agent_native_usage_store_bindings:observation-source:update
DROP TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_update" ON "agent_workflow"."system_agent_native_usage_store_bindings";

-- trigger: retire:system_agent_native_usage_store_bindings:observation-source:delete
DROP TRIGGER "obs_src_system_agent_native_usage_st_d569eb209fc4_delete" ON "agent_workflow"."system_agent_native_usage_store_bindings";

-- trigger: retire:system_agent_observation_groups:observation-source:insert
DROP TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_insert" ON "agent_workflow"."system_agent_observation_groups";

-- trigger: retire:system_agent_observation_groups:observation-source:update
DROP TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_update" ON "agent_workflow"."system_agent_observation_groups";

-- trigger: retire:system_agent_observation_groups:observation-source:delete
DROP TRIGGER "obs_src_system_agent_observation_gro_f79391caed8d_delete" ON "agent_workflow"."system_agent_observation_groups";

-- trigger: retire:system_agent_observation_owners:observation-source:insert
DROP TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_insert" ON "agent_workflow"."system_agent_observation_owners";

-- trigger: retire:system_agent_observation_owners:observation-source:update
DROP TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_update" ON "agent_workflow"."system_agent_observation_owners";

-- trigger: retire:system_agent_observation_owners:observation-source:delete
DROP TRIGGER "obs_src_system_agent_observation_own_67b3c6637001_delete" ON "agent_workflow"."system_agent_observation_owners";

-- trigger: retire:system_agent_observation_sources:observation-source:insert
DROP TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_insert" ON "agent_workflow"."system_agent_observation_sources";

-- trigger: retire:system_agent_observation_sources:observation-source:update
DROP TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_update" ON "agent_workflow"."system_agent_observation_sources";

-- trigger: retire:system_agent_observation_sources:observation-source:delete
DROP TRIGGER "obs_src_system_agent_observation_sou_e2eb3c17fdf9_delete" ON "agent_workflow"."system_agent_observation_sources";

-- trigger: retire:task_collaborators:observation-source:insert
DROP TRIGGER "obs_src_task_collaborators_a2cc5248664c_insert" ON "agent_workflow"."task_collaborators";

-- trigger: retire:task_collaborators:observation-source:update
DROP TRIGGER "obs_src_task_collaborators_a2cc5248664c_update" ON "agent_workflow"."task_collaborators";

-- trigger: retire:task_collaborators:observation-source:delete
DROP TRIGGER "obs_src_task_collaborators_a2cc5248664c_delete" ON "agent_workflow"."task_collaborators";

-- trigger: retire:task_execution_native_usage_emissions:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_insert" ON "agent_workflow"."task_execution_native_usage_emissions";

-- trigger: retire:task_execution_native_usage_emissions:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_update" ON "agent_workflow"."task_execution_native_usage_emissions";

-- trigger: retire:task_execution_native_usage_emissions:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__c8b1327ae70a_delete" ON "agent_workflow"."task_execution_native_usage_emissions";

-- trigger: retire:task_execution_native_usage_pass_heads:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_insert" ON "agent_workflow"."task_execution_native_usage_pass_heads";

-- trigger: retire:task_execution_native_usage_pass_heads:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_update" ON "agent_workflow"."task_execution_native_usage_pass_heads";

-- trigger: retire:task_execution_native_usage_pass_heads:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__65f2373ec8b0_delete" ON "agent_workflow"."task_execution_native_usage_pass_heads";

-- trigger: retire:task_execution_native_usage_pass_pages:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_insert" ON "agent_workflow"."task_execution_native_usage_pass_pages";

-- trigger: retire:task_execution_native_usage_pass_pages:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_update" ON "agent_workflow"."task_execution_native_usage_pass_pages";

-- trigger: retire:task_execution_native_usage_pass_pages:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__a6a06b98c7fd_delete" ON "agent_workflow"."task_execution_native_usage_pass_pages";

-- trigger: retire:task_execution_native_usage_passes:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_insert" ON "agent_workflow"."task_execution_native_usage_passes";

-- trigger: retire:task_execution_native_usage_passes:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_update" ON "agent_workflow"."task_execution_native_usage_passes";

-- trigger: retire:task_execution_native_usage_passes:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__bdc22d8b4973_delete" ON "agent_workflow"."task_execution_native_usage_passes";

-- trigger: retire:task_execution_native_usage_preparations:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__4253a159b085_insert" ON "agent_workflow"."task_execution_native_usage_preparations";

-- trigger: retire:task_execution_native_usage_preparations:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__4253a159b085_update" ON "agent_workflow"."task_execution_native_usage_preparations";

-- trigger: retire:task_execution_native_usage_preparations:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__4253a159b085_delete" ON "agent_workflow"."task_execution_native_usage_preparations";

-- trigger: retire:task_execution_native_usage_revision_heads:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_insert" ON "agent_workflow"."task_execution_native_usage_revision_heads";

-- trigger: retire:task_execution_native_usage_revision_heads:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_update" ON "agent_workflow"."task_execution_native_usage_revision_heads";

-- trigger: retire:task_execution_native_usage_revision_heads:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__93d68d4e5e09_delete" ON "agent_workflow"."task_execution_native_usage_revision_heads";

-- trigger: retire:task_execution_native_usage_root_heads:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_insert" ON "agent_workflow"."task_execution_native_usage_root_heads";

-- trigger: retire:task_execution_native_usage_root_heads:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_update" ON "agent_workflow"."task_execution_native_usage_root_heads";

-- trigger: retire:task_execution_native_usage_root_heads:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__a5adc08382bc_delete" ON "agent_workflow"."task_execution_native_usage_root_heads";

-- trigger: retire:task_execution_native_usage_root_results:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_insert" ON "agent_workflow"."task_execution_native_usage_root_results";

-- trigger: retire:task_execution_native_usage_root_results:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_update" ON "agent_workflow"."task_execution_native_usage_root_results";

-- trigger: retire:task_execution_native_usage_root_results:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__d6f5b5fad9a7_delete" ON "agent_workflow"."task_execution_native_usage_root_results";

-- trigger: retire:task_execution_native_usage_root_sets:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_insert" ON "agent_workflow"."task_execution_native_usage_root_sets";

-- trigger: retire:task_execution_native_usage_root_sets:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_update" ON "agent_workflow"."task_execution_native_usage_root_sets";

-- trigger: retire:task_execution_native_usage_root_sets:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__84a2186b134d_delete" ON "agent_workflow"."task_execution_native_usage_root_sets";

-- trigger: retire:task_execution_native_usage_root_transitions:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_insert" ON "agent_workflow"."task_execution_native_usage_root_transitions";

-- trigger: retire:task_execution_native_usage_root_transitions:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_update" ON "agent_workflow"."task_execution_native_usage_root_transitions";

-- trigger: retire:task_execution_native_usage_root_transitions:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__e20c6c58809d_delete" ON "agent_workflow"."task_execution_native_usage_root_transitions";

-- trigger: retire:task_execution_native_usage_session_parents:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_insert" ON "agent_workflow"."task_execution_native_usage_session_parents";

-- trigger: retire:task_execution_native_usage_session_parents:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_update" ON "agent_workflow"."task_execution_native_usage_session_parents";

-- trigger: retire:task_execution_native_usage_session_parents:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__1503f7a42ca6_delete" ON "agent_workflow"."task_execution_native_usage_session_parents";

-- trigger: retire:task_execution_native_usage_step_members:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_insert" ON "agent_workflow"."task_execution_native_usage_step_members";

-- trigger: retire:task_execution_native_usage_step_members:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_update" ON "agent_workflow"."task_execution_native_usage_step_members";

-- trigger: retire:task_execution_native_usage_step_members:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__7d6b31fa31e2_delete" ON "agent_workflow"."task_execution_native_usage_step_members";

-- trigger: retire:task_execution_native_usage_store_bindings:observation-source:insert
DROP TRIGGER "obs_src_task_execution_native_usage__cac99809a707_insert" ON "agent_workflow"."task_execution_native_usage_store_bindings";

-- trigger: retire:task_execution_native_usage_store_bindings:observation-source:update
DROP TRIGGER "obs_src_task_execution_native_usage__cac99809a707_update" ON "agent_workflow"."task_execution_native_usage_store_bindings";

-- trigger: retire:task_execution_native_usage_store_bindings:observation-source:delete
DROP TRIGGER "obs_src_task_execution_native_usage__cac99809a707_delete" ON "agent_workflow"."task_execution_native_usage_store_bindings";

-- trigger: retire:task_execution_observation_sources:observation-source:insert
DROP TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_insert" ON "agent_workflow"."task_execution_observation_sources";

-- trigger: retire:task_execution_observation_sources:observation-source:update
DROP TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_update" ON "agent_workflow"."task_execution_observation_sources";

-- trigger: retire:task_execution_observation_sources:observation-source:delete
DROP TRIGGER "obs_src_task_execution_observation_s_47fab48faf75_delete" ON "agent_workflow"."task_execution_observation_sources";

-- trigger: retire:task_repos:observation-source:insert
DROP TRIGGER "obs_src_task_repos_e002384bcdaf_insert" ON "agent_workflow"."task_repos";

-- trigger: retire:task_repos:observation-source:update
DROP TRIGGER "obs_src_task_repos_e002384bcdaf_update" ON "agent_workflow"."task_repos";

-- trigger: retire:task_repos:observation-source:delete
DROP TRIGGER "obs_src_task_repos_e002384bcdaf_delete" ON "agent_workflow"."task_repos";

-- trigger: retire:tasks:observation-source:insert
DROP TRIGGER "obs_src_tasks_085154084c74_insert" ON "agent_workflow"."tasks";

-- trigger: retire:tasks:observation-source:update
DROP TRIGGER "obs_src_tasks_085154084c74_update" ON "agent_workflow"."tasks";

-- trigger: retire:tasks:observation-source:delete
DROP TRIGGER "obs_src_tasks_085154084c74_delete" ON "agent_workflow"."tasks";

-- trigger: retire:users:observation-source:insert
DROP TRIGGER "obs_src_users_7dfb4cf67742_insert" ON "agent_workflow"."users";

-- trigger: retire:users:observation-source:update
DROP TRIGGER "obs_src_users_7dfb4cf67742_update" ON "agent_workflow"."users";

-- trigger: retire:users:observation-source:delete
DROP TRIGGER "obs_src_users_7dfb4cf67742_delete" ON "agent_workflow"."users";

-- trigger: retire:agents:observation-change
DROP TRIGGER "obs_delta_agents_8c70b25cbbbe" ON "agent_workflow"."agents";

-- trigger: retire:intent_sessions:observation-change
DROP TRIGGER "obs_delta_intent_sessions_f4fc994cf568" ON "agent_workflow"."intent_sessions";

-- trigger: retire:intent_turn_events:observation-change
DROP TRIGGER "obs_delta_intent_turn_events_9577a85373ce" ON "agent_workflow"."intent_turn_events";

-- trigger: retire:intent_turns:observation-change
DROP TRIGGER "obs_delta_intent_turns_a0c059001e55" ON "agent_workflow"."intent_turns";

-- trigger: retire:mcp_runtime_test_events:observation-change
DROP TRIGGER "obs_delta_mcp_runtime_test_events_3026f434cf19" ON "agent_workflow"."mcp_runtime_test_events";

-- trigger: retire:mcp_runtime_test_sessions:observation-change
DROP TRIGGER "obs_delta_mcp_runtime_test_sessions_9f19ae79a165" ON "agent_workflow"."mcp_runtime_test_sessions";

-- trigger: retire:mcp_runtime_test_turns:observation-change
DROP TRIGGER "obs_delta_mcp_runtime_test_turns_5facdc2dda15" ON "agent_workflow"."mcp_runtime_test_turns";

-- trigger: retire:memory_distill_events:observation-change
DROP TRIGGER "obs_delta_memory_distill_events_9222b906089a" ON "agent_workflow"."memory_distill_events";

-- trigger: retire:memory_distill_jobs:observation-change
DROP TRIGGER "obs_delta_memory_distill_jobs_7c1cff75edd4" ON "agent_workflow"."memory_distill_jobs";

-- trigger: retire:node_run_events:observation-change
DROP TRIGGER "obs_delta_node_run_events_01109c2fd4cf" ON "agent_workflow"."node_run_events";

-- trigger: retire:node_runs:observation-change
DROP TRIGGER "obs_delta_node_runs_d3d6de02630e" ON "agent_workflow"."node_runs";

-- trigger: retire:observation_invocations:observation-change
DROP TRIGGER "obs_delta_observation_invocations_ddde8c4db0d6" ON "agent_workflow"."observation_invocations";

-- trigger: retire:observation_platform_records:observation-change
DROP TRIGGER "obs_delta_observation_platform_records_b9c238a11799" ON "agent_workflow"."observation_platform_records";

-- trigger: retire:observation_platform_sources:observation-change
DROP TRIGGER "obs_delta_observation_platform_sources_0d51a229caf9" ON "agent_workflow"."observation_platform_sources";

-- trigger: retire:observation_price_heads:observation-change
DROP TRIGGER "obs_delta_observation_price_heads_e45105caf86d" ON "agent_workflow"."observation_price_heads";

-- trigger: retire:observation_price_versions:observation-change
DROP TRIGGER "obs_delta_observation_price_versions_40e139831493" ON "agent_workflow"."observation_price_versions";

-- trigger: retire:observation_usage_captures:observation-change
DROP TRIGGER "obs_delta_observation_usage_captures_69ed66269937" ON "agent_workflow"."observation_usage_captures";

-- trigger: retire:observation_usage_current:observation-change
DROP TRIGGER "obs_delta_observation_usage_current_5c718590978a" ON "agent_workflow"."observation_usage_current";

-- trigger: retire:observation_usage_events:observation-change
DROP TRIGGER "obs_delta_observation_usage_events_20955815b204" ON "agent_workflow"."observation_usage_events";

-- trigger: retire:observation_usage_native_records:observation-change
DROP TRIGGER "obs_delta_observation_usage_native_rec_80ccf5536f6c" ON "agent_workflow"."observation_usage_native_records";

-- trigger: retire:observation_usage_sources:observation-change
DROP TRIGGER "obs_delta_observation_usage_sources_b509b15c3b1b" ON "agent_workflow"."observation_usage_sources";

-- trigger: retire:system_agent_native_usage_emissions:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_em_364e7e46c5e0" ON "agent_workflow"."system_agent_native_usage_emissions";

-- trigger: retire:system_agent_native_usage_pass_heads:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_pa_ba37186c0936" ON "agent_workflow"."system_agent_native_usage_pass_heads";

-- trigger: retire:system_agent_native_usage_pass_pages:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_pa_771477690e2b" ON "agent_workflow"."system_agent_native_usage_pass_pages";

-- trigger: retire:system_agent_native_usage_passes:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_pa_6520d2339bb5" ON "agent_workflow"."system_agent_native_usage_passes";

-- trigger: retire:system_agent_native_usage_preparations:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_pr_ec4ab414cf07" ON "agent_workflow"."system_agent_native_usage_preparations";

-- trigger: retire:system_agent_native_usage_revision_heads:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_re_1baf88801307" ON "agent_workflow"."system_agent_native_usage_revision_heads";

-- trigger: retire:system_agent_native_usage_root_heads:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_ro_9ed202dd645c" ON "agent_workflow"."system_agent_native_usage_root_heads";

-- trigger: retire:system_agent_native_usage_root_results:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_ro_60f7ad4db013" ON "agent_workflow"."system_agent_native_usage_root_results";

-- trigger: retire:system_agent_native_usage_root_sets:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_ro_64e30e7a3e2c" ON "agent_workflow"."system_agent_native_usage_root_sets";

-- trigger: retire:system_agent_native_usage_root_transitions:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_ro_32f58d5077c1" ON "agent_workflow"."system_agent_native_usage_root_transitions";

-- trigger: retire:system_agent_native_usage_session_parents:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_se_71b41666d29a" ON "agent_workflow"."system_agent_native_usage_session_parents";

-- trigger: retire:system_agent_native_usage_step_members:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_st_7414b1fb4392" ON "agent_workflow"."system_agent_native_usage_step_members";

-- trigger: retire:system_agent_native_usage_store_bindings:observation-change
DROP TRIGGER "obs_delta_system_agent_native_usage_st_d569eb209fc4" ON "agent_workflow"."system_agent_native_usage_store_bindings";

-- trigger: retire:system_agent_observation_groups:observation-change
DROP TRIGGER "obs_delta_system_agent_observation_gro_f79391caed8d" ON "agent_workflow"."system_agent_observation_groups";

-- trigger: retire:system_agent_observation_owners:observation-change
DROP TRIGGER "obs_delta_system_agent_observation_own_67b3c6637001" ON "agent_workflow"."system_agent_observation_owners";

-- trigger: retire:system_agent_observation_sources:observation-change
DROP TRIGGER "obs_delta_system_agent_observation_sou_e2eb3c17fdf9" ON "agent_workflow"."system_agent_observation_sources";

-- trigger: retire:task_collaborators:observation-change
DROP TRIGGER "obs_delta_task_collaborators_a2cc5248664c" ON "agent_workflow"."task_collaborators";

-- trigger: retire:task_execution_native_usage_emissions:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__c8b1327ae70a" ON "agent_workflow"."task_execution_native_usage_emissions";

-- trigger: retire:task_execution_native_usage_pass_heads:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__65f2373ec8b0" ON "agent_workflow"."task_execution_native_usage_pass_heads";

-- trigger: retire:task_execution_native_usage_pass_pages:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__a6a06b98c7fd" ON "agent_workflow"."task_execution_native_usage_pass_pages";

-- trigger: retire:task_execution_native_usage_passes:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__bdc22d8b4973" ON "agent_workflow"."task_execution_native_usage_passes";

-- trigger: retire:task_execution_native_usage_preparations:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__4253a159b085" ON "agent_workflow"."task_execution_native_usage_preparations";

-- trigger: retire:task_execution_native_usage_revision_heads:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__93d68d4e5e09" ON "agent_workflow"."task_execution_native_usage_revision_heads";

-- trigger: retire:task_execution_native_usage_root_heads:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__a5adc08382bc" ON "agent_workflow"."task_execution_native_usage_root_heads";

-- trigger: retire:task_execution_native_usage_root_results:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__d6f5b5fad9a7" ON "agent_workflow"."task_execution_native_usage_root_results";

-- trigger: retire:task_execution_native_usage_root_sets:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__84a2186b134d" ON "agent_workflow"."task_execution_native_usage_root_sets";

-- trigger: retire:task_execution_native_usage_root_transitions:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__e20c6c58809d" ON "agent_workflow"."task_execution_native_usage_root_transitions";

-- trigger: retire:task_execution_native_usage_session_parents:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__1503f7a42ca6" ON "agent_workflow"."task_execution_native_usage_session_parents";

-- trigger: retire:task_execution_native_usage_step_members:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__7d6b31fa31e2" ON "agent_workflow"."task_execution_native_usage_step_members";

-- trigger: retire:task_execution_native_usage_store_bindings:observation-change
DROP TRIGGER "obs_delta_task_execution_native_usage__cac99809a707" ON "agent_workflow"."task_execution_native_usage_store_bindings";

-- trigger: retire:task_execution_observation_sources:observation-change
DROP TRIGGER "obs_delta_task_execution_observation_s_47fab48faf75" ON "agent_workflow"."task_execution_observation_sources";

-- trigger: retire:task_repos:observation-change
DROP TRIGGER "obs_delta_task_repos_e002384bcdaf" ON "agent_workflow"."task_repos";

-- trigger: retire:tasks:observation-change
DROP TRIGGER "obs_delta_tasks_085154084c74" ON "agent_workflow"."tasks";

-- trigger: retire:users:observation-change
DROP TRIGGER "obs_delta_users_7dfb4cf67742" ON "agent_workflow"."users";

-- function: retire:observation_report_retained_revisions:insert
DROP FUNCTION "agent_workflow"."observation_report_retained_insert"();

-- function: retire:observation_report_retained_revisions:update
DROP FUNCTION "agent_workflow"."observation_report_retained_update"();

-- function: retire:observation_report_retained_revisions:delete
DROP FUNCTION "agent_workflow"."observation_report_retained_delete"();

-- function: retire:observation_source_revisions:agents:insert
DROP FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_insert"();

-- function: retire:observation_source_revisions:agents:update
DROP FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_update"();

-- function: retire:observation_source_revisions:agents:delete
DROP FUNCTION "agent_workflow"."obs_src_agents_8c70b25cbbbe_delete"();

-- function: retire:observation_source_revisions:intent_sessions:insert
DROP FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_insert"();

-- function: retire:observation_source_revisions:intent_sessions:update
DROP FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_update"();

-- function: retire:observation_source_revisions:intent_sessions:delete
DROP FUNCTION "agent_workflow"."obs_src_intent_sessions_f4fc994cf568_delete"();

-- function: retire:observation_source_revisions:intent_turn_events:insert
DROP FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_insert"();

-- function: retire:observation_source_revisions:intent_turn_events:update
DROP FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_update"();

-- function: retire:observation_source_revisions:intent_turn_events:delete
DROP FUNCTION "agent_workflow"."obs_src_intent_turn_events_9577a85373ce_delete"();

-- function: retire:observation_source_revisions:intent_turns:insert
DROP FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_insert"();

-- function: retire:observation_source_revisions:intent_turns:update
DROP FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_update"();

-- function: retire:observation_source_revisions:intent_turns:delete
DROP FUNCTION "agent_workflow"."obs_src_intent_turns_a0c059001e55_delete"();

-- function: retire:observation_source_revisions:mcp_runtime_test_events:insert
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_insert"();

-- function: retire:observation_source_revisions:mcp_runtime_test_events:update
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_update"();

-- function: retire:observation_source_revisions:mcp_runtime_test_events:delete
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_events_3026f434cf19_delete"();

-- function: retire:observation_source_revisions:mcp_runtime_test_sessions:insert
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_insert"();

-- function: retire:observation_source_revisions:mcp_runtime_test_sessions:update
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_update"();

-- function: retire:observation_source_revisions:mcp_runtime_test_sessions:delete
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_sessions_9f19ae79a165_delete"();

-- function: retire:observation_source_revisions:mcp_runtime_test_turns:insert
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_insert"();

-- function: retire:observation_source_revisions:mcp_runtime_test_turns:update
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_update"();

-- function: retire:observation_source_revisions:mcp_runtime_test_turns:delete
DROP FUNCTION "agent_workflow"."obs_src_mcp_runtime_test_turns_5facdc2dda15_delete"();

-- function: retire:observation_source_revisions:memory_distill_events:insert
DROP FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_insert"();

-- function: retire:observation_source_revisions:memory_distill_events:update
DROP FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_update"();

-- function: retire:observation_source_revisions:memory_distill_events:delete
DROP FUNCTION "agent_workflow"."obs_src_memory_distill_events_9222b906089a_delete"();

-- function: retire:observation_source_revisions:memory_distill_jobs:insert
DROP FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_insert"();

-- function: retire:observation_source_revisions:memory_distill_jobs:update
DROP FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_update"();

-- function: retire:observation_source_revisions:memory_distill_jobs:delete
DROP FUNCTION "agent_workflow"."obs_src_memory_distill_jobs_7c1cff75edd4_delete"();

-- function: retire:observation_source_revisions:node_run_events:insert
DROP FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_insert"();

-- function: retire:observation_source_revisions:node_run_events:update
DROP FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_update"();

-- function: retire:observation_source_revisions:node_run_events:delete
DROP FUNCTION "agent_workflow"."obs_src_node_run_events_01109c2fd4cf_delete"();

-- function: retire:observation_source_revisions:node_runs:insert
DROP FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_insert"();

-- function: retire:observation_source_revisions:node_runs:update
DROP FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_update"();

-- function: retire:observation_source_revisions:node_runs:delete
DROP FUNCTION "agent_workflow"."obs_src_node_runs_d3d6de02630e_delete"();

-- function: retire:observation_source_revisions:observation_invocations:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_insert"();

-- function: retire:observation_source_revisions:observation_invocations:update
DROP FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_update"();

-- function: retire:observation_source_revisions:observation_invocations:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_invocations_ddde8c4db0d6_delete"();

-- function: retire:observation_source_revisions:observation_platform_records:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_insert"();

-- function: retire:observation_source_revisions:observation_platform_records:update
DROP FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_update"();

-- function: retire:observation_source_revisions:observation_platform_records:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_platform_records_b9c238a11799_delete"();

-- function: retire:observation_source_revisions:observation_platform_sources:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_insert"();

-- function: retire:observation_source_revisions:observation_platform_sources:update
DROP FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_update"();

-- function: retire:observation_source_revisions:observation_platform_sources:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_platform_sources_0d51a229caf9_delete"();

-- function: retire:observation_source_revisions:observation_price_heads:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_insert"();

-- function: retire:observation_source_revisions:observation_price_heads:update
DROP FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_update"();

-- function: retire:observation_source_revisions:observation_price_heads:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_price_heads_e45105caf86d_delete"();

-- function: retire:observation_source_revisions:observation_price_versions:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_insert"();

-- function: retire:observation_source_revisions:observation_price_versions:update
DROP FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_update"();

-- function: retire:observation_source_revisions:observation_price_versions:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_price_versions_40e139831493_delete"();

-- function: retire:observation_source_revisions:observation_usage_captures:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_insert"();

-- function: retire:observation_source_revisions:observation_usage_captures:update
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_update"();

-- function: retire:observation_source_revisions:observation_usage_captures:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_captures_69ed66269937_delete"();

-- function: retire:observation_source_revisions:observation_usage_current:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_insert"();

-- function: retire:observation_source_revisions:observation_usage_current:update
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_update"();

-- function: retire:observation_source_revisions:observation_usage_current:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_current_5c718590978a_delete"();

-- function: retire:observation_source_revisions:observation_usage_events:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_insert"();

-- function: retire:observation_source_revisions:observation_usage_events:update
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_update"();

-- function: retire:observation_source_revisions:observation_usage_events:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_events_20955815b204_delete"();

-- function: retire:observation_source_revisions:observation_usage_native_records:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_insert"();

-- function: retire:observation_source_revisions:observation_usage_native_records:update
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_update"();

-- function: retire:observation_source_revisions:observation_usage_native_records:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_native_rec_80ccf5536f6c_delete"();

-- function: retire:observation_source_revisions:observation_usage_sources:insert
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_insert"();

-- function: retire:observation_source_revisions:observation_usage_sources:update
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_update"();

-- function: retire:observation_source_revisions:observation_usage_sources:delete
DROP FUNCTION "agent_workflow"."obs_src_observation_usage_sources_b509b15c3b1b_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_emissions:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_emissions:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_emissions:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_em_364e7e46c5e0_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_pass_heads:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_pass_heads:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_pass_heads:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_ba37186c0936_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_pass_pages:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_pass_pages:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_pass_pages:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_771477690e2b_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_passes:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_passes:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_passes:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pa_6520d2339bb5_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_preparations:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_preparations:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_preparations:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_pr_ec4ab414cf07_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_revision_heads:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_revision_heads:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_revision_heads:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_re_1baf88801307_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_heads:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_heads:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_heads:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_9ed202dd645c_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_results:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_results:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_results:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_60f7ad4db013_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_sets:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_sets:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_sets:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_64e30e7a3e2c_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_transitions:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_transitions:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_root_transitions:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_ro_32f58d5077c1_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_session_parents:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_session_parents:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_session_parents:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_se_71b41666d29a_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_step_members:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_step_members:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_step_members:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_7414b1fb4392_delete"();

-- function: retire:observation_source_revisions:system_agent_native_usage_store_bindings:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_insert"();

-- function: retire:observation_source_revisions:system_agent_native_usage_store_bindings:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_update"();

-- function: retire:observation_source_revisions:system_agent_native_usage_store_bindings:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_native_usage_st_d569eb209fc4_delete"();

-- function: retire:observation_source_revisions:system_agent_observation_groups:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_insert"();

-- function: retire:observation_source_revisions:system_agent_observation_groups:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_update"();

-- function: retire:observation_source_revisions:system_agent_observation_groups:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_gro_f79391caed8d_delete"();

-- function: retire:observation_source_revisions:system_agent_observation_owners:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_insert"();

-- function: retire:observation_source_revisions:system_agent_observation_owners:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_update"();

-- function: retire:observation_source_revisions:system_agent_observation_owners:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_own_67b3c6637001_delete"();

-- function: retire:observation_source_revisions:system_agent_observation_sources:insert
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_insert"();

-- function: retire:observation_source_revisions:system_agent_observation_sources:update
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_update"();

-- function: retire:observation_source_revisions:system_agent_observation_sources:delete
DROP FUNCTION "agent_workflow"."obs_src_system_agent_observation_sou_e2eb3c17fdf9_delete"();

-- function: retire:observation_source_revisions:task_collaborators:insert
DROP FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_insert"();

-- function: retire:observation_source_revisions:task_collaborators:update
DROP FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_update"();

-- function: retire:observation_source_revisions:task_collaborators:delete
DROP FUNCTION "agent_workflow"."obs_src_task_collaborators_a2cc5248664c_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_emissions:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_emissions:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_emissions:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__c8b1327ae70a_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_pass_heads:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_pass_heads:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_pass_heads:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__65f2373ec8b0_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_pass_pages:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_pass_pages:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_pass_pages:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a6a06b98c7fd_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_passes:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_passes:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_passes:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__bdc22d8b4973_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_preparations:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_preparations:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_preparations:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__4253a159b085_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_revision_heads:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_revision_heads:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_revision_heads:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__93d68d4e5e09_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_heads:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_heads:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_heads:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__a5adc08382bc_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_results:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_results:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_results:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__d6f5b5fad9a7_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_sets:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_sets:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_sets:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__84a2186b134d_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_transitions:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_transitions:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_root_transitions:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__e20c6c58809d_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_session_parents:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_session_parents:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_session_parents:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__1503f7a42ca6_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_step_members:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_step_members:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_step_members:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__7d6b31fa31e2_delete"();

-- function: retire:observation_source_revisions:task_execution_native_usage_store_bindings:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_insert"();

-- function: retire:observation_source_revisions:task_execution_native_usage_store_bindings:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_update"();

-- function: retire:observation_source_revisions:task_execution_native_usage_store_bindings:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_native_usage__cac99809a707_delete"();

-- function: retire:observation_source_revisions:task_execution_observation_sources:insert
DROP FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_insert"();

-- function: retire:observation_source_revisions:task_execution_observation_sources:update
DROP FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_update"();

-- function: retire:observation_source_revisions:task_execution_observation_sources:delete
DROP FUNCTION "agent_workflow"."obs_src_task_execution_observation_s_47fab48faf75_delete"();

-- function: retire:observation_source_revisions:task_repos:insert
DROP FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_insert"();

-- function: retire:observation_source_revisions:task_repos:update
DROP FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_update"();

-- function: retire:observation_source_revisions:task_repos:delete
DROP FUNCTION "agent_workflow"."obs_src_task_repos_e002384bcdaf_delete"();

-- function: retire:observation_source_revisions:tasks:insert
DROP FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_insert"();

-- function: retire:observation_source_revisions:tasks:update
DROP FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_update"();

-- function: retire:observation_source_revisions:tasks:delete
DROP FUNCTION "agent_workflow"."obs_src_tasks_085154084c74_delete"();

-- function: retire:observation_source_revisions:users:insert
DROP FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_insert"();

-- function: retire:observation_source_revisions:users:update
DROP FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_update"();

-- function: retire:observation_source_revisions:users:delete
DROP FUNCTION "agent_workflow"."obs_src_users_7dfb4cf67742_delete"();

-- function: retire:observation_projection_changes:agents
DROP FUNCTION "agent_workflow"."obs_delta_agents_8c70b25cbbbe"();

-- function: retire:observation_projection_changes:intent_sessions
DROP FUNCTION "agent_workflow"."obs_delta_intent_sessions_f4fc994cf568"();

-- function: retire:observation_projection_changes:intent_turn_events
DROP FUNCTION "agent_workflow"."obs_delta_intent_turn_events_9577a85373ce"();

-- function: retire:observation_projection_changes:intent_turns
DROP FUNCTION "agent_workflow"."obs_delta_intent_turns_a0c059001e55"();

-- function: retire:observation_projection_changes:mcp_runtime_test_events
DROP FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_events_3026f434cf19"();

-- function: retire:observation_projection_changes:mcp_runtime_test_sessions
DROP FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_sessions_9f19ae79a165"();

-- function: retire:observation_projection_changes:mcp_runtime_test_turns
DROP FUNCTION "agent_workflow"."obs_delta_mcp_runtime_test_turns_5facdc2dda15"();

-- function: retire:observation_projection_changes:memory_distill_events
DROP FUNCTION "agent_workflow"."obs_delta_memory_distill_events_9222b906089a"();

-- function: retire:observation_projection_changes:memory_distill_jobs
DROP FUNCTION "agent_workflow"."obs_delta_memory_distill_jobs_7c1cff75edd4"();

-- function: retire:observation_projection_changes:node_run_events
DROP FUNCTION "agent_workflow"."obs_delta_node_run_events_01109c2fd4cf"();

-- function: retire:observation_projection_changes:node_runs
DROP FUNCTION "agent_workflow"."obs_delta_node_runs_d3d6de02630e"();

-- function: retire:observation_projection_changes:observation_invocations
DROP FUNCTION "agent_workflow"."obs_delta_observation_invocations_ddde8c4db0d6"();

-- function: retire:observation_projection_changes:observation_platform_records
DROP FUNCTION "agent_workflow"."obs_delta_observation_platform_records_b9c238a11799"();

-- function: retire:observation_projection_changes:observation_platform_sources
DROP FUNCTION "agent_workflow"."obs_delta_observation_platform_sources_0d51a229caf9"();

-- function: retire:observation_projection_changes:observation_price_heads
DROP FUNCTION "agent_workflow"."obs_delta_observation_price_heads_e45105caf86d"();

-- function: retire:observation_projection_changes:observation_price_versions
DROP FUNCTION "agent_workflow"."obs_delta_observation_price_versions_40e139831493"();

-- function: retire:observation_projection_changes:observation_usage_captures
DROP FUNCTION "agent_workflow"."obs_delta_observation_usage_captures_69ed66269937"();

-- function: retire:observation_projection_changes:observation_usage_current
DROP FUNCTION "agent_workflow"."obs_delta_observation_usage_current_5c718590978a"();

-- function: retire:observation_projection_changes:observation_usage_events
DROP FUNCTION "agent_workflow"."obs_delta_observation_usage_events_20955815b204"();

-- function: retire:observation_projection_changes:observation_usage_native_records
DROP FUNCTION "agent_workflow"."obs_delta_observation_usage_native_rec_80ccf5536f6c"();

-- function: retire:observation_projection_changes:observation_usage_sources
DROP FUNCTION "agent_workflow"."obs_delta_observation_usage_sources_b509b15c3b1b"();

-- function: retire:observation_projection_changes:system_agent_native_usage_emissions
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_em_364e7e46c5e0"();

-- function: retire:observation_projection_changes:system_agent_native_usage_pass_heads
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_ba37186c0936"();

-- function: retire:observation_projection_changes:system_agent_native_usage_pass_pages
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_771477690e2b"();

-- function: retire:observation_projection_changes:system_agent_native_usage_passes
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pa_6520d2339bb5"();

-- function: retire:observation_projection_changes:system_agent_native_usage_preparations
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_pr_ec4ab414cf07"();

-- function: retire:observation_projection_changes:system_agent_native_usage_revision_heads
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_re_1baf88801307"();

-- function: retire:observation_projection_changes:system_agent_native_usage_root_heads
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_9ed202dd645c"();

-- function: retire:observation_projection_changes:system_agent_native_usage_root_results
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_60f7ad4db013"();

-- function: retire:observation_projection_changes:system_agent_native_usage_root_sets
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_64e30e7a3e2c"();

-- function: retire:observation_projection_changes:system_agent_native_usage_root_transitions
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_ro_32f58d5077c1"();

-- function: retire:observation_projection_changes:system_agent_native_usage_session_parents
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_se_71b41666d29a"();

-- function: retire:observation_projection_changes:system_agent_native_usage_step_members
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_st_7414b1fb4392"();

-- function: retire:observation_projection_changes:system_agent_native_usage_store_bindings
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_native_usage_st_d569eb209fc4"();

-- function: retire:observation_projection_changes:system_agent_observation_groups
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_observation_gro_f79391caed8d"();

-- function: retire:observation_projection_changes:system_agent_observation_owners
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_observation_own_67b3c6637001"();

-- function: retire:observation_projection_changes:system_agent_observation_sources
DROP FUNCTION "agent_workflow"."obs_delta_system_agent_observation_sou_e2eb3c17fdf9"();

-- function: retire:observation_projection_changes:task_collaborators
DROP FUNCTION "agent_workflow"."obs_delta_task_collaborators_a2cc5248664c"();

-- function: retire:observation_projection_changes:task_execution_native_usage_emissions
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__c8b1327ae70a"();

-- function: retire:observation_projection_changes:task_execution_native_usage_pass_heads
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__65f2373ec8b0"();

-- function: retire:observation_projection_changes:task_execution_native_usage_pass_pages
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__a6a06b98c7fd"();

-- function: retire:observation_projection_changes:task_execution_native_usage_passes
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__bdc22d8b4973"();

-- function: retire:observation_projection_changes:task_execution_native_usage_preparations
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__4253a159b085"();

-- function: retire:observation_projection_changes:task_execution_native_usage_revision_heads
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__93d68d4e5e09"();

-- function: retire:observation_projection_changes:task_execution_native_usage_root_heads
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__a5adc08382bc"();

-- function: retire:observation_projection_changes:task_execution_native_usage_root_results
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__d6f5b5fad9a7"();

-- function: retire:observation_projection_changes:task_execution_native_usage_root_sets
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__84a2186b134d"();

-- function: retire:observation_projection_changes:task_execution_native_usage_root_transitions
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__e20c6c58809d"();

-- function: retire:observation_projection_changes:task_execution_native_usage_session_parents
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__1503f7a42ca6"();

-- function: retire:observation_projection_changes:task_execution_native_usage_step_members
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__7d6b31fa31e2"();

-- function: retire:observation_projection_changes:task_execution_native_usage_store_bindings
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_native_usage__cac99809a707"();

-- function: retire:observation_projection_changes:task_execution_observation_sources
DROP FUNCTION "agent_workflow"."obs_delta_task_execution_observation_s_47fab48faf75"();

-- function: retire:observation_projection_changes:task_repos
DROP FUNCTION "agent_workflow"."obs_delta_task_repos_e002384bcdaf"();

-- function: retire:observation_projection_changes:tasks
DROP FUNCTION "agent_workflow"."obs_delta_tasks_085154084c74"();

-- function: retire:observation_projection_changes:users
DROP FUNCTION "agent_workflow"."obs_delta_users_7dfb4cf67742"();

-- constraint: retire:observation_calculation_rows:observation_calculation_rows_cache_key_observation_calculation_versions_cache_key_fk
ALTER TABLE "agent_workflow"."observation_calculation_rows" DROP CONSTRAINT "observation_calculation_rows_cache_key_observation_calculation_versions_cache_key_fk";

-- constraint: retire:observation_projection_prepared:observation_projection_prepared_work_id_observation_projection_work_id_fk
ALTER TABLE "agent_workflow"."observation_projection_prepared" DROP CONSTRAINT "observation_projection_prepared_work_id_observation_projection_work_id_fk";

-- constraint: retire:observation_projection_work_components:observation_projection_work_components_work_id_observation_projection_work_id_fk
ALTER TABLE "agent_workflow"."observation_projection_work_components" DROP CONSTRAINT "observation_projection_work_components_work_id_observation_projection_work_id_fk";

-- constraint: retire:observation_native_fact_pages:observation_native_fact_pages_cache_key_observation_native_fact_roots_cache_key_fk
ALTER TABLE "agent_workflow"."observation_native_fact_pages" DROP CONSTRAINT "observation_native_fact_pages_cache_key_observation_native_fact_roots_cache_key_fk";

-- constraint: retire:observation_report_counts:observation_report_counts_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_counts" DROP CONSTRAINT "observation_report_counts_report_id_observation_reports_id_fk";

-- constraint: retire:observation_report_pages:observation_report_pages_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_pages" DROP CONSTRAINT "observation_report_pages_report_id_observation_reports_id_fk";

-- constraint: retire:observation_report_receipts:observation_report_receipts_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_receipts" DROP CONSTRAINT "observation_report_receipts_report_id_observation_reports_id_fk";

-- constraint: retire:observation_report_retained_revisions:observation_report_retained_revisions_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_retained_revisions" DROP CONSTRAINT "observation_report_retained_revisions_report_id_observation_reports_id_fk";

-- constraint: retire:observation_report_rows:observation_report_rows_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_rows" DROP CONSTRAINT "observation_report_rows_report_id_observation_reports_id_fk";

-- constraint: retire:system_agent_native_usage_emissions:system_agent_native_usage_emissions_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_emissions" DROP CONSTRAINT "system_agent_native_usage_emissions_invocation_id_system_agent_native_usage_preparations_invocation_id_fk";

-- constraint: retire:system_agent_native_usage_pass_heads:system_agent_native_usage_pass_heads_pass_id_system_agent_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_pass_heads" DROP CONSTRAINT "system_agent_native_usage_pass_heads_pass_id_system_agent_native_usage_passes_pass_id_fk";

-- constraint: retire:system_agent_native_usage_pass_pages:system_agent_native_usage_pass_pages_pass_id_system_agent_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_pass_pages" DROP CONSTRAINT "system_agent_native_usage_pass_pages_pass_id_system_agent_native_usage_passes_pass_id_fk";

-- constraint: retire:system_agent_native_usage_passes:system_agent_native_usage_passes_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_passes" DROP CONSTRAINT "system_agent_native_usage_passes_invocation_id_system_agent_native_usage_preparations_invocation_id_fk";

-- constraint: retire:system_agent_native_usage_preparations:system_agent_native_usage_preparations_task_id_system_agent_observation_groups_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_preparations" DROP CONSTRAINT "system_agent_native_usage_preparations_task_id_system_agent_observation_groups_id_fk";

-- constraint: retire:system_agent_native_usage_revision_heads:system_agent_native_usage_revision_heads_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_revision_heads" DROP CONSTRAINT "system_agent_native_usage_revision_heads_invocation_id_system_agent_native_usage_preparations_invocation_id_fk";

-- constraint: retire:system_agent_native_usage_root_heads:system_agent_native_usage_root_heads_task_id_system_agent_observation_groups_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_root_heads" DROP CONSTRAINT "system_agent_native_usage_root_heads_task_id_system_agent_observation_groups_id_fk";

-- constraint: retire:system_agent_native_usage_root_results:system_agent_native_usage_root_results_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_root_results" DROP CONSTRAINT "system_agent_native_usage_root_results_invocation_id_system_agent_native_usage_preparations_invocation_id_fk";

-- constraint: retire:system_agent_native_usage_root_sets:system_agent_native_usage_root_sets_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_root_sets" DROP CONSTRAINT "system_agent_native_usage_root_sets_invocation_id_system_agent_native_usage_preparations_invocation_id_fk";

-- constraint: retire:system_agent_native_usage_root_transitions:system_agent_native_usage_root_transitions_invocation_id_system_agent_native_usage_root_heads_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_root_transitions" DROP CONSTRAINT "system_agent_native_usage_root_transitions_invocation_id_system_agent_native_usage_root_heads_invocation_id_fk";

-- constraint: retire:system_agent_native_usage_session_parents:system_agent_native_usage_session_parents_pass_id_system_agent_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_session_parents" DROP CONSTRAINT "system_agent_native_usage_session_parents_pass_id_system_agent_native_usage_passes_pass_id_fk";

-- constraint: retire:system_agent_native_usage_step_members:system_agent_native_usage_step_members_pass_id_system_agent_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_step_members" DROP CONSTRAINT "system_agent_native_usage_step_members_pass_id_system_agent_native_usage_passes_pass_id_fk";

-- constraint: retire:system_agent_native_usage_store_bindings:system_agent_native_usage_store_bindings_invocation_id_system_agent_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."system_agent_native_usage_store_bindings" DROP CONSTRAINT "system_agent_native_usage_store_bindings_invocation_id_system_agent_native_usage_preparations_invocation_id_fk";

-- constraint: retire:system_agent_observation_owners:system_agent_observation_owners_group_id_system_agent_observation_groups_id_fk
ALTER TABLE "agent_workflow"."system_agent_observation_owners" DROP CONSTRAINT "system_agent_observation_owners_group_id_system_agent_observation_groups_id_fk";

-- constraint: retire:system_agent_observation_sources:system_agent_observation_sources_task_id_system_agent_observation_groups_id_fk
ALTER TABLE "agent_workflow"."system_agent_observation_sources" DROP CONSTRAINT "system_agent_observation_sources_task_id_system_agent_observation_groups_id_fk";

-- constraint: retire:system_agent_observation_sources:system_agent_observation_sources_node_run_id_system_agent_observation_owners_id_fk
ALTER TABLE "agent_workflow"."system_agent_observation_sources" DROP CONSTRAINT "system_agent_observation_sources_node_run_id_system_agent_observation_owners_id_fk";

-- constraint: retire:task_execution_native_usage_emissions:task_execution_native_usage_emissions_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_emissions" DROP CONSTRAINT "task_execution_native_usage_emissions_invocation_id_task_execution_native_usage_preparations_invocation_id_fk";

-- constraint: retire:task_execution_native_usage_pass_heads:task_execution_native_usage_pass_heads_pass_id_task_execution_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_pass_heads" DROP CONSTRAINT "task_execution_native_usage_pass_heads_pass_id_task_execution_native_usage_passes_pass_id_fk";

-- constraint: retire:task_execution_native_usage_pass_pages:task_execution_native_usage_pass_pages_pass_id_task_execution_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_pass_pages" DROP CONSTRAINT "task_execution_native_usage_pass_pages_pass_id_task_execution_native_usage_passes_pass_id_fk";

-- constraint: retire:task_execution_native_usage_passes:task_execution_native_usage_passes_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_passes" DROP CONSTRAINT "task_execution_native_usage_passes_invocation_id_task_execution_native_usage_preparations_invocation_id_fk";

-- constraint: retire:task_execution_native_usage_preparations:task_execution_native_usage_preparations_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_preparations" DROP CONSTRAINT "task_execution_native_usage_preparations_task_id_tasks_id_fk";

-- constraint: retire:task_execution_native_usage_revision_heads:task_execution_native_usage_revision_heads_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_revision_heads" DROP CONSTRAINT "task_execution_native_usage_revision_heads_invocation_id_task_execution_native_usage_preparations_invocation_id_fk";

-- constraint: retire:task_execution_native_usage_root_heads:task_execution_native_usage_root_heads_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_root_heads" DROP CONSTRAINT "task_execution_native_usage_root_heads_task_id_tasks_id_fk";

-- constraint: retire:task_execution_native_usage_root_results:task_execution_native_usage_root_results_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_root_results" DROP CONSTRAINT "task_execution_native_usage_root_results_invocation_id_task_execution_native_usage_preparations_invocation_id_fk";

-- constraint: retire:task_execution_native_usage_root_sets:task_execution_native_usage_root_sets_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_root_sets" DROP CONSTRAINT "task_execution_native_usage_root_sets_invocation_id_task_execution_native_usage_preparations_invocation_id_fk";

-- constraint: retire:task_execution_native_usage_root_transitions:task_execution_native_usage_root_transitions_invocation_id_task_execution_native_usage_root_heads_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_root_transitions" DROP CONSTRAINT "task_execution_native_usage_root_transitions_invocation_id_task_execution_native_usage_root_heads_invocation_id_fk";

-- constraint: retire:task_execution_native_usage_session_parents:task_execution_native_usage_session_parents_pass_id_task_execution_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_session_parents" DROP CONSTRAINT "task_execution_native_usage_session_parents_pass_id_task_execution_native_usage_passes_pass_id_fk";

-- constraint: retire:task_execution_native_usage_step_members:task_execution_native_usage_step_members_pass_id_task_execution_native_usage_passes_pass_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_step_members" DROP CONSTRAINT "task_execution_native_usage_step_members_pass_id_task_execution_native_usage_passes_pass_id_fk";

-- constraint: retire:task_execution_native_usage_store_bindings:task_execution_native_usage_store_bindings_invocation_id_task_execution_native_usage_preparations_invocation_id_fk
ALTER TABLE "agent_workflow"."task_execution_native_usage_store_bindings" DROP CONSTRAINT "task_execution_native_usage_store_bindings_invocation_id_task_execution_native_usage_preparations_invocation_id_fk";

-- constraint: retire:task_execution_observation_sources:task_execution_observation_sources_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_execution_observation_sources" DROP CONSTRAINT "task_execution_observation_sources_task_id_tasks_id_fk";

-- constraint: retire:task_execution_observation_sources:task_execution_observation_sources_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."task_execution_observation_sources" DROP CONSTRAINT "task_execution_observation_sources_node_run_id_node_runs_id_fk";

-- table: retire:observation_calculation_rows
DROP TABLE "agent_workflow"."observation_calculation_rows";

-- table: retire:observation_calculation_versions
DROP TABLE "agent_workflow"."observation_calculation_versions";

-- table: retire:observation_anomaly_history
DROP TABLE "agent_workflow"."observation_anomaly_history";

-- table: retire:observation_anomaly_states
DROP TABLE "agent_workflow"."observation_anomaly_states";

-- table: retire:observation_invocation_price_audit
DROP TABLE "agent_workflow"."observation_invocation_price_audit";

-- table: retire:observation_invocation_price_policies
DROP TABLE "agent_workflow"."observation_invocation_price_policies";

-- table: retire:observation_invocation_price_records
DROP TABLE "agent_workflow"."observation_invocation_price_records";

-- table: retire:observation_maintenance_members
DROP TABLE "agent_workflow"."observation_maintenance_members";

-- table: retire:observation_maintenance_operations
DROP TABLE "agent_workflow"."observation_maintenance_operations";

-- table: retire:observation_projection_descriptors
DROP TABLE "agent_workflow"."observation_projection_descriptors";

-- table: retire:observation_projection_indexed_versions
DROP TABLE "agent_workflow"."observation_projection_indexed_versions";

-- table: retire:observation_projection_query_scope_members
DROP TABLE "agent_workflow"."observation_projection_query_scope_members";

-- table: retire:observation_projection_query_scopes
DROP TABLE "agent_workflow"."observation_projection_query_scopes";

-- table: retire:observation_invocations
DROP TABLE "agent_workflow"."observation_invocations";

-- table: retire:observation_platform_records
DROP TABLE "agent_workflow"."observation_platform_records";

-- table: retire:observation_platform_sources
DROP TABLE "agent_workflow"."observation_platform_sources";

-- table: retire:observation_price_heads
DROP TABLE "agent_workflow"."observation_price_heads";

-- table: retire:observation_price_versions
DROP TABLE "agent_workflow"."observation_price_versions";

-- table: retire:observation_projection_bindings
DROP TABLE "agent_workflow"."observation_projection_bindings";

-- table: retire:observation_projection_bootstrap
DROP TABLE "agent_workflow"."observation_projection_bootstrap";

-- table: retire:observation_projection_changes
DROP TABLE "agent_workflow"."observation_projection_changes";

-- table: retire:observation_projection_components
DROP TABLE "agent_workflow"."observation_projection_components";

-- table: retire:observation_projection_current
DROP TABLE "agent_workflow"."observation_projection_current";

-- table: retire:observation_projection_dependencies
DROP TABLE "agent_workflow"."observation_projection_dependencies";

-- table: retire:observation_projection_heads
DROP TABLE "agent_workflow"."observation_projection_heads";

-- table: retire:observation_projection_history
DROP TABLE "agent_workflow"."observation_projection_history";

-- table: retire:observation_projection_memberships
DROP TABLE "agent_workflow"."observation_projection_memberships";

-- table: retire:observation_projection_prepared
DROP TABLE "agent_workflow"."observation_projection_prepared";

-- table: retire:observation_projection_versions
DROP TABLE "agent_workflow"."observation_projection_versions";

-- table: retire:observation_projection_views
DROP TABLE "agent_workflow"."observation_projection_views";

-- table: retire:observation_projection_work
DROP TABLE "agent_workflow"."observation_projection_work";

-- table: retire:observation_projection_work_components
DROP TABLE "agent_workflow"."observation_projection_work_components";

-- table: retire:observation_native_fact_pages
DROP TABLE "agent_workflow"."observation_native_fact_pages";

-- table: retire:observation_native_fact_roots
DROP TABLE "agent_workflow"."observation_native_fact_roots";

-- table: retire:observation_report_counts
DROP TABLE "agent_workflow"."observation_report_counts";

-- table: retire:observation_report_pages
DROP TABLE "agent_workflow"."observation_report_pages";

-- table: retire:observation_report_receipts
DROP TABLE "agent_workflow"."observation_report_receipts";

-- table: retire:observation_report_retained_revisions
DROP TABLE "agent_workflow"."observation_report_retained_revisions";

-- table: retire:observation_report_rows
DROP TABLE "agent_workflow"."observation_report_rows";

-- table: retire:observation_reports
DROP TABLE "agent_workflow"."observation_reports";

-- table: retire:observation_report_leases
DROP TABLE "agent_workflow"."observation_report_leases";

-- table: retire:observation_scope_refs
DROP TABLE "agent_workflow"."observation_scope_refs";

-- table: retire:observation_storage_samples
DROP TABLE "agent_workflow"."observation_storage_samples";

-- table: retire:observation_storage_state
DROP TABLE "agent_workflow"."observation_storage_state";

-- table: retire:observation_work_retention
DROP TABLE "agent_workflow"."observation_work_retention";

-- table: retire:observation_source_revisions
DROP TABLE "agent_workflow"."observation_source_revisions";

-- table: retire:observation_usage_sources
DROP TABLE "agent_workflow"."observation_usage_sources";

-- table: retire:observation_usage_captures
DROP TABLE "agent_workflow"."observation_usage_captures";

-- table: retire:observation_usage_native_records
DROP TABLE "agent_workflow"."observation_usage_native_records";

-- table: retire:observation_usage_current
DROP TABLE "agent_workflow"."observation_usage_current";

-- table: retire:observation_usage_events
DROP TABLE "agent_workflow"."observation_usage_events";

-- table: retire:system_agent_native_usage_emissions
DROP TABLE "agent_workflow"."system_agent_native_usage_emissions";

-- table: retire:system_agent_native_usage_pass_heads
DROP TABLE "agent_workflow"."system_agent_native_usage_pass_heads";

-- table: retire:system_agent_native_usage_pass_pages
DROP TABLE "agent_workflow"."system_agent_native_usage_pass_pages";

-- table: retire:system_agent_native_usage_passes
DROP TABLE "agent_workflow"."system_agent_native_usage_passes";

-- table: retire:system_agent_native_usage_preparations
DROP TABLE "agent_workflow"."system_agent_native_usage_preparations";

-- table: retire:system_agent_native_usage_revision_heads
DROP TABLE "agent_workflow"."system_agent_native_usage_revision_heads";

-- table: retire:system_agent_native_usage_root_heads
DROP TABLE "agent_workflow"."system_agent_native_usage_root_heads";

-- table: retire:system_agent_native_usage_root_results
DROP TABLE "agent_workflow"."system_agent_native_usage_root_results";

-- table: retire:system_agent_native_usage_root_sets
DROP TABLE "agent_workflow"."system_agent_native_usage_root_sets";

-- table: retire:system_agent_native_usage_root_transitions
DROP TABLE "agent_workflow"."system_agent_native_usage_root_transitions";

-- table: retire:system_agent_native_usage_session_parents
DROP TABLE "agent_workflow"."system_agent_native_usage_session_parents";

-- table: retire:system_agent_native_usage_step_members
DROP TABLE "agent_workflow"."system_agent_native_usage_step_members";

-- table: retire:system_agent_native_usage_store_bindings
DROP TABLE "agent_workflow"."system_agent_native_usage_store_bindings";

-- table: retire:system_agent_observation_groups
DROP TABLE "agent_workflow"."system_agent_observation_groups";

-- table: retire:system_agent_observation_owners
DROP TABLE "agent_workflow"."system_agent_observation_owners";

-- table: retire:system_agent_observation_sources
DROP TABLE "agent_workflow"."system_agent_observation_sources";

-- table: retire:task_execution_native_usage_emissions
DROP TABLE "agent_workflow"."task_execution_native_usage_emissions";

-- table: retire:task_execution_native_usage_pass_heads
DROP TABLE "agent_workflow"."task_execution_native_usage_pass_heads";

-- table: retire:task_execution_native_usage_pass_pages
DROP TABLE "agent_workflow"."task_execution_native_usage_pass_pages";

-- table: retire:task_execution_native_usage_passes
DROP TABLE "agent_workflow"."task_execution_native_usage_passes";

-- table: retire:task_execution_native_usage_preparations
DROP TABLE "agent_workflow"."task_execution_native_usage_preparations";

-- table: retire:task_execution_native_usage_revision_heads
DROP TABLE "agent_workflow"."task_execution_native_usage_revision_heads";

-- table: retire:task_execution_native_usage_root_heads
DROP TABLE "agent_workflow"."task_execution_native_usage_root_heads";

-- table: retire:task_execution_native_usage_root_results
DROP TABLE "agent_workflow"."task_execution_native_usage_root_results";

-- table: retire:task_execution_native_usage_root_sets
DROP TABLE "agent_workflow"."task_execution_native_usage_root_sets";

-- table: retire:task_execution_native_usage_root_transitions
DROP TABLE "agent_workflow"."task_execution_native_usage_root_transitions";

-- table: retire:task_execution_native_usage_session_parents
DROP TABLE "agent_workflow"."task_execution_native_usage_session_parents";

-- table: retire:task_execution_native_usage_step_members
DROP TABLE "agent_workflow"."task_execution_native_usage_step_members";

-- table: retire:task_execution_native_usage_store_bindings
DROP TABLE "agent_workflow"."task_execution_native_usage_store_bindings";

-- table: retire:task_execution_observation_sources
DROP TABLE "agent_workflow"."task_execution_observation_sources";

-- table: observation_call_models
CREATE TABLE "agent_workflow"."observation_call_models" (
  "call_id" TEXT COLLATE "C" NOT NULL,
  "model" TEXT COLLATE "C" NOT NULL,
  "input_tokens" BIGINT NOT NULL DEFAULT 0,
  "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
  "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
  "output_tokens" BIGINT NOT NULL DEFAULT 0,
  "reasoning_tokens" BIGINT NOT NULL DEFAULT 0,
  "price_id" TEXT COLLATE "C",
  "cost_nano" BIGINT,
  "cost_state" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_call_models_pkey" PRIMARY KEY ("call_id", "model")
);

-- table: observation_calls
CREATE TABLE "agent_workflow"."observation_calls" (
  "id" TEXT COLLATE "C" NOT NULL,
  "purpose" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C",
  "node_run_id" TEXT COLLATE "C",
  "system_kind" TEXT COLLATE "C",
  "system_label" TEXT COLLATE "C",
  "owner_user_id" TEXT COLLATE "C",
  "agent_id" TEXT COLLATE "C",
  "agent_name" TEXT COLLATE "C" NOT NULL,
  "runtime_id" TEXT COLLATE "C",
  "runtime_name" TEXT COLLATE "C",
  "protocol" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL,
  "started_at" BIGINT NOT NULL,
  "ended_at" BIGINT,
  "usage_state" TEXT COLLATE "C" NOT NULL,
  "input_tokens" BIGINT NOT NULL DEFAULT 0,
  "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
  "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
  "output_tokens" BIGINT NOT NULL DEFAULT 0,
  "reasoning_tokens" BIGINT NOT NULL DEFAULT 0,
  "cost_nano" BIGINT NOT NULL DEFAULT 0,
  "cost_state" TEXT COLLATE "C" NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "observation_calls_pkey" PRIMARY KEY ("id")
);

-- table: observation_prices
CREATE TABLE "agent_workflow"."observation_prices" (
  "id" TEXT COLLATE "C" NOT NULL,
  "runtime_id" TEXT COLLATE "C" NOT NULL,
  "model" TEXT COLLATE "C" NOT NULL,
  "input_micro" BIGINT,
  "cache_read_micro" BIGINT,
  "cache_write_micro" BIGINT,
  "output_micro" BIGINT,
  "effective_from" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "created_by" TEXT COLLATE "C" NOT NULL,
  "note" TEXT COLLATE "C" NOT NULL DEFAULT '',
  CONSTRAINT "observation_prices_pkey" PRIMARY KEY ("id")
);

-- index: observation_calls:index:observation_calls_started_idx
CREATE INDEX "observation_calls_started_idx" ON "agent_workflow"."observation_calls" ("started_at");

-- index: observation_calls:index:observation_calls_task_idx
CREATE INDEX "observation_calls_task_idx" ON "agent_workflow"."observation_calls" ("task_id", "started_at");

-- index: observation_calls:index:observation_calls_status_idx
CREATE INDEX "observation_calls_status_idx" ON "agent_workflow"."observation_calls" ("status");

-- index: observation_prices:index:observation_prices_line_idx
CREATE INDEX "observation_prices_line_idx" ON "agent_workflow"."observation_prices" ("runtime_id", "model", "created_at");

-- constraint: observation_call_models:check:observation_call_models_cost_state_ck
ALTER TABLE "agent_workflow"."observation_call_models" ADD CONSTRAINT "observation_call_models_cost_state_ck" CHECK ("cost_state" IN ('none','priced','partial','unpriced'));

-- constraint: observation_call_models:fk:observation_call_models_call_id_observation_calls_id_fk
ALTER TABLE "agent_workflow"."observation_call_models" ADD CONSTRAINT "observation_call_models_call_id_observation_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "agent_workflow"."observation_calls" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: observation_calls:check:observation_calls_purpose_ck
ALTER TABLE "agent_workflow"."observation_calls" ADD CONSTRAINT "observation_calls_purpose_ck" CHECK ("purpose" IN ('task','system'));

-- constraint: observation_calls:check:observation_calls_status_ck
ALTER TABLE "agent_workflow"."observation_calls" ADD CONSTRAINT "observation_calls_status_ck" CHECK ("status" IN ('running','done','failed','canceled','interrupted'));

-- constraint: observation_calls:check:observation_calls_usage_state_ck
ALTER TABLE "agent_workflow"."observation_calls" ADD CONSTRAINT "observation_calls_usage_state_ck" CHECK ("usage_state" IN ('pending','partial','complete','none'));

-- constraint: observation_calls:check:observation_calls_cost_state_ck
ALTER TABLE "agent_workflow"."observation_calls" ADD CONSTRAINT "observation_calls_cost_state_ck" CHECK ("cost_state" IN ('none','priced','partial','unpriced'));

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:32c305d87968bc9cd4bf179e3f94d5cee2a92a8dc3cfa5fbfbce93f2336da22b', active_table_count = 191, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:2cb9da99ba7e74d9863bc0c3733a7075ee228ff78d6205ae83e00785d3bbd5c9' RETURNING contract_digest;
