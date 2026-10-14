-- RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md §7):
-- retire the v1 observation schema (change-capture triggers on surviving tables,
-- then 81 tables, children before parents) and create the three v2 tables.
DROP TRIGGER IF EXISTS `obs_delta_agents_8c70b25cbbbe_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_agents_8c70b25cbbbe_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_agents_8c70b25cbbbe_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_sessions_f4fc994cf568_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_sessions_f4fc994cf568_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_sessions_f4fc994cf568_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_turn_events_9577a85373ce_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_turn_events_9577a85373ce_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_turn_events_9577a85373ce_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_turns_a0c059001e55_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_turns_a0c059001e55_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_intent_turns_a0c059001e55_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_events_3026f434cf19_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_events_3026f434cf19_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_events_3026f434cf19_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_sessions_9f19ae79a165_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_sessions_9f19ae79a165_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_sessions_9f19ae79a165_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_turns_5facdc2dda15_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_turns_5facdc2dda15_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_mcp_runtime_test_turns_5facdc2dda15_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_memory_distill_events_9222b906089a_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_memory_distill_events_9222b906089a_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_memory_distill_events_9222b906089a_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_memory_distill_jobs_7c1cff75edd4_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_memory_distill_jobs_7c1cff75edd4_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_memory_distill_jobs_7c1cff75edd4_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_node_run_events_01109c2fd4cf_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_node_run_events_01109c2fd4cf_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_node_run_events_01109c2fd4cf_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_node_runs_d3d6de02630e_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_node_runs_d3d6de02630e_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_node_runs_d3d6de02630e_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_task_collaborators_a2cc5248664c_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_task_collaborators_a2cc5248664c_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_task_collaborators_a2cc5248664c_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_task_repos_e002384bcdaf_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_task_repos_e002384bcdaf_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_task_repos_e002384bcdaf_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_tasks_085154084c74_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_tasks_085154084c74_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_tasks_085154084c74_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_users_7dfb4cf67742_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_users_7dfb4cf67742_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_delta_users_7dfb4cf67742_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_agents_8c70b25cbbbe_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_agents_8c70b25cbbbe_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_agents_8c70b25cbbbe_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_sessions_f4fc994cf568_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_sessions_f4fc994cf568_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_sessions_f4fc994cf568_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_turn_events_9577a85373ce_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_turn_events_9577a85373ce_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_turn_events_9577a85373ce_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_turns_a0c059001e55_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_turns_a0c059001e55_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_intent_turns_a0c059001e55_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_events_3026f434cf19_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_events_3026f434cf19_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_events_3026f434cf19_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_sessions_9f19ae79a165_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_sessions_9f19ae79a165_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_sessions_9f19ae79a165_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_turns_5facdc2dda15_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_turns_5facdc2dda15_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_mcp_runtime_test_turns_5facdc2dda15_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_memory_distill_events_9222b906089a_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_memory_distill_events_9222b906089a_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_memory_distill_events_9222b906089a_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_memory_distill_jobs_7c1cff75edd4_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_memory_distill_jobs_7c1cff75edd4_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_memory_distill_jobs_7c1cff75edd4_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_node_run_events_01109c2fd4cf_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_node_run_events_01109c2fd4cf_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_node_run_events_01109c2fd4cf_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_node_runs_d3d6de02630e_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_node_runs_d3d6de02630e_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_node_runs_d3d6de02630e_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_task_collaborators_a2cc5248664c_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_task_collaborators_a2cc5248664c_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_task_collaborators_a2cc5248664c_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_task_repos_e002384bcdaf_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_task_repos_e002384bcdaf_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_task_repos_e002384bcdaf_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_tasks_085154084c74_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_tasks_085154084c74_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_tasks_085154084c74_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_users_7dfb4cf67742_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_users_7dfb4cf67742_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `obs_src_users_7dfb4cf67742_update`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_anomaly_history`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_anomaly_states`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_calculation_rows`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_calculation_versions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_invocation_price_audit`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_invocation_price_policies`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_invocation_price_records`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_invocations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_maintenance_members`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_maintenance_operations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_native_fact_pages`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_native_fact_roots`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_platform_records`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_platform_sources`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_price_heads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_price_versions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_bindings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_bootstrap`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_changes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_components`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_current`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_dependencies`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_descriptors`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_heads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_history`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_indexed_versions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_memberships`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_prepared`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_query_scope_members`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_query_scopes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_versions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_views`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_work_components`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_projection_work`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_report_counts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_report_leases`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_report_pages`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_report_receipts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_report_retained_revisions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_report_rows`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_reports`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_scope_refs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_source_revisions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_storage_samples`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_storage_state`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_usage_captures`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_usage_current`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_usage_events`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_usage_native_records`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_usage_sources`;
--> statement-breakpoint
DROP TABLE IF EXISTS `observation_work_retention`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_emissions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_pass_heads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_pass_pages`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_session_parents`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_step_members`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_passes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_revision_heads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_root_results`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_root_sets`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_store_bindings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_preparations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_root_transitions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_native_usage_root_heads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_observation_sources`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_observation_owners`;
--> statement-breakpoint
DROP TABLE IF EXISTS `system_agent_observation_groups`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_emissions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_pass_heads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_pass_pages`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_session_parents`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_step_members`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_passes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_revision_heads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_root_results`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_root_sets`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_store_bindings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_preparations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_root_transitions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_native_usage_root_heads`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_execution_observation_sources`;
--> statement-breakpoint
CREATE TABLE `observation_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`task_id` text,
	`node_run_id` text,
	`system_kind` text,
	`system_label` text,
	`owner_user_id` text,
	`agent_id` text,
	`agent_name` text NOT NULL,
	`runtime_id` text,
	`runtime_name` text,
	`protocol` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`usage_state` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_nano` integer DEFAULT 0 NOT NULL,
	`cost_state` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "observation_calls_purpose_ck" CHECK("observation_calls"."purpose" IN ('task','system')),
	CONSTRAINT "observation_calls_status_ck" CHECK("observation_calls"."status" IN ('running','done','failed','canceled','interrupted')),
	CONSTRAINT "observation_calls_usage_state_ck" CHECK("observation_calls"."usage_state" IN ('pending','partial','complete','none')),
	CONSTRAINT "observation_calls_cost_state_ck" CHECK("observation_calls"."cost_state" IN ('none','priced','partial','unpriced'))
);
--> statement-breakpoint
CREATE INDEX `observation_calls_started_idx` ON `observation_calls` (`started_at`);
--> statement-breakpoint
CREATE INDEX `observation_calls_task_idx` ON `observation_calls` (`task_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `observation_calls_status_idx` ON `observation_calls` (`status`);
--> statement-breakpoint
CREATE TABLE `observation_call_models` (
	`call_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`price_id` text,
	`cost_nano` integer,
	`cost_state` text NOT NULL,
	PRIMARY KEY(`call_id`, `model`),
	FOREIGN KEY (`call_id`) REFERENCES `observation_calls`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "observation_call_models_cost_state_ck" CHECK("observation_call_models"."cost_state" IN ('none','priced','partial','unpriced'))
);
--> statement-breakpoint
CREATE TABLE `observation_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL,
	`model` text NOT NULL,
	`input_micro` integer,
	`cache_read_micro` integer,
	`cache_write_micro` integer,
	`output_micro` integer,
	`effective_from` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`note` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observation_prices_line_idx` ON `observation_prices` (`runtime_id`,`model`,`created_at`);
