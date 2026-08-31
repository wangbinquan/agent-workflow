-- bootstrap: application-schema
CREATE SCHEMA IF NOT EXISTS "agent_workflow";

-- bootstrap: metadata-schema
CREATE SCHEMA IF NOT EXISTS "agent_workflow_meta";

-- bootstrap: unixepoch
CREATE OR REPLACE FUNCTION "agent_workflow".unixepoch() RETURNS BIGINT LANGUAGE SQL VOLATILE AS $$ SELECT extract(epoch from clock_timestamp())::bigint $$;

-- bootstrap: instr
CREATE OR REPLACE FUNCTION "agent_workflow".instr(value TEXT, needle TEXT) RETURNS BIGINT LANGUAGE SQL IMMUTABLE STRICT AS $$ SELECT strpos(value, needle)::bigint $$;

-- bootstrap: hex-text
CREATE OR REPLACE FUNCTION "agent_workflow".hex(value TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $$ SELECT encode(convert_to(value, 'UTF8'), 'hex') $$;

-- bootstrap: hex-bytea
CREATE OR REPLACE FUNCTION "agent_workflow".hex(value BYTEA) RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $$ SELECT encode(value, 'hex') $$;

-- bootstrap: max-bigint
CREATE OR REPLACE FUNCTION "agent_workflow".max(left_value BIGINT, right_value BIGINT) RETURNS BIGINT LANGUAGE SQL IMMUTABLE STRICT AS $$ SELECT greatest(left_value, right_value) $$;

-- bootstrap: json-valid
CREATE OR REPLACE FUNCTION "agent_workflow".json_valid(value TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE STRICT AS $$ BEGIN PERFORM value::jsonb; RETURN TRUE; EXCEPTION WHEN others THEN RETURN FALSE; END $$;

-- bootstrap: json-type
CREATE OR REPLACE FUNCTION "agent_workflow".json_type(value TEXT, path TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$ DECLARE item jsonb; BEGIN IF path !~ '^\$\.[A-Za-z_][A-Za-z0-9_]*$' THEN RETURN NULL; END IF; item := value::jsonb -> substring(path from 3); IF item IS NULL THEN RETURN NULL; END IF; RETURN jsonb_typeof(item); EXCEPTION WHEN others THEN RETURN NULL; END $$;

-- bootstrap: json-extract
CREATE OR REPLACE FUNCTION "agent_workflow".json_extract(value TEXT, path TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$ DECLARE item jsonb; BEGIN IF path !~ '^\$\.[A-Za-z_][A-Za-z0-9_]*$' THEN RETURN NULL; END IF; item := value::jsonb -> substring(path from 3); IF item IS NULL THEN RETURN NULL; END IF; IF jsonb_typeof(item) = 'string' THEN RETURN item #>> '{}'; END IF; RETURN item::text; EXCEPTION WHEN others THEN RETURN NULL; END $$;

-- table: action_template_revisions
CREATE TABLE "agent_workflow"."action_template_revisions" (
  "template_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "action_template_revisions_pkey" PRIMARY KEY ("template_id", "revision")
);

-- table: action_templates
CREATE TABLE "agent_workflow"."action_templates" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'private',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "archived_at" BIGINT,
  "capability_id" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "action_templates_pkey" PRIMARY KEY ("id")
);

-- table: agents
CREATE TABLE "agent_workflow"."agents" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "description" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "outputs" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "inputs" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "sync_outputs_on_iterate" BOOLEAN NOT NULL DEFAULT TRUE,
  "runtime" TEXT COLLATE "C",
  "permission" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "skills" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "depends_on" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "mcp" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "plugins" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "frontmatter_extra" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "body_md" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "builtin" BOOLEAN NOT NULL DEFAULT FALSE,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- table: auth_login_policy
CREATE TABLE "agent_workflow"."auth_login_policy" (
  "id" TEXT COLLATE "C" NOT NULL,
  "password_login_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "oidc_default_role" TEXT COLLATE "C" NOT NULL DEFAULT 'guest',
  "bootstrap_completed_at" BIGINT,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "auth_login_policy_pkey" PRIMARY KEY ("id")
);

-- table: automation_policies
CREATE TABLE "agent_workflow"."automation_policies" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'private',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "archived_at" BIGINT,
  CONSTRAINT "automation_policies_pkey" PRIMARY KEY ("id")
);

-- table: automation_policy_revisions
CREATE TABLE "agent_workflow"."automation_policy_revisions" (
  "policy_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "automation_policy_revisions_pkey" PRIMARY KEY ("policy_id", "revision")
);

-- table: cached_repos
CREATE TABLE "agent_workflow"."cached_repos" (
  "id" TEXT COLLATE "C" NOT NULL,
  "url_hash" TEXT COLLATE "C" NOT NULL,
  "url_enc" TEXT COLLATE "C",
  "url_redacted" TEXT COLLATE "C",
  "local_path" TEXT COLLATE "C" NOT NULL,
  "default_branch" TEXT COLLATE "C",
  "last_fetched_at" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "has_submodules" BOOLEAN,
  "last_submodule_sync_ok" BOOLEAN,
  "last_submodule_sync_error" TEXT COLLATE "C",
  "last_auto_refresh_at" BIGINT,
  CONSTRAINT "cached_repos_pkey" PRIMARY KEY ("id")
);

-- table: capability_templates
CREATE TABLE "agent_workflow"."capability_templates" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "description" TEXT COLLATE "C",
  "capability" TEXT COLLATE "C" NOT NULL,
  "scripts_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "hooks_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "param_schema_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "param_defaults_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "agent_by_slot_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "prompt_by_slot_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "params_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "stage_contract_ver" BIGINT NOT NULL DEFAULT 1,
  "upstream_id" TEXT COLLATE "C",
  "upstream_version" BIGINT,
  "base_digest" TEXT COLLATE "C",
  "base_snapshot_json" TEXT COLLATE "C",
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "builtin" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "capability_templates_pkey" PRIMARY KEY ("id")
);

-- table: clarify_rounds
CREATE TABLE "agent_workflow"."clarify_rounds" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "asking_node_id" TEXT COLLATE "C" NOT NULL,
  "asking_node_run_id" TEXT COLLATE "C" NOT NULL,
  "asking_shard_key" TEXT COLLATE "C",
  "intermediary_node_id" TEXT COLLATE "C" NOT NULL,
  "intermediary_node_run_id" TEXT COLLATE "C" NOT NULL,
  "target_consumer_node_id" TEXT COLLATE "C",
  "loop_iter" BIGINT NOT NULL DEFAULT 0,
  "iteration" BIGINT NOT NULL DEFAULT 0,
  "questions_json" TEXT COLLATE "C" NOT NULL,
  "answers_json" TEXT COLLATE "C",
  "directive" TEXT COLLATE "C",
  "status" TEXT COLLATE "C" NOT NULL DEFAULT 'awaiting_human',
  "truncation_warnings_json" TEXT COLLATE "C",
  "designer_run_triggered_at" BIGINT,
  "abandoned_at" BIGINT,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "answered_at" BIGINT,
  "answered_by" TEXT COLLATE "C",
  "submitted_by_role" TEXT COLLATE "C",
  "answer_attributions_json" TEXT COLLATE "C",
  "draft_answers_json" TEXT COLLATE "C",
  CONSTRAINT "clarify_rounds_pkey" PRIMARY KEY ("id")
);

-- table: code_ai_attempts
CREATE TABLE "agent_workflow"."code_ai_attempts" (
  "id" TEXT COLLATE "C" NOT NULL,
  "round_id" TEXT COLLATE "C" NOT NULL,
  "stage_name" TEXT COLLATE "C" NOT NULL,
  "shard_key" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "rerun_seq" BIGINT NOT NULL DEFAULT 0,
  "attempt_seq" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT COLLATE "C" NOT NULL DEFAULT 'claimed',
  "validation_outcome" TEXT COLLATE "C",
  "session_ref" TEXT COLLATE "C",
  "node_run_id" TEXT COLLATE "C",
  "started_at" BIGINT NOT NULL,
  "ended_at" BIGINT,
  CONSTRAINT "code_ai_attempts_pkey" PRIMARY KEY ("id")
);

-- table: code_findings
CREATE TABLE "agent_workflow"."code_findings" (
  "id" TEXT COLLATE "C" NOT NULL,
  "code_host_endpoint_id" TEXT COLLATE "C" NOT NULL,
  "stable_project_id" TEXT COLLATE "C" NOT NULL,
  "anchor_kind" TEXT COLLATE "C" NOT NULL,
  "anchor_id" TEXT COLLATE "C" NOT NULL,
  "capability" TEXT COLLATE "C" NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 1,
  "lifecycle" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "severity" TEXT COLLATE "C",
  "title" TEXT COLLATE "C",
  "file_path" TEXT COLLATE "C",
  "anchor_line" BIGINT,
  "external_id" TEXT COLLATE "C",
  "published_round_id" TEXT COLLATE "C",
  "disappeared_round_id" TEXT COLLATE "C",
  "resolved_at" BIGINT,
  "resolved_round_id" TEXT COLLATE "C",
  "code_changed_at" BIGINT,
  "code_changed_round_id" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "last_seen_at" BIGINT NOT NULL,
  "closed_at" BIGINT,
  CONSTRAINT "code_findings_pkey" PRIMARY KEY ("id")
);

-- table: code_host_connections
CREATE TABLE "agent_workflow"."code_host_connections" (
  "provider" TEXT COLLATE "C" NOT NULL,
  "base_url" TEXT COLLATE "C" NOT NULL,
  "repository_url_prefixes_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "transport_mappings_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "connection_generation" TEXT COLLATE "C" NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  "reject_unauthorized" BOOLEAN NOT NULL DEFAULT TRUE,
  "token_enc" TEXT COLLATE "C" NOT NULL,
  "token_hint" TEXT COLLATE "C" NOT NULL,
  "last_test_json" TEXT COLLATE "C",
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_by" TEXT COLLATE "C",
  CONSTRAINT "code_host_connections_pkey" PRIMARY KEY ("provider")
);

-- table: code_round_stages
CREATE TABLE "agent_workflow"."code_round_stages" (
  "id" TEXT COLLATE "C" NOT NULL,
  "round_id" TEXT COLLATE "C" NOT NULL,
  "stage_seq" BIGINT NOT NULL,
  "stage_name" TEXT COLLATE "C" NOT NULL,
  "stage_kind" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "counts_json" TEXT COLLATE "C",
  "error" TEXT COLLATE "C",
  "started_at" BIGINT,
  "ended_at" BIGINT,
  CONSTRAINT "code_round_stages_pkey" PRIMARY KEY ("id")
);

-- table: code_trigger_deliveries
CREATE TABLE "agent_workflow"."code_trigger_deliveries" (
  "id" TEXT COLLATE "C" NOT NULL,
  "correlation_id" TEXT COLLATE "C" NOT NULL,
  "code_host_endpoint_id" TEXT COLLATE "C",
  "stable_project_id" TEXT COLLATE "C",
  "anchor_kind" TEXT COLLATE "C",
  "anchor_id" TEXT COLLATE "C",
  "capability" TEXT COLLATE "C",
  "step" TEXT COLLATE "C" NOT NULL,
  "outcome" TEXT COLLATE "C" NOT NULL,
  "reason" TEXT COLLATE "C",
  "queued_at" BIGINT,
  "queue_position" BIGINT,
  "waiting_on" TEXT COLLATE "C",
  "round_id" TEXT COLLATE "C",
  "is_probe" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "code_trigger_deliveries_pkey" PRIMARY KEY ("id")
);

-- table: code_work_items
CREATE TABLE "agent_workflow"."code_work_items" (
  "id" TEXT COLLATE "C" NOT NULL,
  "code_host_endpoint_id" TEXT COLLATE "C" NOT NULL,
  "stable_project_id" TEXT COLLATE "C" NOT NULL,
  "capability" TEXT COLLATE "C" NOT NULL,
  "anchor_kind" TEXT COLLATE "C" NOT NULL,
  "anchor_id" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL DEFAULT 'idle',
  "epoch" BIGINT NOT NULL DEFAULT 1,
  "current_round_id" TEXT COLLATE "C",
  "pending_generation" BIGINT,
  "handed_off_fingerprint" TEXT COLLATE "C",
  "publishing_epoch" BIGINT,
  "pending_revision" TEXT COLLATE "C",
  "anchor_meta" TEXT COLLATE "C",
  "initiator_user_id" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "closed_at" BIGINT,
  CONSTRAINT "code_work_items_pkey" PRIMARY KEY ("id")
);

-- table: code_work_rounds
CREATE TABLE "agent_workflow"."code_work_rounds" (
  "id" TEXT COLLATE "C" NOT NULL,
  "work_item_id" TEXT COLLATE "C" NOT NULL,
  "round_seq" BIGINT NOT NULL,
  "epoch" BIGINT NOT NULL,
  "task_id" TEXT COLLATE "C",
  "baseline_sha" TEXT COLLATE "C",
  "work_package" TEXT COLLATE "C",
  "template_snapshot" TEXT COLLATE "C",
  "stage_contract_ver" BIGINT NOT NULL DEFAULT 1,
  "outcome" TEXT COLLATE "C",
  "started_at" BIGINT NOT NULL,
  "ended_at" BIGINT,
  CONSTRAINT "code_work_rounds_pkey" PRIMARY KEY ("id")
);

-- table: collaboration_gate_artifacts
CREATE TABLE "agent_workflow"."collaboration_gate_artifacts" (
  "operation_id" TEXT COLLATE "C" NOT NULL,
  "artifact_key" TEXT COLLATE "C" NOT NULL,
  "artifact_kind" TEXT COLLATE "C" NOT NULL,
  "staged_path" TEXT COLLATE "C" NOT NULL,
  "final_path" TEXT COLLATE "C" NOT NULL,
  "sha256" TEXT COLLATE "C" NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "receipt_json" TEXT COLLATE "C",
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "collaboration_gate_artifacts_pkey" PRIMARY KEY ("operation_id", "artifact_key")
);

-- table: collaboration_gate_operations
CREATE TABLE "agent_workflow"."collaboration_gate_operations" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "gate_kind" TEXT COLLATE "C" NOT NULL,
  "operation_kind" TEXT COLLATE "C" NOT NULL,
  "gate_ref" TEXT COLLATE "C" NOT NULL,
  "idempotency_key" TEXT COLLATE "C" NOT NULL,
  "request_hash" TEXT COLLATE "C" NOT NULL,
  "actor_user_id" TEXT COLLATE "C",
  "expected_task_revision" BIGINT NOT NULL,
  "expected_gate_revision" BIGINT NOT NULL,
  "result_gate_revision" BIGINT,
  "state" TEXT COLLATE "C" NOT NULL,
  "claim_epoch" BIGINT NOT NULL DEFAULT 0,
  "claim_expires_at" BIGINT,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "manifest_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "receipt_json" TEXT COLLATE "C",
  "failure_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "committed_at" BIGINT,
  "completed_at" BIGINT,
  CONSTRAINT "collaboration_gate_operations_pkey" PRIMARY KEY ("id")
);

-- table: committed_event_aggregate_heads
CREATE TABLE "agent_workflow"."committed_event_aggregate_heads" (
  "producer" TEXT COLLATE "C" NOT NULL,
  "family" TEXT COLLATE "C" NOT NULL,
  "aggregate_kind" TEXT COLLATE "C" NOT NULL,
  "aggregate_id" TEXT COLLATE "C" NOT NULL,
  "last_seq" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "committed_event_aggregate_heads_pkey" PRIMARY KEY ("producer", "family", "aggregate_kind", "aggregate_id")
);

-- table: committed_event_deliveries
CREATE TABLE "agent_workflow"."committed_event_deliveries" (
  "event_id" TEXT COLLATE "C" NOT NULL,
  "consumer_id" TEXT COLLATE "C" NOT NULL,
  "delivery_class" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "attempt_count" BIGINT NOT NULL DEFAULT 0,
  "next_attempt_at" BIGINT NOT NULL,
  "claimed_by" TEXT COLLATE "C",
  "lease_epoch" BIGINT NOT NULL DEFAULT 0,
  "claim_expires_at" BIGINT,
  "last_error_code" TEXT COLLATE "C",
  "last_error_summary" TEXT COLLATE "C",
  "replay_generation" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "accepted_at" BIGINT,
  "dead_letter_at" BIGINT,
  CONSTRAINT "committed_event_deliveries_pkey" PRIMARY KEY ("event_id", "consumer_id")
);

-- table: committed_event_family_cutovers
CREATE TABLE "agent_workflow"."committed_event_family_cutovers" (
  "producer" TEXT COLLATE "C" NOT NULL,
  "family" TEXT COLLATE "C" NOT NULL,
  "mode" TEXT COLLATE "C" NOT NULL,
  "epoch" BIGINT NOT NULL,
  "changed_at" BIGINT NOT NULL,
  "change_ref" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "committed_event_family_cutovers_pkey" PRIMARY KEY ("producer", "family")
);

-- table: committed_events
CREATE TABLE "agent_workflow"."committed_events" (
  "id" TEXT COLLATE "C" NOT NULL,
  "event_group_id" TEXT COLLATE "C" NOT NULL,
  "event_group_ordinal" BIGINT NOT NULL,
  "producer" TEXT COLLATE "C" NOT NULL,
  "family" TEXT COLLATE "C" NOT NULL,
  "event_type" TEXT COLLATE "C" NOT NULL,
  "schema_version" BIGINT NOT NULL,
  "aggregate_kind" TEXT COLLATE "C" NOT NULL,
  "aggregate_id" TEXT COLLATE "C" NOT NULL,
  "aggregate_seq" BIGINT NOT NULL,
  "operation_ref" TEXT COLLATE "C" NOT NULL,
  "correlation_ref" TEXT COLLATE "C",
  "causation_ref" TEXT COLLATE "C",
  "occurred_at" BIGINT NOT NULL,
  "payload_json" TEXT COLLATE "C" NOT NULL,
  "payload_digest" TEXT COLLATE "C" NOT NULL,
  "delivery_mode" TEXT COLLATE "C" NOT NULL,
  "producer_epoch" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "committed_events_pkey" PRIMARY KEY ("id")
);

-- table: custom_event_source_definitions
CREATE TABLE "agent_workflow"."custom_event_source_definitions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "retired_at" BIGINT,
  CONSTRAINT "custom_event_source_definitions_pkey" PRIMARY KEY ("id")
);

-- table: custom_event_source_revisions
CREATE TABLE "agent_workflow"."custom_event_source_revisions" (
  "source_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "validation_receipt_json" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "custom_event_source_revisions_pkey" PRIMARY KEY ("source_id", "revision")
);

-- table: development_action_runs
CREATE TABLE "agent_workflow"."development_action_runs" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "mission_revision" BIGINT NOT NULL,
  "decision_id" TEXT COLLATE "C" NOT NULL,
  "capability_id" TEXT COLLATE "C" NOT NULL,
  "capability_contract_version" BIGINT NOT NULL,
  "template_id" TEXT COLLATE "C",
  "template_revision" BIGINT,
  "work_set_digest" TEXT COLLATE "C",
  "input_fact_digest" TEXT COLLATE "C" NOT NULL,
  "baseline_ref" TEXT COLLATE "C",
  "writable" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT COLLATE "C" NOT NULL,
  "result_ref" TEXT COLLATE "C",
  "failure_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  CONSTRAINT "development_action_runs_pkey" PRIMARY KEY ("id")
);

-- table: development_adapter_definition_revisions
CREATE TABLE "agent_workflow"."development_adapter_definition_revisions" (
  "adapter_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "development_adapter_definition_revisions_pkey" PRIMARY KEY ("adapter_id", "revision")
);

-- table: development_adapter_definitions
CREATE TABLE "agent_workflow"."development_adapter_definitions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'private',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "archived_at" BIGINT,
  "purpose" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "development_adapter_definitions_pkey" PRIMARY KEY ("id")
);

-- table: development_agent_attempts
CREATE TABLE "agent_workflow"."development_agent_attempts" (
  "id" TEXT COLLATE "C" NOT NULL,
  "action_run_id" TEXT COLLATE "C" NOT NULL,
  "rerun_seq" BIGINT NOT NULL,
  "attempt_seq" BIGINT NOT NULL,
  "execution_ref" TEXT COLLATE "C",
  "baseline_ref" TEXT COLLATE "C" NOT NULL,
  "nonce_digest" TEXT COLLATE "C" NOT NULL,
  "input_digest" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL,
  "rejection_json" TEXT COLLATE "C",
  "outcome_ref" TEXT COLLATE "C",
  "pre_snapshot_ref" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  CONSTRAINT "development_agent_attempts_pkey" PRIMARY KEY ("id")
);

-- table: development_approval_sagas
CREATE TABLE "agent_workflow"."development_approval_sagas" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "step_run_id" TEXT COLLATE "C" NOT NULL,
  "adapter_id" TEXT COLLATE "C" NOT NULL,
  "adapter_revision" BIGINT NOT NULL,
  "draft_ref" TEXT COLLATE "C" NOT NULL,
  "submit_intent_digest" TEXT COLLATE "C" NOT NULL,
  "idempotency_key" TEXT COLLATE "C" NOT NULL,
  "correlation_ref" TEXT COLLATE "C",
  "external_request_ref" TEXT COLLATE "C",
  "submitted_revision" TEXT COLLATE "C",
  "latest_status" TEXT COLLATE "C" NOT NULL DEFAULT 'submitting',
  "observed_revision" TEXT COLLATE "C",
  "evidence_ref" TEXT COLLATE "C",
  "deadline_at" BIGINT NOT NULL,
  "attempt_ordinal" BIGINT NOT NULL DEFAULT 0,
  "next_observe_at" BIGINT,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  CONSTRAINT "development_approval_sagas_pkey" PRIMARY KEY ("id")
);

-- table: development_bundle_refs
CREATE TABLE "agent_workflow"."development_bundle_refs" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "purpose" TEXT COLLATE "C" NOT NULL,
  "evidence_ref" TEXT COLLATE "C" NOT NULL,
  "manifest_digest" TEXT COLLATE "C" NOT NULL,
  "file_count" BIGINT NOT NULL,
  "total_bytes" BIGINT NOT NULL,
  "retention_state" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "development_bundle_refs_pkey" PRIMARY KEY ("id")
);

-- table: development_decisions
CREATE TABLE "agent_workflow"."development_decisions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "mission_revision" BIGINT NOT NULL,
  "policy_id" TEXT COLLATE "C",
  "policy_revision" BIGINT,
  "employee_id" TEXT COLLATE "C",
  "employee_revision" BIGINT,
  "fact_snapshot_id" TEXT COLLATE "C",
  "fact_digest" TEXT COLLATE "C" NOT NULL,
  "work_set_json" TEXT COLLATE "C",
  "guard_trace_json" TEXT COLLATE "C" NOT NULL,
  "rule_trace_json" TEXT COLLATE "C" NOT NULL,
  "selected_json" TEXT COLLATE "C" NOT NULL,
  "canonical_digest" TEXT COLLATE "C" NOT NULL,
  "decision_input_digest" TEXT COLLATE "C" NOT NULL,
  "decided_at" BIGINT NOT NULL,
  CONSTRAINT "development_decisions_pkey" PRIMARY KEY ("id")
);

-- table: development_deferred_wakes
CREATE TABLE "agent_workflow"."development_deferred_wakes" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "decision_id" TEXT COLLATE "C" NOT NULL,
  "reason" TEXT COLLATE "C" NOT NULL,
  "resume_at" BIGINT,
  "wake_sources_json" TEXT COLLATE "C" NOT NULL,
  "attempt_ordinal" BIGINT NOT NULL DEFAULT 0,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'armed',
  "created_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  CONSTRAINT "development_deferred_wakes_pkey" PRIMARY KEY ("id")
);

-- table: development_effects
CREATE TABLE "agent_workflow"."development_effects" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "action_run_id" TEXT COLLATE "C",
  "effect_kind" TEXT COLLATE "C" NOT NULL,
  "intent_digest" TEXT COLLATE "C" NOT NULL,
  "idempotency_key" TEXT COLLATE "C" NOT NULL,
  "epoch" BIGINT NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'prepared',
  "receipt_ref" TEXT COLLATE "C",
  "failure_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  CONSTRAINT "development_effects_pkey" PRIMARY KEY ("id")
);

-- table: development_fact_snapshots
CREATE TABLE "agent_workflow"."development_fact_snapshots" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "mission_revision" BIGINT NOT NULL,
  "captured_at" TEXT COLLATE "C" NOT NULL,
  "cells_json" TEXT COLLATE "C" NOT NULL,
  "refs_json" TEXT COLLATE "C" NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "development_fact_snapshots_pkey" PRIMARY KEY ("id")
);

-- table: development_feedback_ledger
CREATE TABLE "agent_workflow"."development_feedback_ledger" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "thread_ref" TEXT COLLATE "C" NOT NULL,
  "revision" TEXT COLLATE "C" NOT NULL,
  "head_sha" TEXT COLLATE "C" NOT NULL,
  "fingerprint" TEXT COLLATE "C" NOT NULL,
  "author_class" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'observed',
  "action_run_id" TEXT COLLATE "C",
  "reply_effect_id" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "development_feedback_ledger_pkey" PRIMARY KEY ("id")
);

-- table: development_mission_links
CREATE TABLE "agent_workflow"."development_mission_links" (
  "id" TEXT COLLATE "C" NOT NULL,
  "parent_mission_id" TEXT COLLATE "C" NOT NULL,
  "parent_step_run_id" TEXT COLLATE "C" NOT NULL,
  "target_repository_id" TEXT COLLATE "C" NOT NULL,
  "target_employee_id" TEXT COLLATE "C" NOT NULL,
  "target_employee_revision" BIGINT NOT NULL,
  "input_digest" TEXT COLLATE "C" NOT NULL,
  "idempotency_key" TEXT COLLATE "C" NOT NULL,
  "child_mission_id" TEXT COLLATE "C",
  "completion" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'creating',
  "latest_child_revision" BIGINT,
  "latest_status" TEXT COLLATE "C",
  "completion_satisfied" BIGINT NOT NULL DEFAULT 0,
  "output_ref" TEXT COLLATE "C",
  "observed_at" BIGINT,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "development_mission_links_pkey" PRIMARY KEY ("id")
);

-- table: development_mission_sources
CREATE TABLE "agent_workflow"."development_mission_sources" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 1,
  "source_kind" TEXT COLLATE "C" NOT NULL,
  "external_id" TEXT COLLATE "C",
  "adapter_id" TEXT COLLATE "C",
  "adapter_revision" BIGINT,
  "source_revision" TEXT COLLATE "C",
  "bundle_ref" TEXT COLLATE "C",
  "manifest_digest" TEXT COLLATE "C",
  "file_count" BIGINT,
  "total_bytes" BIGINT,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "development_mission_sources_pkey" PRIMARY KEY ("id")
);

-- table: development_missions
CREATE TABLE "agent_workflow"."development_missions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  "epoch" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT COLLATE "C" NOT NULL,
  "automation_mode" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "transition_fence" TEXT COLLATE "C" NOT NULL DEFAULT 'none',
  "repository_id" TEXT COLLATE "C" NOT NULL,
  "source_kind" TEXT COLLATE "C" NOT NULL,
  "source_content_digest" TEXT COLLATE "C",
  "requested_source_key" TEXT COLLATE "C",
  "external_id" TEXT COLLATE "C",
  "resolved_source_key" TEXT COLLATE "C",
  "resolved_adapter_id" TEXT COLLATE "C",
  "resolved_adapter_revision" BIGINT,
  "delivery_kind" TEXT COLLATE "C" NOT NULL,
  "delivery_target_ref" TEXT COLLATE "C",
  "delivery_source_branch" TEXT COLLATE "C",
  "adopted_mr_ref" TEXT COLLATE "C",
  "assignment_id" TEXT COLLATE "C",
  "employee_id" TEXT COLLATE "C",
  "employee_revision" BIGINT,
  "policy_id" TEXT COLLATE "C",
  "policy_revision" BIGINT,
  "requirement_bundle_ref" TEXT COLLATE "C",
  "repository_facts_ref" TEXT COLLATE "C",
  "upload_plan_ref" TEXT COLLATE "C",
  "upload_placement_ref" TEXT COLLATE "C",
  "upload_publication_ref" TEXT COLLATE "C",
  "mr_claim_id" TEXT COLLATE "C",
  "current_action_run_id" TEXT COLLATE "C",
  "readiness_json" TEXT COLLATE "C",
  "block_code" TEXT COLLATE "C",
  "block_detail" TEXT COLLATE "C",
  "terminal_kind" TEXT COLLATE "C",
  "terminal_upload_fulfillment" TEXT COLLATE "C",
  "terminal_at" BIGINT,
  "reopened_from_mission_id" TEXT COLLATE "C",
  "launch_idempotency_key" TEXT COLLATE "C",
  "created_by" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "development_missions_pkey" PRIMARY KEY ("id")
);

-- table: development_mr_claims
CREATE TABLE "agent_workflow"."development_mr_claims" (
  "id" TEXT COLLATE "C" NOT NULL,
  "code_host_endpoint_ref" TEXT COLLATE "C" NOT NULL,
  "stable_project_ref" TEXT COLLATE "C" NOT NULL,
  "mr_iid" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "epoch" BIGINT NOT NULL,
  "head_sha" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "created_at" BIGINT NOT NULL,
  "released_at" BIGINT,
  CONSTRAINT "development_mr_claims_pkey" PRIMARY KEY ("id")
);

-- table: development_repository_upload_plan_entries
CREATE TABLE "agent_workflow"."development_repository_upload_plan_entries" (
  "plan_id" TEXT COLLATE "C" NOT NULL,
  "ordinal" BIGINT NOT NULL,
  "file_id" TEXT COLLATE "C" NOT NULL,
  "upload_blob_ref" TEXT COLLATE "C" NOT NULL,
  "upload_sha256" TEXT COLLATE "C" NOT NULL,
  "repository_target_path" TEXT COLLATE "C" NOT NULL,
  "content_policy" TEXT COLLATE "C" NOT NULL,
  "target_file_mode" TEXT COLLATE "C" NOT NULL,
  "expected_target_kind" TEXT COLLATE "C" NOT NULL,
  "expected_target_sha256" TEXT COLLATE "C",
  "expected_target_file_mode" TEXT COLLATE "C",
  CONSTRAINT "development_repository_upload_plan_entries_pkey" PRIMARY KEY ("plan_id", "ordinal")
);

-- table: development_repository_upload_plans
CREATE TABLE "agent_workflow"."development_repository_upload_plans" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "mission_revision" BIGINT NOT NULL,
  "repository_id" TEXT COLLATE "C" NOT NULL,
  "baseline_snapshot_ref" TEXT COLLATE "C" NOT NULL,
  "baseline_sha" TEXT COLLATE "C" NOT NULL,
  "plan_digest" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "development_repository_upload_plans_pkey" PRIMARY KEY ("id")
);

-- table: development_repository_upload_receipts
CREATE TABLE "agent_workflow"."development_repository_upload_receipts" (
  "id" TEXT COLLATE "C" NOT NULL,
  "plan_id" TEXT COLLATE "C" NOT NULL,
  "baseline_snapshot_ref" TEXT COLLATE "C" NOT NULL,
  "receipt_kind" TEXT COLLATE "C" NOT NULL,
  "seed_change_ref" TEXT COLLATE "C",
  "seed_tree_digest" TEXT COLLATE "C",
  "fulfillment_kind" TEXT COLLATE "C",
  "commit_sha" TEXT COLLATE "C",
  "entries_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "development_repository_upload_receipts_pkey" PRIMARY KEY ("id")
);

-- table: development_step_joins
CREATE TABLE "agent_workflow"."development_step_joins" (
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "group_id" TEXT COLLATE "C" NOT NULL,
  "member_step_id" TEXT COLLATE "C" NOT NULL,
  "mode" TEXT COLLATE "C" NOT NULL,
  "quorum" BIGINT,
  "deadline_at" BIGINT NOT NULL,
  "member_state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "receipt_revision" TEXT COLLATE "C",
  "settled_result" TEXT COLLATE "C",
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "development_step_joins_pkey" PRIMARY KEY ("mission_id", "group_id", "member_step_id")
);

-- table: development_step_runs
CREATE TABLE "agent_workflow"."development_step_runs" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "employee_id" TEXT COLLATE "C" NOT NULL,
  "employee_revision" BIGINT NOT NULL,
  "step_id" TEXT COLLATE "C" NOT NULL,
  "attempt" BIGINT NOT NULL DEFAULT 0,
  "input_digest" TEXT COLLATE "C" NOT NULL,
  "producer_kind" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'claimed',
  "decision_id" TEXT COLLATE "C",
  "action_run_id" TEXT COLLATE "C",
  "deadline_at" BIGINT,
  "output_ref" TEXT COLLATE "C",
  "output_revision" TEXT COLLATE "C",
  "failure_category" TEXT COLLATE "C",
  "failure_code" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  CONSTRAINT "development_step_runs_pkey" PRIMARY KEY ("id")
);

-- table: development_wake_hints
CREATE TABLE "agent_workflow"."development_wake_hints" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "source" TEXT COLLATE "C" NOT NULL,
  "delivery_key" TEXT COLLATE "C" NOT NULL,
  "observed_at" BIGINT NOT NULL,
  "consumed_at" BIGINT,
  CONSTRAINT "development_wake_hints_pkey" PRIMARY KEY ("id")
);

-- table: digital_employee_revisions
CREATE TABLE "agent_workflow"."digital_employee_revisions" (
  "employee_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "digital_employee_revisions_pkey" PRIMARY KEY ("employee_id", "revision")
);

-- table: digital_employees
CREATE TABLE "agent_workflow"."digital_employees" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'private',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "archived_at" BIGINT,
  CONSTRAINT "digital_employees_pkey" PRIMARY KEY ("id")
);

-- table: doc_versions
CREATE TABLE "agent_workflow"."doc_versions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "review_node_id" TEXT COLLATE "C" NOT NULL,
  "review_node_run_id" TEXT COLLATE "C" NOT NULL,
  "source_node_id" TEXT COLLATE "C" NOT NULL,
  "source_port_name" TEXT COLLATE "C" NOT NULL,
  "version_index" BIGINT NOT NULL,
  "review_iteration" BIGINT NOT NULL,
  "body_path" TEXT COLLATE "C" NOT NULL,
  "comments_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "decision" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "decision_reason" TEXT COLLATE "C",
  "prompt_snapshot" TEXT COLLATE "C",
  "source_file_path" TEXT COLLATE "C",
  "item_index" BIGINT,
  "selection" TEXT COLLATE "C",
  "item_path" TEXT COLLATE "C",
  "selection_stale" BOOLEAN,
  "round_generation" BIGINT,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "decided_at" BIGINT,
  "decided_by" TEXT COLLATE "C",
  "decided_by_role" TEXT COLLATE "C",
  CONSTRAINT "doc_versions_pkey" PRIMARY KEY ("id")
);

-- table: employee_approval_sagas
CREATE TABLE "agent_workflow"."employee_approval_sagas" (
  "id" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "submit_round_id" TEXT COLLATE "C" NOT NULL,
  "adapter_id" TEXT COLLATE "C" NOT NULL,
  "adapter_revision" BIGINT NOT NULL,
  "validated_draft_ref" TEXT COLLATE "C" NOT NULL,
  "deadline_at" TEXT COLLATE "C" NOT NULL,
  "idempotency_key" TEXT COLLATE "C" NOT NULL,
  "intent_digest" TEXT COLLATE "C" NOT NULL,
  "correlation_ref" TEXT COLLATE "C",
  "external_request_ref" TEXT COLLATE "C",
  "submitted_revision" TEXT COLLATE "C",
  "submitted_at" TEXT COLLATE "C",
  "latest_status" TEXT COLLATE "C" NOT NULL DEFAULT 'prepared',
  "observed_revision" TEXT COLLATE "C",
  "evidence_ref" TEXT COLLATE "C",
  "observed_at" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_approval_sagas_pkey" PRIMARY KEY ("id")
);

-- table: employee_attention_bindings
CREATE TABLE "agent_workflow"."employee_attention_bindings" (
  "id" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "context_id" TEXT COLLATE "C" NOT NULL,
  "context_revision" BIGINT NOT NULL,
  "event_type_id" TEXT COLLATE "C" NOT NULL,
  "event_type_revision" BIGINT NOT NULL,
  "subject_type" TEXT COLLATE "C" NOT NULL,
  "subject_ref" TEXT COLLATE "C" NOT NULL,
  "desired_identity_key" TEXT COLLATE "C" NOT NULL,
  "event_subscription_id" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'desired',
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_attention_bindings_pkey" PRIMARY KEY ("id")
);

-- table: employee_case_event_origins
CREATE TABLE "agent_workflow"."employee_case_event_origins" (
  "case_id" TEXT COLLATE "C" NOT NULL,
  "event_subscription_id" TEXT COLLATE "C" NOT NULL,
  "event_delivery_id" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "employee_case_event_origins_pkey" PRIMARY KEY ("case_id")
);

-- table: employee_case_inbox
CREATE TABLE "agent_workflow"."employee_case_inbox" (
  "id" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "delivery_id" TEXT COLLATE "C" NOT NULL,
  "event_id" TEXT COLLATE "C" NOT NULL,
  "event_type_id" TEXT COLLATE "C" NOT NULL,
  "event_type_revision" BIGINT NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "source_revision" BIGINT NOT NULL,
  "subject_type" TEXT COLLATE "C" NOT NULL,
  "subject_ref" TEXT COLLATE "C" NOT NULL,
  "delivery_class" TEXT COLLATE "C" NOT NULL,
  "priority" BIGINT NOT NULL,
  "occurred_at" BIGINT NOT NULL,
  "summary" TEXT COLLATE "C" NOT NULL,
  "payload_artifact_ref" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "round_id" TEXT COLLATE "C",
  "accepted_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  CONSTRAINT "employee_case_inbox_pkey" PRIMARY KEY ("id")
);

-- table: employee_case_members
CREATE TABLE "agent_workflow"."employee_case_members" (
  "case_id" TEXT COLLATE "C" NOT NULL,
  "user_id" TEXT COLLATE "C" NOT NULL,
  "role" TEXT COLLATE "C" NOT NULL,
  "added_by" TEXT COLLATE "C" NOT NULL,
  "added_at" BIGINT NOT NULL,
  CONSTRAINT "employee_case_members_pkey" PRIMARY KEY ("case_id", "user_id")
);

-- table: employee_case_metering_receipts
CREATE TABLE "agent_workflow"."employee_case_metering_receipts" (
  "source_ref" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "round_id" TEXT COLLATE "C" NOT NULL,
  "duration_ms" BIGINT NOT NULL,
  "total_tokens" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "employee_case_metering_receipts_pkey" PRIMARY KEY ("source_ref")
);

-- table: employee_case_workspaces
CREATE TABLE "agent_workflow"."employee_case_workspaces" (
  "case_id" TEXT COLLATE "C" NOT NULL,
  "repository_id" TEXT COLLATE "C" NOT NULL,
  "cached_repo_id" TEXT COLLATE "C" NOT NULL,
  "baseline_sha" TEXT COLLATE "C" NOT NULL,
  "target_branch" TEXT COLLATE "C" NOT NULL,
  "source_branch" TEXT COLLATE "C" NOT NULL,
  "remote_head_sha" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_case_workspaces_pkey" PRIMARY KEY ("case_id")
);

-- table: employee_cases
CREATE TABLE "agent_workflow"."employee_cases" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "employee_id" TEXT COLLATE "C" NOT NULL,
  "employee_revision" BIGINT NOT NULL,
  "type_id" TEXT COLLATE "C" NOT NULL,
  "type_revision" BIGINT NOT NULL,
  "primary_context_id" TEXT COLLATE "C" NOT NULL,
  "execution_policy_revision" BIGINT NOT NULL,
  "max_duration_ms" BIGINT,
  "consumed_duration_ms" BIGINT NOT NULL DEFAULT 0,
  "max_total_tokens" BIGINT,
  "consumed_total_tokens" BIGINT NOT NULL DEFAULT 0,
  "owner_user_id" TEXT COLLATE "C",
  "launch_origin" TEXT COLLATE "C" NOT NULL DEFAULT 'api',
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "terminal_kind" TEXT COLLATE "C",
  "block_reason" TEXT COLLATE "C",
  "current_work_item_ref" TEXT COLLATE "C",
  "active_round_id" TEXT COLLATE "C",
  "revision" BIGINT NOT NULL DEFAULT 1,
  "writer_generation" BIGINT NOT NULL DEFAULT 1,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "terminal_at" BIGINT,
  CONSTRAINT "employee_cases_pkey" PRIMARY KEY ("id")
);

-- table: employee_change_candidates
CREATE TABLE "agent_workflow"."employee_change_candidates" (
  "candidate_ref" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "round_id" TEXT COLLATE "C" NOT NULL,
  "baseline_sha" TEXT COLLATE "C" NOT NULL,
  "tree_oid" TEXT COLLATE "C" NOT NULL,
  "receipt_json" TEXT COLLATE "C" NOT NULL,
  "summary_source" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'prepared',
  "commit_sha" TEXT COLLATE "C",
  "push_receipt_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_change_candidates_pkey" PRIMARY KEY ("candidate_ref")
);

-- table: employee_channel_results
CREATE TABLE "agent_workflow"."employee_channel_results" (
  "id" TEXT COLLATE "C" NOT NULL,
  "channel_id" TEXT COLLATE "C" NOT NULL,
  "milestone_type" TEXT COLLATE "C" NOT NULL,
  "envelope_json" TEXT COLLATE "C" NOT NULL,
  "envelope_digest" TEXT COLLATE "C" NOT NULL,
  "monotonic" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "employee_channel_results_pkey" PRIMARY KEY ("id")
);

-- table: employee_channels
CREATE TABLE "agent_workflow"."employee_channels" (
  "id" TEXT COLLATE "C" NOT NULL,
  "invocation_id" TEXT COLLATE "C" NOT NULL,
  "parent_case_id" TEXT COLLATE "C" NOT NULL,
  "child_case_id" TEXT COLLATE "C" NOT NULL,
  "correlation_ref" TEXT COLLATE "C" NOT NULL,
  "result_contract_ref_json" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'open',
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_channels_pkey" PRIMARY KEY ("id")
);

-- table: employee_context_links
CREATE TABLE "agent_workflow"."employee_context_links" (
  "id" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "from_context_id" TEXT COLLATE "C" NOT NULL,
  "relation" TEXT COLLATE "C" NOT NULL,
  "to_context_id" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "employee_context_links_pkey" PRIMARY KEY ("id")
);

-- table: employee_context_records
CREATE TABLE "agent_workflow"."employee_context_records" (
  "id" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "type_id" TEXT COLLATE "C" NOT NULL,
  "schema_version" BIGINT NOT NULL,
  "current_revision" BIGINT NOT NULL,
  "lifecycle_state" TEXT COLLATE "C" NOT NULL,
  "state_json" TEXT COLLATE "C" NOT NULL,
  "artifact_refs_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_context_records_pkey" PRIMARY KEY ("id")
);

-- table: employee_context_revisions
CREATE TABLE "agent_workflow"."employee_context_revisions" (
  "context_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "state_json" TEXT COLLATE "C" NOT NULL,
  "artifact_refs_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "employee_context_revisions_pkey" PRIMARY KEY ("context_id", "revision")
);

-- table: employee_definition_revisions
CREATE TABLE "agent_workflow"."employee_definition_revisions" (
  "employee_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "employee_definition_revisions_pkey" PRIMARY KEY ("employee_id", "revision")
);

-- table: employee_definitions
CREATE TABLE "agent_workflow"."employee_definitions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "type_id" TEXT COLLATE "C" NOT NULL,
  "type_revision" BIGINT NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'private',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "archived_at" BIGINT,
  CONSTRAINT "employee_definitions_pkey" PRIMARY KEY ("id")
);

-- table: employee_execution_policy_revisions
CREATE TABLE "agent_workflow"."employee_execution_policy_revisions" (
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "employee_execution_policy_revisions_pkey" PRIMARY KEY ("revision")
);

-- table: employee_external_context_bindings
CREATE TABLE "agent_workflow"."employee_external_context_bindings" (
  "subject_type" TEXT COLLATE "C" NOT NULL,
  "subject_ref" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "context_id" TEXT COLLATE "C" NOT NULL,
  "binding_revision" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_external_context_bindings_pkey" PRIMARY KEY ("subject_type", "subject_ref")
);

-- table: employee_input_uploads
CREATE TABLE "agent_workflow"."employee_input_uploads" (
  "id" TEXT COLLATE "C" NOT NULL,
  "actor_user_id" TEXT COLLATE "C",
  "original_name" TEXT COLLATE "C" NOT NULL,
  "bytes" BIGINT NOT NULL,
  "sha256" TEXT COLLATE "C" NOT NULL,
  "blob_ref" TEXT COLLATE "C" NOT NULL,
  "upload_idempotency_key" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "claimed_by_case_id" TEXT COLLATE "C",
  "expires_at" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "claimed_at" BIGINT,
  CONSTRAINT "employee_input_uploads_pkey" PRIMARY KEY ("id")
);

-- table: employee_invocations
CREATE TABLE "agent_workflow"."employee_invocations" (
  "id" TEXT COLLATE "C" NOT NULL,
  "idempotency_key" TEXT COLLATE "C" NOT NULL,
  "parent_case_id" TEXT COLLATE "C" NOT NULL,
  "parent_round_id" TEXT COLLATE "C" NOT NULL,
  "target_employee_id" TEXT COLLATE "C" NOT NULL,
  "target_employee_revision" BIGINT NOT NULL,
  "target_work_scope_ref_json" TEXT COLLATE "C" NOT NULL,
  "input_envelope_ref" TEXT COLLATE "C" NOT NULL,
  "input_digest" TEXT COLLATE "C" NOT NULL,
  "completion_contract_ref_json" TEXT COLLATE "C" NOT NULL,
  "deadline_at" BIGINT NOT NULL,
  "child_case_id" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'requested',
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_invocations_pkey" PRIMARY KEY ("id")
);

-- table: employee_job_template_revisions
CREATE TABLE "agent_workflow"."employee_job_template_revisions" (
  "template_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "employee_job_template_revisions_pkey" PRIMARY KEY ("template_id", "revision")
);

-- table: employee_job_templates
CREATE TABLE "agent_workflow"."employee_job_templates" (
  "id" TEXT COLLATE "C" NOT NULL,
  "type_id" TEXT COLLATE "C" NOT NULL,
  "type_revision" BIGINT NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "archived_at" BIGINT,
  CONSTRAINT "employee_job_templates_pkey" PRIMARY KEY ("id")
);

-- table: employee_os_outbox
CREATE TABLE "agent_workflow"."employee_os_outbox" (
  "id" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C",
  "kind" TEXT COLLATE "C" NOT NULL,
  "payload_json" TEXT COLLATE "C" NOT NULL,
  "dedupe_key" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "attempt_count" BIGINT NOT NULL DEFAULT 0,
  "next_attempt_at" BIGINT NOT NULL,
  "claimed_by" TEXT COLLATE "C",
  "claim_expires_at" BIGINT,
  "last_error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_os_outbox_pkey" PRIMARY KEY ("id")
);

-- table: employee_os_settings
CREATE TABLE "agent_workflow"."employee_os_settings" (
  "singleton_key" TEXT COLLATE "C" NOT NULL,
  "execution_policy_revision" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_os_settings_pkey" PRIMARY KEY ("singleton_key")
);

-- table: employee_os_writer_state
CREATE TABLE "agent_workflow"."employee_os_writer_state" (
  "id" TEXT COLLATE "C" NOT NULL,
  "active_generation" BIGINT NOT NULL,
  "mode" TEXT COLLATE "C" NOT NULL,
  "legacy_admissions_enabled" BOOLEAN NOT NULL,
  "legacy_open_mission_count" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_os_writer_state_pkey" PRIMARY KEY ("id")
);

-- table: employee_reaction_rounds
CREATE TABLE "agent_workflow"."employee_reaction_rounds" (
  "id" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "case_revision" BIGINT NOT NULL,
  "inbox_id" TEXT COLLATE "C",
  "employee_id" TEXT COLLATE "C" NOT NULL,
  "employee_revision" BIGINT NOT NULL,
  "rule_id" TEXT COLLATE "C" NOT NULL,
  "work_item_ref" TEXT COLLATE "C" NOT NULL,
  "work_contract_id" TEXT COLLATE "C" NOT NULL,
  "work_contract_version" BIGINT NOT NULL,
  "tool_id" TEXT COLLATE "C",
  "tool_revision" BIGINT,
  "execution_policy_revision" BIGINT NOT NULL,
  "input_context_refs_json" TEXT COLLATE "C" NOT NULL,
  "plan_json" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'planned',
  "execution_ref" TEXT COLLATE "C",
  "output_json" TEXT COLLATE "C",
  "attempt_ordinal" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  CONSTRAINT "employee_reaction_rounds_pkey" PRIMARY KEY ("id")
);

-- table: employee_round_workspace_states
CREATE TABLE "agent_workflow"."employee_round_workspace_states" (
  "round_id" TEXT COLLATE "C" NOT NULL,
  "attempt_ordinal" BIGINT NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "baseline_sha" TEXT COLLATE "C" NOT NULL,
  "pre_state_json" TEXT COLLATE "C" NOT NULL,
  "checkpoint_digest" TEXT COLLATE "C" NOT NULL,
  "validation_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_round_workspace_states_pkey" PRIMARY KEY ("round_id", "attempt_ordinal")
);

-- table: employee_tool_registration_revisions
CREATE TABLE "agent_workflow"."employee_tool_registration_revisions" (
  "tool_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "validation_receipt_json" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'published',
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "employee_tool_registration_revisions_pkey" PRIMARY KEY ("tool_id", "revision")
);

-- table: employee_tool_registrations
CREATE TABLE "agent_workflow"."employee_tool_registrations" (
  "id" TEXT COLLATE "C" NOT NULL,
  "type_id" TEXT COLLATE "C" NOT NULL,
  "type_revision" BIGINT NOT NULL,
  "work_item_ref" TEXT COLLATE "C" NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "name" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "retired_at" BIGINT,
  CONSTRAINT "employee_tool_registrations_pkey" PRIMARY KEY ("id")
);

-- table: employee_type_packages
CREATE TABLE "agent_workflow"."employee_type_packages" (
  "type_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "descriptor_json" TEXT COLLATE "C" NOT NULL,
  "descriptor_digest" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'published',
  "registered_at" BIGINT NOT NULL,
  CONSTRAINT "employee_type_packages_pkey" PRIMARY KEY ("type_id", "revision")
);

-- table: employee_work_scope_revisions
CREATE TABLE "agent_workflow"."employee_work_scope_revisions" (
  "scope_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "type_id" TEXT COLLATE "C" NOT NULL,
  "type_revision" BIGINT NOT NULL,
  "encoded_scope_json" TEXT COLLATE "C" NOT NULL,
  "display_summary" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "created_by" TEXT COLLATE "C",
  CONSTRAINT "employee_work_scope_revisions_pkey" PRIMARY KEY ("scope_id", "revision")
);

-- table: event_deliveries
CREATE TABLE "agent_workflow"."event_deliveries" (
  "id" TEXT COLLATE "C" NOT NULL,
  "event_id" TEXT COLLATE "C" NOT NULL,
  "subscription_id" TEXT COLLATE "C" NOT NULL,
  "subscriber_kind" TEXT COLLATE "C" NOT NULL,
  "subscriber_ref" TEXT COLLATE "C" NOT NULL,
  "delivery_class" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "attempt_count" BIGINT NOT NULL DEFAULT 0,
  "next_attempt_at" BIGINT NOT NULL,
  "claimed_by" TEXT COLLATE "C",
  "claim_expires_at" BIGINT,
  "last_error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "accepted_at" BIGINT,
  "dead_letter_at" BIGINT,
  CONSTRAINT "event_deliveries_pkey" PRIMARY KEY ("id")
);

-- table: event_observer_runs
CREATE TABLE "agent_workflow"."event_observer_runs" (
  "id" TEXT COLLATE "C" NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "source_revision" BIGINT NOT NULL,
  "generation" BIGINT NOT NULL,
  "lease_epoch" BIGINT NOT NULL,
  "wake_epoch" BIGINT NOT NULL,
  "cursor_before_json" TEXT COLLATE "C",
  "cursor_after_json" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL,
  "observation_count" BIGINT NOT NULL DEFAULT 0,
  "started_at" BIGINT NOT NULL,
  "finished_at" BIGINT,
  "error_code" TEXT COLLATE "C",
  "error_detail" TEXT COLLATE "C",
  CONSTRAINT "event_observer_runs_pkey" PRIMARY KEY ("id")
);

-- table: event_records
CREATE TABLE "agent_workflow"."event_records" (
  "id" TEXT COLLATE "C" NOT NULL,
  "event_type_id" TEXT COLLATE "C" NOT NULL,
  "event_type_revision" BIGINT NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "source_revision" BIGINT NOT NULL,
  "subject_type" TEXT COLLATE "C" NOT NULL,
  "subject_ref" TEXT COLLATE "C" NOT NULL,
  "occurred_at" BIGINT NOT NULL,
  "observed_at" BIGINT NOT NULL,
  "dedupe_key" TEXT COLLATE "C" NOT NULL,
  "summary_json" TEXT COLLATE "C" NOT NULL,
  "payload_artifact_ref" TEXT COLLATE "C",
  CONSTRAINT "event_records_pkey" PRIMARY KEY ("id")
);

-- table: event_response_rules
CREATE TABLE "agent_workflow"."event_response_rules" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "owner_user_id" TEXT COLLATE "C" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "source_revision" BIGINT NOT NULL,
  "event_type_id" TEXT COLLATE "C" NOT NULL,
  "event_type_revision" BIGINT NOT NULL,
  "subject_type" TEXT COLLATE "C" NOT NULL,
  "subject_match" TEXT COLLATE "C" NOT NULL DEFAULT 'all',
  "subject_pattern" TEXT COLLATE "C",
  "target_json" TEXT COLLATE "C" NOT NULL,
  "last_fired_at" BIGINT,
  "last_status" TEXT COLLATE "C",
  "last_error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "event_response_rules_pkey" PRIMARY KEY ("id")
);

-- table: event_sources
CREATE TABLE "agent_workflow"."event_sources" (
  "source_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "descriptor_json" TEXT COLLATE "C" NOT NULL,
  "descriptor_digest" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'published',
  "registered_at" BIGINT NOT NULL,
  CONSTRAINT "event_sources_pkey" PRIMARY KEY ("source_id", "revision")
);

-- table: event_subscriptions
CREATE TABLE "agent_workflow"."event_subscriptions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "event_type_id" TEXT COLLATE "C" NOT NULL,
  "event_type_revision" BIGINT NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "source_revision" BIGINT NOT NULL,
  "subject_type" TEXT COLLATE "C" NOT NULL,
  "subject_ref" TEXT COLLATE "C" NOT NULL,
  "subscriber_kind" TEXT COLLATE "C" NOT NULL,
  "subscriber_ref" TEXT COLLATE "C" NOT NULL,
  "mode" TEXT COLLATE "C" NOT NULL DEFAULT 'exact',
  "origin_kind" TEXT COLLATE "C",
  "origin_ref" TEXT COLLATE "C",
  "definition_revision" TEXT COLLATE "C",
  "display_name_json" TEXT COLLATE "C",
  "selector_kind" TEXT COLLATE "C",
  "selector_json" TEXT COLLATE "C",
  "active_identity_key" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "cancelled_at" BIGINT,
  CONSTRAINT "event_subscriptions_pkey" PRIMARY KEY ("id")
);

-- table: event_type_catalog
CREATE TABLE "agent_workflow"."event_type_catalog" (
  "event_type_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "source_id" TEXT COLLATE "C" NOT NULL,
  "source_revision" BIGINT NOT NULL,
  "descriptor_json" TEXT COLLATE "C" NOT NULL,
  "descriptor_digest" TEXT COLLATE "C" NOT NULL,
  "catalog_visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'published',
  "registered_at" BIGINT NOT NULL,
  CONSTRAINT "event_type_catalog_pkey" PRIMARY KEY ("event_type_id", "revision")
);

-- table: fusions
CREATE TABLE "agent_workflow"."fusions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "skill_id" TEXT COLLATE "C" NOT NULL,
  "skill_name" TEXT COLLATE "C" NOT NULL,
  "base_skill_version" BIGINT NOT NULL,
  "precondition_token" TEXT COLLATE "C",
  "memory_ids_json" TEXT COLLATE "C" NOT NULL,
  "intent" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "status" TEXT COLLATE "C" NOT NULL DEFAULT 'running',
  "iteration" BIGINT NOT NULL DEFAULT 1,
  "current_task_id" TEXT COLLATE "C",
  "proposed_worktree_path" TEXT COLLATE "C",
  "proposed_diff" TEXT COLLATE "C",
  "incorporated_memory_ids_json" TEXT COLLATE "C",
  "skipped_json" TEXT COLLATE "C",
  "changelog" TEXT COLLATE "C",
  "applied_skill_version" BIGINT,
  "owner_user_id" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "decided_by_user_id" TEXT COLLATE "C",
  "decided_at" BIGINT,
  "decision_reason" TEXT COLLATE "C",
  "error" TEXT COLLATE "C",
  CONSTRAINT "fusions_pkey" PRIMARY KEY ("id")
);

-- table: intent_apply_journal
CREATE TABLE "agent_workflow"."intent_apply_journal" (
  "id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "client_mutation_id" TEXT COLLATE "C" NOT NULL,
  "draft_id" TEXT COLLATE "C" NOT NULL,
  "draft_hash" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'prepared',
  "prepared_artifacts_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "receipt_json" TEXT COLLATE "C",
  "error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "intent_apply_journal_pkey" PRIMARY KEY ("id")
);

-- table: intent_draft_resolutions
CREATE TABLE "agent_workflow"."intent_draft_resolutions" (
  "draft_id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "reason" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "intent_draft_resolutions_pkey" PRIMARY KEY ("draft_id")
);

-- table: intent_drafts
CREATE TABLE "agent_workflow"."intent_drafts" (
  "id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "changeset_json" TEXT COLLATE "C" NOT NULL,
  "validation_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "draft_hash" TEXT COLLATE "C" NOT NULL,
  "produced_by_turn_id" TEXT COLLATE "C",
  "context_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "intent_drafts_pkey" PRIMARY KEY ("id")
);

-- table: intent_provenance
CREATE TABLE "agent_workflow"."intent_provenance" (
  "resource_type" TEXT COLLATE "C" NOT NULL,
  "resource_id" TEXT COLLATE "C" NOT NULL,
  "commit_id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "intent_provenance_pkey" PRIMARY KEY ("resource_type", "resource_id", "commit_id")
);

-- table: intent_sessions
CREATE TABLE "agent_workflow"."intent_sessions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "owner_user_id" TEXT COLLATE "C" NOT NULL,
  "title" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "status" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "context_revision" BIGINT NOT NULL DEFAULT 0,
  "context_manifest_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "handle_watermark_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "current_draft_id" TEXT COLLATE "C",
  "in_flight_turn_id" TEXT COLLATE "C",
  "turn_seq" BIGINT NOT NULL DEFAULT 0,
  "commit_seq" BIGINT NOT NULL DEFAULT 0,
  "budget_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "intent_sessions_pkey" PRIMARY KEY ("id")
);

-- table: intent_turn_events
CREATE TABLE "agent_workflow"."intent_turn_events" (
  "id" BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "turn_id" TEXT COLLATE "C" NOT NULL,
  "event_seq" BIGINT NOT NULL,
  "ts" BIGINT NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "payload" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C",
  "parent_session_id" TEXT COLLATE "C",
  "source" TEXT COLLATE "C" NOT NULL,
  "external_event_id" TEXT COLLATE "C",
  CONSTRAINT "intent_turn_events_pkey" PRIMARY KEY ("id")
);

-- table: intent_turns
CREATE TABLE "agent_workflow"."intent_turns" (
  "id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "seq" BIGINT NOT NULL,
  "role" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "context_revision" BIGINT NOT NULL DEFAULT 0,
  "envelope_nonce" TEXT COLLATE "C",
  "run_meta_json" TEXT COLLATE "C",
  "client_mutation_id" TEXT COLLATE "C",
  "capture_state" TEXT COLLATE "C",
  "capture_last_event_seq" BIGINT NOT NULL DEFAULT 0,
  "capture_event_bytes" BIGINT NOT NULL DEFAULT 0,
  "capture_root_session_id" TEXT COLLATE "C",
  "capture_incomplete_reason" TEXT COLLATE "C",
  "scratch_retained" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "intent_turns_pkey" PRIMARY KEY ("id")
);

-- table: intent_working_set_changes
CREATE TABLE "agent_workflow"."intent_working_set_changes" (
  "id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "client_mutation_id" TEXT COLLATE "C" NOT NULL,
  "request_hash" TEXT COLLATE "C" NOT NULL,
  "expected_turn_seq" BIGINT NOT NULL,
  "expected_context_revision" BIGINT NOT NULL,
  "mode" TEXT COLLATE "C" NOT NULL,
  "delta_json" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "error" TEXT COLLATE "C",
  "resulting_context_revision" BIGINT,
  "resulting_turn_id" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "intent_working_set_changes_pkey" PRIMARY KEY ("id")
);

-- table: legacy_code_work_item_links
CREATE TABLE "agent_workflow"."legacy_code_work_item_links" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mission_id" TEXT COLLATE "C" NOT NULL,
  "legacy_work_item_id" TEXT COLLATE "C",
  "legacy_round_id" TEXT COLLATE "C",
  "cutover_receipt_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "legacy_code_work_item_links_pkey" PRIMARY KEY ("id")
);

-- table: lifecycle_alerts
CREATE TABLE "agent_workflow"."lifecycle_alerts" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "rule" TEXT COLLATE "C" NOT NULL,
  "severity" TEXT COLLATE "C" NOT NULL,
  "detail" TEXT COLLATE "C" NOT NULL,
  "detected_at" BIGINT NOT NULL,
  "resolved_at" BIGINT,
  CONSTRAINT "lifecycle_alerts_pkey" PRIMARY KEY ("id")
);

-- table: lifecycle_repair_audit
CREATE TABLE "agent_workflow"."lifecycle_repair_audit" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "alert_id" TEXT COLLATE "C",
  "alert_rule" TEXT COLLATE "C" NOT NULL,
  "alert_detail_json" TEXT COLLATE "C" NOT NULL,
  "option_id" TEXT COLLATE "C" NOT NULL,
  "actor_user_id" TEXT COLLATE "C",
  "before_snapshot_json" TEXT COLLATE "C" NOT NULL,
  "after_snapshot_json" TEXT COLLATE "C" NOT NULL,
  "outcome" TEXT COLLATE "C" NOT NULL,
  "outcome_message" TEXT COLLATE "C",
  "applied_at" BIGINT NOT NULL,
  CONSTRAINT "lifecycle_repair_audit_pkey" PRIMARY KEY ("id")
);

-- table: maintenance_runs
CREATE TABLE "agent_workflow"."maintenance_runs" (
  "id" TEXT COLLATE "C" NOT NULL,
  "job_key" TEXT COLLATE "C" NOT NULL,
  "job_class" TEXT COLLATE "C" NOT NULL,
  "slot_key" TEXT COLLATE "C" NOT NULL,
  "cycle_key" TEXT COLLATE "C",
  "state" TEXT COLLATE "C" NOT NULL,
  "payload_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "cursor_version" BIGINT NOT NULL DEFAULT 1,
  "cursor_json" TEXT COLLATE "C",
  "lease_token" TEXT COLLATE "C",
  "lease_expires_at" BIGINT,
  "heartbeat_at" BIGINT,
  "attempt" BIGINT NOT NULL DEFAULT 0,
  "slice_no" BIGINT NOT NULL DEFAULT 0,
  "counters_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "error_code" TEXT COLLATE "C",
  "error_message" TEXT COLLATE "C",
  "scheduled_at" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "started_at" BIGINT,
  "finished_at" BIGINT,
  CONSTRAINT "maintenance_runs_pkey" PRIMARY KEY ("id")
);

-- table: maintenance_state
CREATE TABLE "agent_workflow"."maintenance_state" (
  "key" TEXT COLLATE "C" NOT NULL,
  "value" TEXT COLLATE "C" NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "maintenance_state_pkey" PRIMARY KEY ("key")
);

-- table: mcp_probes
CREATE TABLE "agent_workflow"."mcp_probes" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mcp_id" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL,
  "latency_ms" BIGINT NOT NULL,
  "handshake_ms" BIGINT,
  "server_info_json" TEXT COLLATE "C",
  "protocol_version" TEXT COLLATE "C",
  "capabilities_json" TEXT COLLATE "C",
  "tools_json" TEXT COLLATE "C",
  "resources_json" TEXT COLLATE "C",
  "resource_templates_json" TEXT COLLATE "C",
  "prompts_json" TEXT COLLATE "C",
  "error_code" TEXT COLLATE "C",
  "error_message" TEXT COLLATE "C",
  "error_detail_json" TEXT COLLATE "C",
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "started_at" BIGINT NOT NULL,
  "finished_at" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "mcp_probes_pkey" PRIMARY KEY ("id")
);

-- table: mcp_runtime_test_create_receipts
CREATE TABLE "agent_workflow"."mcp_runtime_test_create_receipts" (
  "mcp_id" TEXT COLLATE "C" NOT NULL,
  "owner_user_id" TEXT COLLATE "C" NOT NULL,
  "client_create_id" TEXT COLLATE "C" NOT NULL,
  "request_digest" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "accepted_turn_id" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "expires_at" BIGINT NOT NULL,
  CONSTRAINT "mcp_runtime_test_create_receipts_pkey" PRIMARY KEY ("mcp_id", "owner_user_id", "client_create_id")
);

-- table: mcp_runtime_test_events
CREATE TABLE "agent_workflow"."mcp_runtime_test_events" (
  "id" BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "test_session_id" TEXT COLLATE "C" NOT NULL,
  "first_seen_turn_id" TEXT COLLATE "C" NOT NULL,
  "event_seq" BIGINT NOT NULL,
  "ts" BIGINT NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "payload" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C",
  "parent_session_id" TEXT COLLATE "C",
  "source" TEXT COLLATE "C" NOT NULL,
  "external_event_key" TEXT COLLATE "C",
  CONSTRAINT "mcp_runtime_test_events_pkey" PRIMARY KEY ("id")
);

-- table: mcp_runtime_test_session_leases
CREATE TABLE "agent_workflow"."mcp_runtime_test_session_leases" (
  "protocol" TEXT COLLATE "C" NOT NULL,
  "runtime_session_id" TEXT COLLATE "C" NOT NULL,
  "test_session_id" TEXT COLLATE "C" NOT NULL,
  "created_turn_id" TEXT COLLATE "C" NOT NULL,
  "current_turn_id" TEXT COLLATE "C" NOT NULL,
  "lease_turn_id" TEXT COLLATE "C",
  "lease_acquired_at" BIGINT,
  "lease_nonce_digest" TEXT COLLATE "C",
  CONSTRAINT "mcp_runtime_test_session_leases_pkey" PRIMARY KEY ("protocol", "runtime_session_id")
);

-- table: mcp_runtime_test_sessions
CREATE TABLE "agent_workflow"."mcp_runtime_test_sessions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "mcp_id" TEXT COLLATE "C" NOT NULL,
  "owner_user_id" TEXT COLLATE "C" NOT NULL,
  "client_create_id" TEXT COLLATE "C" NOT NULL,
  "client_create_digest" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL,
  "end_reason" TEXT COLLATE "C",
  "mcp_config_hash" TEXT COLLATE "C" NOT NULL,
  "runtime_row_id" TEXT COLLATE "C" NOT NULL,
  "runtime_name" TEXT COLLATE "C" NOT NULL,
  "runtime_protocol" TEXT COLLATE "C" NOT NULL,
  "runtime_snapshot_json" TEXT COLLATE "C" NOT NULL,
  "runtime_binary_path" TEXT COLLATE "C" NOT NULL,
  "runtime_session_id" TEXT COLLATE "C",
  "native_session_state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "in_flight_turn_id" TEXT COLLATE "C",
  "turn_seq" BIGINT NOT NULL DEFAULT 0,
  "session_version" BIGINT NOT NULL DEFAULT 0,
  "idle_deadline_at" BIGINT,
  "continuation_blocked_reason" TEXT COLLATE "C",
  "scratch_root" TEXT COLLATE "C" NOT NULL,
  "cleanup_state" TEXT COLLATE "C" NOT NULL DEFAULT 'not-started',
  "cleanup_error_code" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "ended_at" BIGINT,
  CONSTRAINT "mcp_runtime_test_sessions_pkey" PRIMARY KEY ("id")
);

-- table: mcp_runtime_test_turns
CREATE TABLE "agent_workflow"."mcp_runtime_test_turns" (
  "id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "seq" BIGINT NOT NULL,
  "client_message_id" TEXT COLLATE "C" NOT NULL,
  "prompt_text" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL,
  "hard_deadline_at" BIGINT NOT NULL,
  "capture_state" TEXT COLLATE "C" NOT NULL DEFAULT 'live',
  "capture_incomplete_reason" TEXT COLLATE "C",
  "capture_first_event_seq" BIGINT,
  "capture_last_event_seq" BIGINT NOT NULL DEFAULT 0,
  "capture_event_bytes" BIGINT NOT NULL DEFAULT 0,
  "cancel_requested_at" BIGINT,
  "pid" BIGINT,
  "spawned_at" BIGINT,
  "spawn_binary_path" TEXT COLLATE "C",
  "exit_code" BIGINT,
  "failure_code" TEXT COLLATE "C",
  "stderr_tail" TEXT COLLATE "C",
  "duration_ms" BIGINT,
  "started_at" BIGINT,
  "finished_at" BIGINT,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "mcp_runtime_test_turns_pkey" PRIMARY KEY ("id")
);

-- table: mcps
CREATE TABLE "agent_workflow"."mcps" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "description" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "type" TEXT COLLATE "C" NOT NULL,
  "config" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "mcps_pkey" PRIMARY KEY ("id")
);

-- table: memories
CREATE TABLE "agent_workflow"."memories" (
  "id" TEXT COLLATE "C" NOT NULL,
  "scope_type" TEXT COLLATE "C" NOT NULL,
  "scope_id" TEXT COLLATE "C",
  "title" TEXT COLLATE "C" NOT NULL,
  "body_md" TEXT COLLATE "C" NOT NULL,
  "tags" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "status" TEXT COLLATE "C" NOT NULL,
  "source_kind" TEXT COLLATE "C" NOT NULL,
  "source_event_id" TEXT COLLATE "C",
  "source_task_id" TEXT COLLATE "C",
  "distill_job_id" TEXT COLLATE "C",
  "distill_action" TEXT COLLATE "C",
  "supersedes_id" TEXT COLLATE "C",
  "superseded_by_id" TEXT COLLATE "C",
  "approved_by_user_id" TEXT COLLATE "C",
  "approved_at" BIGINT,
  "created_at" BIGINT NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 1,
  "fused_into_skill" TEXT COLLATE "C",
  "fused_into_skill_id" TEXT COLLATE "C",
  "fused_into_skill_version" BIGINT,
  "fused_at" BIGINT,
  "fused_by_user_id" TEXT COLLATE "C",
  "fused_fusion_id" TEXT COLLATE "C",
  CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- table: memory_distill_events
CREATE TABLE "agent_workflow"."memory_distill_events" (
  "id" BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "distill_job_id" TEXT COLLATE "C" NOT NULL,
  "attempt_index" BIGINT NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "parent_session_id" TEXT COLLATE "C",
  "ts" BIGINT NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "payload" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "memory_distill_events_pkey" PRIMARY KEY ("id")
);

-- table: memory_distill_jobs
CREATE TABLE "agent_workflow"."memory_distill_jobs" (
  "id" TEXT COLLATE "C" NOT NULL,
  "debounce_key" TEXT COLLATE "C" NOT NULL,
  "source_kind" TEXT COLLATE "C" NOT NULL,
  "source_event_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C",
  "scope_resolved_json" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL,
  "attempts" BIGINT NOT NULL DEFAULT 0,
  "next_run_at" BIGINT NOT NULL,
  "last_error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "started_at" BIGINT,
  "finished_at" BIGINT,
  "opencode_session_id" TEXT COLLATE "C",
  "user_prompt_md" TEXT COLLATE "C",
  "exit_code" BIGINT,
  "stderr_excerpt" TEXT COLLATE "C",
  "dedup_snapshot_ids_json" TEXT COLLATE "C",
  "output_lang" TEXT COLLATE "C",
  CONSTRAINT "memory_distill_jobs_pkey" PRIMARY KEY ("id")
);

-- table: memory_scope_move_events
CREATE TABLE "agent_workflow"."memory_scope_move_events" (
  "id" TEXT COLLATE "C" NOT NULL,
  "memory_id" TEXT COLLATE "C" NOT NULL,
  "actor_user_id" TEXT COLLATE "C" NOT NULL,
  "actor_source" TEXT COLLATE "C" NOT NULL,
  "from_scope_type" TEXT COLLATE "C" NOT NULL,
  "from_scope_id" TEXT COLLATE "C",
  "to_scope_type" TEXT COLLATE "C" NOT NULL,
  "to_scope_id" TEXT COLLATE "C",
  "expected_version" BIGINT NOT NULL,
  "resulting_version" BIGINT NOT NULL,
  "correlation_id" TEXT COLLATE "C" NOT NULL,
  "causation_id" TEXT COLLATE "C",
  "occurred_at" BIGINT NOT NULL,
  CONSTRAINT "memory_scope_move_events_pkey" PRIMARY KEY ("id")
);

-- table: mission_input_uploads
CREATE TABLE "agent_workflow"."mission_input_uploads" (
  "id" TEXT COLLATE "C" NOT NULL,
  "actor_user_id" TEXT COLLATE "C",
  "original_name" TEXT COLLATE "C" NOT NULL,
  "bytes" BIGINT NOT NULL,
  "sha256" TEXT COLLATE "C" NOT NULL,
  "blob_ref" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'pending',
  "claimed_by_mission_id" TEXT COLLATE "C",
  "upload_idempotency_key" TEXT COLLATE "C",
  "expires_at" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "claimed_at" BIGINT,
  CONSTRAINT "mission_input_uploads_pkey" PRIMARY KEY ("id")
);

-- table: node_run_events
CREATE TABLE "agent_workflow"."node_run_events" (
  "id" BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "ts" BIGINT NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "payload" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C",
  "parent_session_id" TEXT COLLATE "C",
  CONSTRAINT "node_run_events_pkey" PRIMARY KEY ("id")
);

-- table: node_run_outputs
CREATE TABLE "agent_workflow"."node_run_outputs" (
  "node_run_id" TEXT COLLATE "C" NOT NULL,
  "port_name" TEXT COLLATE "C" NOT NULL,
  "content" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C",
  "archive_json" TEXT COLLATE "C",
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT "node_run_outputs_pkey" PRIMARY KEY ("node_run_id", "port_name")
);

-- table: node_runs
CREATE TABLE "agent_workflow"."node_runs" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_id" TEXT COLLATE "C" NOT NULL,
  "parent_node_run_id" TEXT COLLATE "C",
  "iteration" BIGINT NOT NULL DEFAULT 0,
  "shard_key" TEXT COLLATE "C",
  "retry_index" BIGINT NOT NULL DEFAULT 0,
  "wg_round" BIGINT,
  "review_iteration" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT COLLATE "C" NOT NULL,
  "started_at" BIGINT,
  "finished_at" BIGINT,
  "pid" BIGINT,
  "spawn_binary_path" TEXT COLLATE "C",
  "spawn_launch_nonce" TEXT COLLATE "C",
  "exit_code" BIGINT,
  "error_message" TEXT COLLATE "C",
  "failure_code" TEXT COLLATE "C",
  "prompt_text" TEXT COLLATE "C",
  "prompt_path" TEXT COLLATE "C",
  "envelope_nonce" TEXT COLLATE "C",
  "force_activated" BOOLEAN NOT NULL DEFAULT FALSE,
  "tok_input" BIGINT,
  "tok_output" BIGINT,
  "tok_cache_create" BIGINT,
  "tok_cache_read" BIGINT,
  "tok_total" BIGINT,
  "pre_snapshot" TEXT COLLATE "C",
  "opencode_session_id" TEXT COLLATE "C",
  "runtime" TEXT COLLATE "C",
  "runtime_binary" TEXT COLLATE "C",
  "runtime_params_json" TEXT COLLATE "C",
  "inventory_snapshot_json" TEXT COLLATE "C",
  "runtime_inventory_json" TEXT COLLATE "C",
  "startup_verification_json" TEXT COLLATE "C",
  "wrapper_progress_json" TEXT COLLATE "C",
  "injected_memories_json" TEXT COLLATE "C",
  "port_validation_failures_json" TEXT COLLATE "C",
  "commit_push_json" TEXT COLLATE "C",
  "pre_snapshot_repos_json" TEXT COLLATE "C",
  "iso_worktree_path" TEXT COLLATE "C",
  "iso_base_snapshot" TEXT COLLATE "C",
  "iso_base_snapshot_repos_json" TEXT COLLATE "C",
  "iso_node_tree" TEXT COLLATE "C",
  "iso_node_tree_repos_json" TEXT COLLATE "C",
  "iso_submodules_json" TEXT COLLATE "C",
  "iso_submodules_repos_json" TEXT COLLATE "C",
  "merge_state" TEXT COLLATE "C",
  "consumed_upstream_runs_json" TEXT COLLATE "C",
  "shard_value_hash" TEXT COLLATE "C",
  "rerun_cause" TEXT COLLATE "C",
  "superseded_by_review" TEXT COLLATE "C",
  "rolled_back" BOOLEAN,
  "agent_override_name" TEXT COLLATE "C",
  "agent_override_id" TEXT COLLATE "C",
  "child_task_id" TEXT COLLATE "C",
  "continuation_slot_key" TEXT COLLATE "C",
  "lineage_slot_path_json" TEXT COLLATE "C",
  "operation_generation" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "node_runs_pkey" PRIMARY KEY ("id")
);

-- table: observer_activations
CREATE TABLE "agent_workflow"."observer_activations" (
  "source_id" TEXT COLLATE "C" NOT NULL,
  "source_revision" BIGINT NOT NULL,
  "subscriber_count" BIGINT NOT NULL DEFAULT 0,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'idle',
  "generation" BIGINT NOT NULL DEFAULT 0,
  "wake_epoch" BIGINT NOT NULL DEFAULT 0,
  "cursor_json" TEXT COLLATE "C",
  "lease_owner" TEXT COLLATE "C",
  "lease_epoch" BIGINT NOT NULL DEFAULT 0,
  "lease_expires_at" BIGINT,
  "next_scan_at" BIGINT,
  "last_scan_at" BIGINT,
  "last_success_at" BIGINT,
  "last_error_code" TEXT COLLATE "C",
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "observer_activations_pkey" PRIMARY KEY ("source_id", "source_revision")
);

-- table: oidc_providers
CREATE TABLE "agent_workflow"."oidc_providers" (
  "id" TEXT COLLATE "C" NOT NULL,
  "slug" TEXT COLLATE "C" NOT NULL,
  "display_name" TEXT COLLATE "C" NOT NULL,
  "issuer_url" TEXT COLLATE "C" NOT NULL,
  "client_id" TEXT COLLATE "C" NOT NULL,
  "client_secret_enc" TEXT COLLATE "C" NOT NULL,
  "scopes" TEXT COLLATE "C" NOT NULL DEFAULT 'openid profile email',
  "provisioning" TEXT COLLATE "C" NOT NULL DEFAULT 'invite',
  "allowed_email_domains_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "icon_url" TEXT COLLATE "C",
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "authorization_endpoint" TEXT COLLATE "C",
  "token_endpoint" TEXT COLLATE "C",
  "userinfo_endpoint" TEXT COLLATE "C",
  "userinfo_request_style" TEXT COLLATE "C" NOT NULL DEFAULT 'get_bearer',
  "jwks_uri" TEXT COLLATE "C",
  "trust_email_verified" BOOLEAN NOT NULL DEFAULT FALSE,
  "username_claim" TEXT COLLATE "C",
  "git_name_claim" TEXT COLLATE "C",
  "email_claim" TEXT COLLATE "C",
  "subject_claim" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "oidc_providers_pkey" PRIMARY KEY ("id")
);

-- table: plugins
CREATE TABLE "agent_workflow"."plugins" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "spec" TEXT COLLATE "C" NOT NULL,
  "options_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "description" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "source_kind" TEXT COLLATE "C" NOT NULL,
  "cached_path" TEXT COLLATE "C" NOT NULL,
  "resolved_version" TEXT COLLATE "C",
  "installed_at" BIGINT NOT NULL,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "plugins_pkey" PRIMARY KEY ("id")
);

-- table: recovery_events
CREATE TABLE "agent_workflow"."recovery_events" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C",
  "node_run_id" TEXT COLLATE "C",
  "actor" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "reason" TEXT COLLATE "C",
  "before_json" TEXT COLLATE "C",
  "after_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "recovery_events_pkey" PRIMARY KEY ("id")
);

-- table: repo_capability_config
CREATE TABLE "agent_workflow"."repo_capability_config" (
  "id" TEXT COLLATE "C" NOT NULL,
  "repo_id" TEXT COLLATE "C" NOT NULL,
  "capability" TEXT COLLATE "C" NOT NULL,
  "template_id" TEXT COLLATE "C",
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "trigger_config_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "readiness" TEXT COLLATE "C" NOT NULL DEFAULT 'disabled',
  "readiness_issues_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "dependency_revision" BIGINT NOT NULL DEFAULT 0,
  "last_validated_at" BIGINT,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "repo_capability_config_pkey" PRIMARY KEY ("id")
);

-- table: repo_group_nodes
CREATE TABLE "agent_workflow"."repo_group_nodes" (
  "group_id" TEXT COLLATE "C" NOT NULL,
  "path" TEXT COLLATE "C" NOT NULL,
  "attachment_kind" TEXT COLLATE "C",
  "cached_repo_id" TEXT COLLATE "C",
  "ref" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "subdir" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "child_group_id" TEXT COLLATE "C",
  "readonly" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "repo_group_nodes_pkey" PRIMARY KEY ("group_id", "path")
);

-- table: repo_groups
CREATE TABLE "agent_workflow"."repo_groups" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "description" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "version" BIGINT NOT NULL DEFAULT 1,
  "created_by_user_id" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "repo_groups_pkey" PRIMARY KEY ("id")
);

-- table: repository_employee_assignments
CREATE TABLE "agent_workflow"."repository_employee_assignments" (
  "id" TEXT COLLATE "C" NOT NULL,
  "scope_kind" TEXT COLLATE "C" NOT NULL,
  "scope_ref" TEXT COLLATE "C",
  "employee_id" TEXT COLLATE "C",
  "employee_revision" BIGINT,
  "selection_policy_id" TEXT COLLATE "C",
  "selection_policy_revision" BIGINT,
  "execution_policy_id" TEXT COLLATE "C",
  "execution_policy_revision" BIGINT,
  "default_requirement_source_key" TEXT COLLATE "C",
  "updated_by" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "repository_employee_assignments_pkey" PRIMARY KEY ("id")
);

-- table: repository_transport_connections
CREATE TABLE "agent_workflow"."repository_transport_connections" (
  "provider" TEXT COLLATE "C" NOT NULL,
  "connection_generation" TEXT COLLATE "C" NOT NULL,
  "endpoint_binding_digest" TEXT COLLATE "C" NOT NULL,
  "api_base_url" TEXT COLLATE "C" NOT NULL,
  "reject_unauthorized" BOOLEAN NOT NULL,
  "transport_mappings_json" TEXT COLLATE "C" NOT NULL,
  "allowed_http_base_urls_json" TEXT COLLATE "C" NOT NULL,
  "global_token_enc" TEXT COLLATE "C" NOT NULL,
  "global_token_hint" TEXT COLLATE "C" NOT NULL,
  "credential_revision" BIGINT NOT NULL DEFAULT 1,
  "updated_at" BIGINT NOT NULL,
  "updated_by" TEXT COLLATE "C",
  CONSTRAINT "repository_transport_connections_pkey" PRIMARY KEY ("provider")
);

-- table: resource_bundle_applies
CREATE TABLE "agent_workflow"."resource_bundle_applies" (
  "id" TEXT COLLATE "C" NOT NULL,
  "scope" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "actor_user_id" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'prepared',
  "prepared_artifacts_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "receipt_json" TEXT COLLATE "C",
  "error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "resource_bundle_applies_pkey" PRIMARY KEY ("id")
);

-- table: resource_grants
CREATE TABLE "agent_workflow"."resource_grants" (
  "resource_type" TEXT COLLATE "C" NOT NULL,
  "resource_id" TEXT COLLATE "C" NOT NULL,
  "user_id" TEXT COLLATE "C" NOT NULL,
  "added_by" TEXT COLLATE "C" NOT NULL,
  "added_at" BIGINT NOT NULL,
  "level" TEXT COLLATE "C" NOT NULL DEFAULT 'read',
  CONSTRAINT "resource_grants_pkey" PRIMARY KEY ("resource_type", "resource_id", "user_id")
);

-- table: review_comments
CREATE TABLE "agent_workflow"."review_comments" (
  "id" TEXT COLLATE "C" NOT NULL,
  "doc_version_id" TEXT COLLATE "C" NOT NULL,
  "anchor_section_path" TEXT COLLATE "C" NOT NULL,
  "anchor_paragraph_idx" BIGINT NOT NULL,
  "anchor_offset_start" BIGINT NOT NULL,
  "anchor_offset_end" BIGINT NOT NULL,
  "selected_text" TEXT COLLATE "C" NOT NULL,
  "context_before" TEXT COLLATE "C" NOT NULL,
  "context_after" TEXT COLLATE "C" NOT NULL,
  "occurrence_index" BIGINT NOT NULL,
  "comment_text" TEXT COLLATE "C" NOT NULL,
  "author" TEXT COLLATE "C" NOT NULL DEFAULT 'local',
  "author_role" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- table: review_node_reviewers
CREATE TABLE "agent_workflow"."review_node_reviewers" (
  "task_id" TEXT COLLATE "C" NOT NULL,
  "review_node_id" TEXT COLLATE "C" NOT NULL,
  "reviewer_user_id" TEXT COLLATE "C" NOT NULL,
  "assigned_by_user_id" TEXT COLLATE "C" NOT NULL,
  "assigned_at" BIGINT NOT NULL,
  CONSTRAINT "review_node_reviewers_pkey" PRIMARY KEY ("task_id", "review_node_id", "reviewer_user_id")
);

-- table: runtime_session_leases
CREATE TABLE "agent_workflow"."runtime_session_leases" (
  "protocol" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_id" TEXT COLLATE "C" NOT NULL,
  "created_node_run_id" TEXT COLLATE "C" NOT NULL,
  "lease_node_run_id" TEXT COLLATE "C",
  "lease_nonce_digest" TEXT COLLATE "C",
  "leased_at" BIGINT,
  "reset_pending" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "runtime_session_leases_pkey" PRIMARY KEY ("protocol", "session_id")
);

-- table: runtimes
CREATE TABLE "agent_workflow"."runtimes" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "protocol" TEXT COLLATE "C" NOT NULL,
  "binary_path" TEXT COLLATE "C",
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "model" TEXT COLLATE "C",
  "variant" TEXT COLLATE "C",
  "temperature" DOUBLE PRECISION,
  "steps" BIGINT,
  "max_steps" BIGINT,
  "is_sandbox" BOOLEAN NOT NULL DEFAULT FALSE,
  "config_dir_env" TEXT COLLATE "C",
  "config_dir_name" TEXT COLLATE "C",
  "extra_args_json" TEXT COLLATE "C",
  "last_probe_json" TEXT COLLATE "C",
  "probe_fence" BIGINT NOT NULL DEFAULT 0,
  "created_by" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "runtimes_pkey" PRIMARY KEY ("id")
);

-- table: scheduled_tasks
CREATE TABLE "agent_workflow"."scheduled_tasks" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "owner_user_id" TEXT COLLATE "C" NOT NULL,
  "launch_kind" TEXT COLLATE "C" NOT NULL DEFAULT 'workflow',
  "launch_payload" TEXT COLLATE "C" NOT NULL,
  "schedule_spec" TEXT COLLATE "C" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "next_run_at" BIGINT,
  "last_run_at" BIGINT,
  "last_status" TEXT COLLATE "C",
  "last_error" TEXT COLLATE "C",
  "last_task_id" TEXT COLLATE "C",
  "consecutive_failures" BIGINT NOT NULL DEFAULT 0,
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- table: skill_operation_locks
CREATE TABLE "agent_workflow"."skill_operation_locks" (
  "locked_skill_id" TEXT COLLATE "C" NOT NULL,
  "op_id" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "skill_operation_locks_pkey" PRIMARY KEY ("locked_skill_id")
);

-- table: skill_operations
CREATE TABLE "agent_workflow"."skill_operations" (
  "op_id" TEXT COLLATE "C" NOT NULL,
  "skill_id" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "phase" TEXT COLLATE "C" NOT NULL,
  "active" BIGINT NOT NULL DEFAULT 1,
  "staging_path" TEXT COLLATE "C",
  "backup_path" TEXT COLLATE "C",
  "candidate_path" TEXT COLLATE "C",
  "candidate_fingerprint" TEXT COLLATE "C",
  "backup_fingerprint" TEXT COLLATE "C",
  "target_version" BIGINT,
  "generation" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "precondition_json" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "skill_operations_pkey" PRIMARY KEY ("op_id")
);

-- table: skill_versions
CREATE TABLE "agent_workflow"."skill_versions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "skill_id" TEXT COLLATE "C" NOT NULL,
  "version_index" BIGINT NOT NULL,
  "files_path" TEXT COLLATE "C" NOT NULL,
  "source" TEXT COLLATE "C" NOT NULL,
  "summary" TEXT COLLATE "C",
  "fusion_id" TEXT COLLATE "C",
  "restored_from_version" BIGINT,
  "author_user_id" TEXT COLLATE "C",
  "content_hash" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- table: skills
CREATE TABLE "agent_workflow"."skills" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "description" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "managed_path" TEXT COLLATE "C",
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "content_version" BIGINT NOT NULL DEFAULT 1,
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "meta_revision" BIGINT NOT NULL DEFAULT 0,
  "reservation_state" TEXT COLLATE "C" NOT NULL DEFAULT 'ready',
  "version_state" TEXT COLLATE "C" NOT NULL DEFAULT 'legacy-unbackfilled',
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- table: task_archive_audit
CREATE TABLE "agent_workflow"."task_archive_audit" (
  "id" TEXT COLLATE "C" NOT NULL,
  "source" TEXT COLLATE "C" NOT NULL,
  "actor_user_id" TEXT COLLATE "C",
  "retention_days" BIGINT NOT NULL,
  "tree_count" BIGINT NOT NULL,
  "task_count" BIGINT NOT NULL,
  "skipped_count" BIGINT NOT NULL,
  "root_task_ids_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "task_archive_audit_pkey" PRIMARY KEY ("id")
);

-- table: task_collaborators
CREATE TABLE "agent_workflow"."task_collaborators" (
  "task_id" TEXT COLLATE "C" NOT NULL,
  "user_id" TEXT COLLATE "C" NOT NULL,
  "role" TEXT COLLATE "C" NOT NULL,
  "added_by" TEXT COLLATE "C" NOT NULL,
  "added_at" BIGINT NOT NULL,
  CONSTRAINT "task_collaborators_pkey" PRIMARY KEY ("task_id", "user_id", "role")
);

-- table: task_execution_effect_attempts
CREATE TABLE "agent_workflow"."task_execution_effect_attempts" (
  "id" TEXT COLLATE "C" NOT NULL,
  "effect_id" TEXT COLLATE "C" NOT NULL,
  "attempt_no" BIGINT NOT NULL,
  "intent_id" TEXT COLLATE "C" NOT NULL,
  "epoch" BIGINT NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "candidate_id" TEXT COLLATE "C" NOT NULL,
  "request_hash" TEXT COLLATE "C" NOT NULL,
  "recovery_class" TEXT COLLATE "C" NOT NULL,
  "recovery_descriptor_json" TEXT COLLATE "C",
  "classifier_version" TEXT COLLATE "C" NOT NULL,
  "transport_policy_version" TEXT COLLATE "C" NOT NULL,
  "application_evidence" TEXT COLLATE "C",
  "retry_authority" TEXT COLLATE "C" NOT NULL DEFAULT 'none',
  "receipt_json" TEXT COLLATE "C",
  "failure_code" TEXT COLLATE "C",
  "prepared_at" BIGINT NOT NULL,
  "acting_at" BIGINT,
  "settled_at" BIGINT,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "task_execution_effect_attempts_pkey" PRIMARY KEY ("id")
);

-- table: task_execution_effect_fences
CREATE TABLE "agent_workflow"."task_execution_effect_fences" (
  "effect_attempt_id" TEXT COLLATE "C" NOT NULL,
  "fence_key" TEXT COLLATE "C" NOT NULL,
  "acquired_epoch" BIGINT NOT NULL,
  "acquired_at" BIGINT NOT NULL,
  "released_at" BIGINT,
  CONSTRAINT "task_execution_effect_fences_pkey" PRIMARY KEY ("effect_attempt_id", "fence_key")
);

-- table: task_execution_effects
CREATE TABLE "agent_workflow"."task_execution_effects" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "origin_intent_id" TEXT COLLATE "C" NOT NULL,
  "current_intent_id" TEXT COLLATE "C" NOT NULL,
  "operation_key" TEXT COLLATE "C" NOT NULL,
  "execution_lineage_id" TEXT COLLATE "C" NOT NULL,
  "operation_family_key" TEXT COLLATE "C" NOT NULL,
  "operation_generation" BIGINT NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "request_hash" TEXT COLLATE "C" NOT NULL,
  "slot_path_json" TEXT COLLATE "C" NOT NULL,
  "slot_path_digest" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "last_attempt_no" BIGINT NOT NULL DEFAULT 0,
  "receipt_json" TEXT COLLATE "C",
  "failure_code" TEXT COLLATE "C",
  "prepared_at" BIGINT NOT NULL,
  "settled_at" BIGINT,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "task_execution_effects_pkey" PRIMARY KEY ("id")
);

-- table: task_execution_intents
CREATE TABLE "agent_workflow"."task_execution_intents" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "source" TEXT COLLATE "C" NOT NULL,
  "request_hash" TEXT COLLATE "C" NOT NULL,
  "payload_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "execution_lineage_id" TEXT COLLATE "C" NOT NULL,
  "continuation_slot_key" TEXT COLLATE "C" NOT NULL,
  "slot_path_json" TEXT COLLATE "C" NOT NULL,
  "operation_generation" BIGINT NOT NULL DEFAULT 0,
  "replay_authorization_id" TEXT COLLATE "C",
  "authorization_scope_json" TEXT COLLATE "C",
  "expected_task_revision" BIGINT NOT NULL,
  "claimed_epoch" BIGINT,
  "failure_code" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "claimed_at" BIGINT,
  "completed_at" BIGINT,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "task_execution_intents_pkey" PRIMARY KEY ("id")
);

-- table: task_execution_lineage_operation_records
CREATE TABLE "agent_workflow"."task_execution_lineage_operation_records" (
  "id" TEXT COLLATE "C" NOT NULL,
  "record_kind" TEXT COLLATE "C" NOT NULL,
  "execution_lineage_id" TEXT COLLATE "C" NOT NULL,
  "operation_family_key" TEXT COLLATE "C" NOT NULL,
  "operation_generation" BIGINT,
  "highest_settled_generation" BIGINT,
  "last_outcome" TEXT COLLATE "C",
  "request_hash" TEXT COLLATE "C" NOT NULL,
  "slot_path_json" TEXT COLLATE "C" NOT NULL,
  "slot_path_digest" TEXT COLLATE "C" NOT NULL,
  "root_anchor_task_id" TEXT COLLATE "C",
  "ancestor_anchor_task_id" TEXT COLLATE "C",
  "current_anchor_task_id" TEXT COLLATE "C",
  "source_task_id" TEXT COLLATE "C",
  "source_effect_id" TEXT COLLATE "C",
  "source_attempt_id" TEXT COLLATE "C",
  "provider_coordinate_json" TEXT COLLATE "C",
  "failure_code" TEXT COLLATE "C",
  "decision_state" TEXT COLLATE "C",
  "replay_authorization_id" TEXT COLLATE "C",
  "authorization_scope_json" TEXT COLLATE "C",
  "actor_user_id" TEXT COLLATE "C",
  "authorization_source" TEXT COLLATE "C",
  "bound_intent_id" TEXT COLLATE "C",
  "new_effect_id" TEXT COLLATE "C",
  "record_revision" BIGINT NOT NULL,
  "compacted" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "task_execution_lineage_operation_records_pkey" PRIMARY KEY ("id")
);

-- table: task_execution_maintenance_claims
CREATE TABLE "agent_workflow"."task_execution_maintenance_claims" (
  "id" TEXT COLLATE "C" NOT NULL,
  "root_task_id" TEXT COLLATE "C" NOT NULL,
  "operation" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "member_set_digest" TEXT COLLATE "C" NOT NULL,
  "expected_tree_digest" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "cleanup_plan_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "completed_at" BIGINT,
  CONSTRAINT "task_execution_maintenance_claims_pkey" PRIMARY KEY ("id")
);

-- table: task_execution_maintenance_members
CREATE TABLE "agent_workflow"."task_execution_maintenance_members" (
  "claim_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "expected_task_revision" BIGINT NOT NULL,
  "expected_owner_revision" BIGINT,
  "expected_topology_revision" BIGINT NOT NULL,
  "expected_ledger_digest" TEXT COLLATE "C" NOT NULL,
  "released_at" BIGINT,
  CONSTRAINT "task_execution_maintenance_members_pkey" PRIMARY KEY ("claim_id", "task_id")
);

-- table: task_execution_owners
CREATE TABLE "agent_workflow"."task_execution_owners" (
  "task_id" TEXT COLLATE "C" NOT NULL,
  "owner_id" TEXT COLLATE "C" NOT NULL,
  "daemon_generation" TEXT COLLATE "C" NOT NULL,
  "epoch" BIGINT NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "lease_until" BIGINT NOT NULL,
  "revision" BIGINT NOT NULL,
  "last_heartbeat_at" BIGINT NOT NULL,
  "recovery_code" TEXT COLLATE "C",
  "recovery_proof_digest" TEXT COLLATE "C",
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "task_execution_owners_pkey" PRIMARY KEY ("task_id")
);

-- table: task_feedback
CREATE TABLE "agent_workflow"."task_feedback" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "author_user_id" TEXT COLLATE "C",
  "body_md" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "distilled" BIGINT NOT NULL DEFAULT 0,
  "distill_job_id" TEXT COLLATE "C",
  CONSTRAINT "task_feedback_pkey" PRIMARY KEY ("id")
);

-- table: task_node_clarify_directives
CREATE TABLE "agent_workflow"."task_node_clarify_directives" (
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_id" TEXT COLLATE "C" NOT NULL,
  "shard_key" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "directive" TEXT COLLATE "C" NOT NULL,
  "set_by" TEXT COLLATE "C",
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "task_node_clarify_directives_pkey" PRIMARY KEY ("task_id", "node_id", "shard_key")
);

-- table: task_questions
CREATE TABLE "agent_workflow"."task_questions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "origin_node_run_id" TEXT COLLATE "C" NOT NULL,
  "question_id" TEXT COLLATE "C" NOT NULL,
  "question_title" TEXT COLLATE "C" NOT NULL,
  "source_kind" TEXT COLLATE "C" NOT NULL,
  "role_kind" TEXT COLLATE "C" NOT NULL,
  "iteration" BIGINT NOT NULL DEFAULT 0,
  "loop_iter" BIGINT NOT NULL DEFAULT 0,
  "default_target_node_id" TEXT COLLATE "C",
  "override_target_node_id" TEXT COLLATE "C",
  "dispatched_at" BIGINT,
  "dispatched_by" TEXT COLLATE "C",
  "trigger_run_id" TEXT COLLATE "C",
  "staged_at" BIGINT,
  "staged_by" TEXT COLLATE "C",
  "auto_dispatch_deferred_at" BIGINT,
  "sealed_at" BIGINT,
  "sealed_by" TEXT COLLATE "C",
  "confirmation" TEXT COLLATE "C" NOT NULL DEFAULT 'open',
  "confirmed_by" TEXT COLLATE "C",
  "confirmed_by_role" TEXT COLLATE "C",
  "confirmed_at" BIGINT,
  "last_reassigned_by" TEXT COLLATE "C",
  "last_reassigned_at" BIGINT,
  "manual_body" TEXT COLLATE "C",
  "manual_created_by" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "task_questions_pkey" PRIMARY KEY ("id")
);

-- table: task_repos
CREATE TABLE "agent_workflow"."task_repos" (
  "task_id" TEXT COLLATE "C" NOT NULL,
  "repo_index" BIGINT NOT NULL,
  "repo_path" TEXT COLLATE "C" NOT NULL,
  "repo_url" TEXT COLLATE "C",
  "cached_repo_id" TEXT COLLATE "C",
  "base_branch" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "branch" TEXT COLLATE "C" NOT NULL,
  "working_branch" TEXT COLLATE "C",
  "base_commit" TEXT COLLATE "C",
  "worktree_path" TEXT COLLATE "C" NOT NULL,
  "worktree_dir_name" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "mount_path" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "subdir" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "readonly" BOOLEAN NOT NULL DEFAULT FALSE,
  "readonly_dirty_count" BIGINT,
  "workspace_profile_version" BIGINT,
  "workspace_profile_digest" TEXT COLLATE "C",
  "has_submodules" BOOLEAN,
  "submodule_init_ok" BOOLEAN,
  "submodule_init_error" TEXT COLLATE "C",
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "task_repos_pkey" PRIMARY KEY ("task_id", "repo_index")
);

-- table: task_space_nodes
CREATE TABLE "agent_workflow"."task_space_nodes" (
  "task_id" TEXT COLLATE "C" NOT NULL,
  "node_path" TEXT COLLATE "C" NOT NULL,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "task_space_nodes_pkey" PRIMARY KEY ("task_id", "node_path")
);

-- table: tasks
CREATE TABLE "agent_workflow"."tasks" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "workflow_id" TEXT COLLATE "C" NOT NULL,
  "workflow_snapshot" TEXT COLLATE "C" NOT NULL,
  "workflow_version" BIGINT,
  "repo_path" TEXT COLLATE "C" NOT NULL,
  "repo_url" TEXT COLLATE "C",
  "cached_repo_id" TEXT COLLATE "C",
  "repo_group_id" TEXT COLLATE "C",
  "repo_group_name" TEXT COLLATE "C",
  "worktree_path" TEXT COLLATE "C" NOT NULL,
  "base_branch" TEXT COLLATE "C" NOT NULL,
  "branch" TEXT COLLATE "C" NOT NULL,
  "base_commit" TEXT COLLATE "C",
  "status" TEXT COLLATE "C" NOT NULL,
  "inputs" TEXT COLLATE "C" NOT NULL,
  "max_duration_ms" BIGINT,
  "max_total_tokens" BIGINT,
  "started_at" BIGINT NOT NULL,
  "running_ms" BIGINT NOT NULL DEFAULT 0,
  "running_since" BIGINT,
  "finished_at" BIGINT,
  "error_summary" TEXT COLLATE "C",
  "error_message" TEXT COLLATE "C",
  "failed_node_id" TEXT COLLATE "C",
  "auto_recovery_attempts" BIGINT NOT NULL DEFAULT 0,
  "auto_recovery_suspended" BOOLEAN NOT NULL DEFAULT FALSE,
  "auto_recovery_window_started_at" BIGINT,
  "expires_at" BIGINT,
  "deleted_at" BIGINT,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "owner_user_id" TEXT COLLATE "C",
  "launch_origin" TEXT COLLATE "C" NOT NULL DEFAULT 'manual',
  "catalog_visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "git_user_name" TEXT COLLATE "C",
  "git_user_email" TEXT COLLATE "C",
  "working_branch" TEXT COLLATE "C",
  "auto_commit_push" BOOLEAN NOT NULL DEFAULT FALSE,
  "repo_count" BIGINT NOT NULL DEFAULT 1,
  "scheduled_task_id" TEXT COLLATE "C",
  "webhook_trigger_id" TEXT COLLATE "C",
  "webhook_fire_id" TEXT COLLATE "C",
  "event_subscription_id" TEXT COLLATE "C",
  "event_delivery_id" TEXT COLLATE "C",
  "lifecycle_event_revision" BIGINT NOT NULL DEFAULT 1,
  "source_termination_binding" TEXT COLLATE "C",
  "source_termination_launch_rev" BIGINT,
  "source_termination_fence" TEXT COLLATE "C",
  "source_termination_effect_rev" BIGINT,
  "workgroup_id" TEXT COLLATE "C",
  "workgroup_config_json" TEXT COLLATE "C",
  "space_kind" TEXT COLLATE "C" NOT NULL DEFAULT 'remote',
  "source_agent_name" TEXT COLLATE "C",
  "code_round_id" TEXT COLLATE "C",
  "digital_employee_round_id" TEXT COLLATE "C",
  "digital_employee_case_id" TEXT COLLATE "C",
  "source_agent_id" TEXT COLLATE "C",
  "workspace_pruning_at" BIGINT,
  "workspace_prune_cause" TEXT COLLATE "C",
  "workspace_pruned_at" BIGINT,
  "parent_task_id" TEXT COLLATE "C",
  "parent_node_run_id" TEXT COLLATE "C",
  "invocation_depth" BIGINT NOT NULL DEFAULT 0,
  "ref_closure_json" TEXT COLLATE "C",
  "trigger_context_json" TEXT COLLATE "C",
  "platform_input_paths_json" TEXT COLLATE "C",
  "branch_started_at" BIGINT NOT NULL DEFAULT 0,
  "root_task_id" TEXT COLLATE "C",
  "execution_lineage_id" TEXT COLLATE "C",
  "lineage_slot_path_json" TEXT COLLATE "C",
  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- table: token_audit
CREATE TABLE "agent_workflow"."token_audit" (
  "id" TEXT COLLATE "C" NOT NULL,
  "pat_id" TEXT COLLATE "C" NOT NULL,
  "user_id" TEXT COLLATE "C" NOT NULL,
  "channel" TEXT COLLATE "C" NOT NULL,
  "tool_name" TEXT COLLATE "C",
  "method" TEXT COLLATE "C",
  "path" TEXT COLLATE "C",
  "resource_kind" TEXT COLLATE "C",
  "resource_id" TEXT COLLATE "C",
  "status_code" BIGINT NOT NULL,
  "snapshot_failed" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "token_audit_pkey" PRIMARY KEY ("id")
);

-- table: token_delete_snapshot
CREATE TABLE "agent_workflow"."token_delete_snapshot" (
  "id" TEXT COLLATE "C" NOT NULL,
  "audit_id" TEXT COLLATE "C" NOT NULL,
  "resource_kind" TEXT COLLATE "C" NOT NULL,
  "resource_id" TEXT COLLATE "C" NOT NULL,
  "snapshot_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "token_delete_snapshot_pkey" PRIMARY KEY ("id")
);

-- table: user_access_audit
CREATE TABLE "agent_workflow"."user_access_audit" (
  "id" TEXT COLLATE "C" NOT NULL,
  "target_user_id" TEXT COLLATE "C" NOT NULL,
  "actor_user_id" TEXT COLLATE "C",
  "actor_kind" TEXT COLLATE "C" NOT NULL,
  "operation_id" TEXT COLLATE "C" NOT NULL,
  "correlation_id" TEXT COLLATE "C",
  "before_role" TEXT COLLATE "C" NOT NULL,
  "after_role" TEXT COLLATE "C" NOT NULL,
  "added_permissions_json" TEXT COLLATE "C" NOT NULL,
  "removed_permissions_json" TEXT COLLATE "C" NOT NULL,
  "access_revision" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "user_access_audit_pkey" PRIMARY KEY ("id")
);

-- table: user_identities
CREATE TABLE "agent_workflow"."user_identities" (
  "id" TEXT COLLATE "C" NOT NULL,
  "user_id" TEXT COLLATE "C" NOT NULL,
  "provider_id" TEXT COLLATE "C" NOT NULL,
  "subject" TEXT COLLATE "C" NOT NULL,
  "email" TEXT COLLATE "C",
  "email_verified" BIGINT NOT NULL DEFAULT 0,
  "preferred_snapshot" TEXT COLLATE "C",
  "linked_at" BIGINT NOT NULL,
  CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- table: user_pats
CREATE TABLE "agent_workflow"."user_pats" (
  "id" TEXT COLLATE "C" NOT NULL,
  "user_id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "token_hash" TEXT COLLATE "C" NOT NULL,
  "scopes_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "created_at" BIGINT NOT NULL,
  "last_used_at" BIGINT,
  "expires_at" BIGINT,
  "revoked_at" BIGINT,
  "purpose" TEXT COLLATE "C" NOT NULL DEFAULT 'general',
  CONSTRAINT "user_pats_pkey" PRIMARY KEY ("id")
);

-- table: user_permission_grants
CREATE TABLE "agent_workflow"."user_permission_grants" (
  "user_id" TEXT COLLATE "C" NOT NULL,
  "permission" TEXT COLLATE "C" NOT NULL,
  "granted_by_user_id" TEXT COLLATE "C",
  "granted_at" BIGINT NOT NULL,
  CONSTRAINT "user_permission_grants_pkey" PRIMARY KEY ("user_id", "permission")
);

-- table: user_repository_transport_credentials
CREATE TABLE "agent_workflow"."user_repository_transport_credentials" (
  "user_id" TEXT COLLATE "C" NOT NULL,
  "provider" TEXT COLLATE "C" NOT NULL,
  "connection_generation" TEXT COLLATE "C" NOT NULL,
  "endpoint_binding_digest" TEXT COLLATE "C" NOT NULL,
  "token_enc" TEXT COLLATE "C" NOT NULL,
  "token_hint" TEXT COLLATE "C" NOT NULL,
  "credential_revision" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "user_repository_transport_credentials_pkey" PRIMARY KEY ("user_id", "provider")
);

-- table: user_sessions
CREATE TABLE "agent_workflow"."user_sessions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "user_id" TEXT COLLATE "C" NOT NULL,
  "token_hash" TEXT COLLATE "C" NOT NULL,
  "user_agent" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "last_used_at" BIGINT NOT NULL,
  "expires_at" BIGINT NOT NULL,
  "revoked_at" BIGINT,
  CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- table: users
CREATE TABLE "agent_workflow"."users" (
  "id" TEXT COLLATE "C" NOT NULL,
  "username" TEXT COLLATE "C" NOT NULL,
  "email" TEXT COLLATE "C",
  "display_name" TEXT COLLATE "C" NOT NULL,
  "git_name" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "password_hash" TEXT COLLATE "C",
  "role" TEXT COLLATE "C" NOT NULL DEFAULT 'user',
  "status" TEXT COLLATE "C" NOT NULL DEFAULT 'active',
  "force_password_change" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_by" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "last_login_at" BIGINT,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "access_revision" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- table: verification_profile_revisions
CREATE TABLE "agent_workflow"."verification_profile_revisions" (
  "profile_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "content_digest" TEXT COLLATE "C" NOT NULL,
  "published_at" BIGINT NOT NULL,
  "published_by" TEXT COLLATE "C",
  CONSTRAINT "verification_profile_revisions_pkey" PRIMARY KEY ("profile_id", "revision")
);

-- table: verification_profiles
CREATE TABLE "agent_workflow"."verification_profiles" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "draft_json" TEXT COLLATE "C" NOT NULL,
  "published_revision" BIGINT,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'private',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  "archived_at" BIGINT,
  CONSTRAINT "verification_profiles_pkey" PRIMARY KEY ("id")
);

-- table: webhook_deliveries
CREATE TABLE "agent_workflow"."webhook_deliveries" (
  "id" TEXT COLLATE "C" NOT NULL,
  "endpoint_id" TEXT COLLATE "C" NOT NULL,
  "event_uuid" TEXT COLLATE "C",
  "attempt_count" BIGINT NOT NULL DEFAULT 1,
  "gitlab_event_header" TEXT COLLATE "C",
  "object_kind" TEXT COLLATE "C",
  "event_type" TEXT COLLATE "C",
  "repo_path" TEXT COLLATE "C",
  "stream_hint" TEXT COLLATE "C",
  "mr_fact_key" TEXT COLLATE "C",
  "mr_stream_key" TEXT COLLATE "C",
  "mr_stream_revision" BIGINT,
  "mr_state_after" TEXT COLLATE "C",
  "status" TEXT COLLATE "C" NOT NULL,
  "status_reason" TEXT COLLATE "C",
  "replayed_from_delivery_id" TEXT COLLATE "C",
  "received_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "body_json" TEXT COLLATE "C",
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- table: webhook_endpoints
CREATE TABLE "agent_workflow"."webhook_endpoints" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "provider" TEXT COLLATE "C" NOT NULL,
  "url_token" TEXT COLLATE "C" NOT NULL,
  "secret_enc" TEXT COLLATE "C" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "preferred_clone_protocol" TEXT COLLATE "C" NOT NULL DEFAULT 'http',
  "last_delivery_at" BIGINT,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- table: webhook_mr_control_effects
CREATE TABLE "agent_workflow"."webhook_mr_control_effects" (
  "id" TEXT COLLATE "C" NOT NULL,
  "delivery_id" TEXT COLLATE "C" NOT NULL,
  "endpoint_id" TEXT COLLATE "C" NOT NULL,
  "stream_key" TEXT COLLATE "C" NOT NULL,
  "binding" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "observed_event_type" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL,
  "lease_owner" TEXT COLLATE "C",
  "lease_expires_at" BIGINT,
  "attempt_count" BIGINT NOT NULL DEFAULT 0,
  "next_attempt_at" BIGINT NOT NULL,
  "last_error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "webhook_mr_control_effects_pkey" PRIMARY KEY ("id")
);

-- table: webhook_mr_control_targets
CREATE TABLE "agent_workflow"."webhook_mr_control_targets" (
  "effect_id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "prior_status" TEXT COLLATE "C",
  "fence_outcome" TEXT COLLATE "C" NOT NULL,
  "cancel_outcome" TEXT COLLATE "C" NOT NULL,
  "release_outcome" TEXT COLLATE "C" NOT NULL,
  "error" TEXT COLLATE "C",
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "webhook_mr_control_targets_pkey" PRIMARY KEY ("effect_id", "task_id")
);

-- table: webhook_mr_launch_guards
CREATE TABLE "agent_workflow"."webhook_mr_launch_guards" (
  "id" TEXT COLLATE "C" NOT NULL,
  "endpoint_id" TEXT COLLATE "C" NOT NULL,
  "stream_key" TEXT COLLATE "C" NOT NULL,
  "binding" TEXT COLLATE "C" NOT NULL,
  "launch_revision" BIGINT NOT NULL,
  "delivery_id" TEXT COLLATE "C" NOT NULL,
  "fire_id" TEXT COLLATE "C" NOT NULL,
  "trigger_id" TEXT COLLATE "C",
  "trigger_name_snapshot" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C",
  "launch_owner_key" TEXT COLLATE "C",
  "status" TEXT COLLATE "C" NOT NULL,
  "error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "webhook_mr_launch_guards_pkey" PRIMARY KEY ("id")
);

-- table: webhook_mr_stream_states
CREATE TABLE "agent_workflow"."webhook_mr_stream_states" (
  "endpoint_id" TEXT COLLATE "C" NOT NULL,
  "stream_key" TEXT COLLATE "C" NOT NULL,
  "project_id" TEXT COLLATE "C" NOT NULL,
  "mr_iid" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "last_terminal_revision" BIGINT,
  "last_delivery_id" TEXT COLLATE "C" NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "webhook_mr_stream_states_pkey" PRIMARY KEY ("endpoint_id", "stream_key")
);

-- table: webhook_trigger_fires
CREATE TABLE "agent_workflow"."webhook_trigger_fires" (
  "id" TEXT COLLATE "C" NOT NULL,
  "delivery_id" TEXT COLLATE "C" NOT NULL,
  "trigger_id" TEXT COLLATE "C" NOT NULL,
  "stream_key" TEXT COLLATE "C" NOT NULL,
  "outcome" TEXT COLLATE "C" NOT NULL,
  "superseded_task_id" TEXT COLLATE "C",
  "task_id" TEXT COLLATE "C",
  "employee_case_id" TEXT COLLATE "C",
  "error" TEXT COLLATE "C",
  "fired_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "webhook_trigger_fires_pkey" PRIMARY KEY ("id")
);

-- table: webhook_trigger_streams
CREATE TABLE "agent_workflow"."webhook_trigger_streams" (
  "trigger_id" TEXT COLLATE "C" NOT NULL,
  "stream_key" TEXT COLLATE "C" NOT NULL,
  "consecutive_fires" BIGINT NOT NULL DEFAULT 0,
  "last_fire_at" BIGINT,
  "reset_at" BIGINT,
  "reset_by" TEXT COLLATE "C",
  CONSTRAINT "webhook_trigger_streams_pkey" PRIMARY KEY ("trigger_id", "stream_key")
);

-- table: webhook_triggers
CREATE TABLE "agent_workflow"."webhook_triggers" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "endpoint_id" TEXT COLLATE "C" NOT NULL,
  "owner_user_id" TEXT COLLATE "C" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "repo_scope" TEXT COLLATE "C" NOT NULL,
  "event_types" TEXT COLLATE "C" NOT NULL,
  "branch_filter" TEXT COLLATE "C",
  "command_prefix" TEXT COLLATE "C",
  "ignore_usernames" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "launch_kind" TEXT COLLATE "C" NOT NULL,
  "launch_ref_id" TEXT COLLATE "C" NOT NULL,
  "launch_payload" TEXT COLLATE "C" NOT NULL,
  "template_syntax_version" BIGINT NOT NULL DEFAULT 1,
  "max_consecutive_fires" BIGINT NOT NULL DEFAULT 3,
  "auto_register_repos" BOOLEAN NOT NULL DEFAULT TRUE,
  "cancel_on_mr_terminal" BOOLEAN NOT NULL DEFAULT FALSE,
  "last_fired_at" BIGINT,
  "last_status" TEXT COLLATE "C",
  "last_error" TEXT COLLATE "C",
  "last_task_id" TEXT COLLATE "C",
  "consecutive_failures" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "webhook_triggers_pkey" PRIMARY KEY ("id")
);

-- table: workflows
CREATE TABLE "agent_workflow"."workflows" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "description" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "definition" TEXT COLLATE "C" NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 1,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "builtin" BOOLEAN NOT NULL DEFAULT FALSE,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- table: workgroup_assignments
CREATE TABLE "agent_workflow"."workgroup_assignments" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "round" BIGINT NOT NULL DEFAULT 0,
  "source" TEXT COLLATE "C" NOT NULL,
  "created_by_run_id" TEXT COLLATE "C",
  "created_by_user_id" TEXT COLLATE "C",
  "assignee_member_id" TEXT COLLATE "C",
  "title" TEXT COLLATE "C" NOT NULL,
  "brief_md" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "status" TEXT COLLATE "C" NOT NULL,
  "node_run_id" TEXT COLLATE "C",
  "result_message_id" TEXT COLLATE "C",
  "dedup_key" TEXT COLLATE "C",
  "attempt_count" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "workgroup_assignments_pkey" PRIMARY KEY ("id")
);

-- table: workgroup_member_cursors
CREATE TABLE "agent_workflow"."workgroup_member_cursors" (
  "task_id" TEXT COLLATE "C" NOT NULL,
  "member_id" TEXT COLLATE "C" NOT NULL,
  "last_consumed_message_id" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "workgroup_member_cursors_pkey" PRIMARY KEY ("task_id", "member_id")
);

-- table: workgroup_members
CREATE TABLE "agent_workflow"."workgroup_members" (
  "id" TEXT COLLATE "C" NOT NULL,
  "workgroup_id" TEXT COLLATE "C" NOT NULL,
  "member_type" TEXT COLLATE "C" NOT NULL,
  "agent_name" TEXT COLLATE "C",
  "agent_id" TEXT COLLATE "C",
  "user_id" TEXT COLLATE "C",
  "display_name" TEXT COLLATE "C" NOT NULL,
  "role_desc" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "sort_order" BIGINT NOT NULL DEFAULT 0,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "workgroup_members_pkey" PRIMARY KEY ("id")
);

-- table: workgroup_messages
CREATE TABLE "agent_workflow"."workgroup_messages" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "round" BIGINT NOT NULL DEFAULT 0,
  "author_kind" TEXT COLLATE "C" NOT NULL,
  "author_member_id" TEXT COLLATE "C",
  "author_user_id" TEXT COLLATE "C",
  "kind" TEXT COLLATE "C" NOT NULL,
  "body_md" TEXT COLLATE "C" NOT NULL,
  "template_key" TEXT COLLATE "C",
  "template_params_json" TEXT COLLATE "C",
  "mentions_json" TEXT COLLATE "C" NOT NULL DEFAULT '[]',
  "assignment_id" TEXT COLLATE "C",
  "trigger_message_id" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "workgroup_messages_pkey" PRIMARY KEY ("id")
);

-- table: workgroup_task_state
CREATE TABLE "agent_workflow"."workgroup_task_state" (
  "task_id" TEXT COLLATE "C" NOT NULL,
  "gate_status" TEXT COLLATE "C" NOT NULL DEFAULT 'idle',
  "gate_summary" TEXT COLLATE "C",
  "gate_rejected_comment" TEXT COLLATE "C",
  "pause_reason" TEXT COLLATE "C",
  "dw_state_json" TEXT COLLATE "C",
  "result_message_id" TEXT COLLATE "C",
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "workgroup_task_state_pkey" PRIMARY KEY ("task_id")
);

-- table: workgroups
CREATE TABLE "agent_workflow"."workgroups" (
  "id" TEXT COLLATE "C" NOT NULL,
  "name" TEXT COLLATE "C" NOT NULL,
  "description" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "instructions" TEXT COLLATE "C" NOT NULL DEFAULT '',
  "mode" TEXT COLLATE "C" NOT NULL DEFAULT 'leader_worker',
  "output_contract" TEXT COLLATE "C" NOT NULL DEFAULT 'files',
  "leader_member_id" TEXT COLLATE "C",
  "share_outputs" BOOLEAN NOT NULL DEFAULT TRUE,
  "direct_messages" BOOLEAN NOT NULL DEFAULT FALSE,
  "blackboard" BOOLEAN NOT NULL DEFAULT FALSE,
  "max_rounds" BIGINT NOT NULL DEFAULT 20,
  "completion_gate" BOOLEAN NOT NULL DEFAULT FALSE,
  "clarify_budget" BIGINT NOT NULL DEFAULT 3,
  "fan_out" BOOLEAN NOT NULL DEFAULT FALSE,
  "version" BIGINT NOT NULL DEFAULT 1,
  "owner_user_id" TEXT COLLATE "C",
  "visibility" TEXT COLLATE "C" NOT NULL DEFAULT 'public',
  "acl_revision" BIGINT NOT NULL DEFAULT 0,
  "schema_version" BIGINT NOT NULL DEFAULT 1,
  "created_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  "updated_at" BIGINT NOT NULL DEFAULT (extract(epoch from clock_timestamp()) * 1000)::bigint,
  CONSTRAINT "workgroups_pkey" PRIMARY KEY ("id")
);

-- index: action_templates:index:action_templates_owner_name_unique
CREATE UNIQUE INDEX "action_templates_owner_name_unique" ON "agent_workflow"."action_templates" (COALESCE("owner_user_id", ''), "name");

-- index: agents:index:agents_owner_name_unique
CREATE UNIQUE INDEX "agents_owner_name_unique" ON "agent_workflow"."agents" (COALESCE("owner_user_id", ''), "name");

-- index: automation_policies:index:automation_policies_owner_name_unique
CREATE UNIQUE INDEX "automation_policies_owner_name_unique" ON "agent_workflow"."automation_policies" (COALESCE("owner_user_id", ''), "name");

-- index: cached_repos:index:idx_cached_repos_fetched_id
CREATE INDEX "idx_cached_repos_fetched_id" ON "agent_workflow"."cached_repos" ("last_fetched_at", "id");

-- index: cached_repos:index:idx_cached_repos_submodule_health
CREATE INDEX "idx_cached_repos_submodule_health" ON "agent_workflow"."cached_repos" ("has_submodules", "last_submodule_sync_ok");

-- index: capability_templates:index:capability_templates_owner_name_unique
CREATE UNIQUE INDEX "capability_templates_owner_name_unique" ON "agent_workflow"."capability_templates" ("owner_user_id", "name");

-- index: capability_templates:index:idx_capability_templates_capability
CREATE INDEX "idx_capability_templates_capability" ON "agent_workflow"."capability_templates" ("capability");

-- index: capability_templates:index:idx_capability_templates_upstream
CREATE INDEX "idx_capability_templates_upstream" ON "agent_workflow"."capability_templates" ("upstream_id");

-- index: clarify_rounds:index:idx_clarify_rounds_task
CREATE INDEX "idx_clarify_rounds_task" ON "agent_workflow"."clarify_rounds" ("task_id");

-- index: clarify_rounds:index:idx_clarify_rounds_kind_status
CREATE INDEX "idx_clarify_rounds_kind_status" ON "agent_workflow"."clarify_rounds" ("kind", "status");

-- index: clarify_rounds:index:idx_clarify_rounds_asking
CREATE INDEX "idx_clarify_rounds_asking" ON "agent_workflow"."clarify_rounds" ("asking_node_id", "loop_iter", "iteration");

-- index: clarify_rounds:index:idx_clarify_rounds_intermediary
CREATE INDEX "idx_clarify_rounds_intermediary" ON "agent_workflow"."clarify_rounds" ("intermediary_node_id", "loop_iter", "iteration");

-- index: clarify_rounds:index:idx_clarify_rounds_target_consumer
CREATE INDEX "idx_clarify_rounds_target_consumer" ON "agent_workflow"."clarify_rounds" ("target_consumer_node_id", "status");

-- index: code_ai_attempts:index:uniq_code_ai_attempts_identity
CREATE UNIQUE INDEX "uniq_code_ai_attempts_identity" ON "agent_workflow"."code_ai_attempts" ("round_id", "stage_name", "shard_key", "rerun_seq", "attempt_seq");

-- index: code_ai_attempts:index:idx_code_ai_attempts_round
CREATE INDEX "idx_code_ai_attempts_round" ON "agent_workflow"."code_ai_attempts" ("round_id");

-- index: code_ai_attempts:index:idx_code_ai_attempts_status
CREATE INDEX "idx_code_ai_attempts_status" ON "agent_workflow"."code_ai_attempts" ("status");

-- index: code_ai_attempts:index:idx_code_ai_attempts_started
CREATE INDEX "idx_code_ai_attempts_started" ON "agent_workflow"."code_ai_attempts" ("started_at");

-- index: code_findings:index:uniq_code_finding_identity
CREATE UNIQUE INDEX "uniq_code_finding_identity" ON "agent_workflow"."code_findings" ("code_host_endpoint_id", "stable_project_id", "anchor_kind", "anchor_id", "fingerprint", "generation");

-- index: code_findings:index:idx_code_findings_anchor
CREATE INDEX "idx_code_findings_anchor" ON "agent_workflow"."code_findings" ("code_host_endpoint_id", "stable_project_id", "anchor_kind", "anchor_id", "lifecycle");

-- index: code_findings:index:idx_code_findings_seen
CREATE INDEX "idx_code_findings_seen" ON "agent_workflow"."code_findings" ("stable_project_id", "last_seen_at");

-- index: code_findings:index:idx_code_findings_external_created
CREATE INDEX "idx_code_findings_external_created" ON "agent_workflow"."code_findings" ("created_at") WHERE "external_id" IS NOT NULL;

-- index: code_round_stages:index:uniq_code_round_stages_seq
CREATE UNIQUE INDEX "uniq_code_round_stages_seq" ON "agent_workflow"."code_round_stages" ("round_id", "stage_seq");

-- index: code_round_stages:index:idx_code_round_stages_round
CREATE INDEX "idx_code_round_stages_round" ON "agent_workflow"."code_round_stages" ("round_id");

-- index: code_trigger_deliveries:index:idx_code_trigger_deliveries_project
CREATE INDEX "idx_code_trigger_deliveries_project" ON "agent_workflow"."code_trigger_deliveries" ("stable_project_id", "created_at");

-- index: code_trigger_deliveries:index:idx_code_trigger_deliveries_correlation
CREATE INDEX "idx_code_trigger_deliveries_correlation" ON "agent_workflow"."code_trigger_deliveries" ("correlation_id");

-- index: code_trigger_deliveries:index:idx_code_trigger_deliveries_outcome
CREATE INDEX "idx_code_trigger_deliveries_outcome" ON "agent_workflow"."code_trigger_deliveries" ("outcome", "created_at");

-- index: code_work_items:index:uniq_code_work_items_identity
CREATE UNIQUE INDEX "uniq_code_work_items_identity" ON "agent_workflow"."code_work_items" ("code_host_endpoint_id", "stable_project_id", "capability", "anchor_kind", "anchor_id");

-- index: code_work_items:index:idx_code_work_items_status
CREATE INDEX "idx_code_work_items_status" ON "agent_workflow"."code_work_items" ("status");

-- index: code_work_items:index:idx_code_work_items_created
CREATE INDEX "idx_code_work_items_created" ON "agent_workflow"."code_work_items" ("created_at");

-- index: code_work_items:index:idx_code_work_items_anchor
CREATE INDEX "idx_code_work_items_anchor" ON "agent_workflow"."code_work_items" ("code_host_endpoint_id", "stable_project_id", "anchor_kind", "anchor_id");

-- index: code_work_rounds:index:uniq_code_work_rounds_seq
CREATE UNIQUE INDEX "uniq_code_work_rounds_seq" ON "agent_workflow"."code_work_rounds" ("work_item_id", "round_seq");

-- index: code_work_rounds:index:idx_code_work_rounds_item
CREATE INDEX "idx_code_work_rounds_item" ON "agent_workflow"."code_work_rounds" ("work_item_id");

-- index: code_work_rounds:index:idx_code_work_rounds_task
CREATE INDEX "idx_code_work_rounds_task" ON "agent_workflow"."code_work_rounds" ("task_id");

-- index: code_work_rounds:index:idx_code_work_rounds_started
CREATE INDEX "idx_code_work_rounds_started" ON "agent_workflow"."code_work_rounds" ("started_at");

-- index: collaboration_gate_artifacts:index:idx_collaboration_gate_artifacts_final_path
CREATE UNIQUE INDEX "idx_collaboration_gate_artifacts_final_path" ON "agent_workflow"."collaboration_gate_artifacts" ("final_path");

-- index: collaboration_gate_artifacts:index:idx_collaboration_gate_artifacts_state
CREATE INDEX "idx_collaboration_gate_artifacts_state" ON "agent_workflow"."collaboration_gate_artifacts" ("state", "updated_at");

-- index: collaboration_gate_operations:index:idx_collaboration_gate_operations_idempotency
CREATE UNIQUE INDEX "idx_collaboration_gate_operations_idempotency" ON "agent_workflow"."collaboration_gate_operations" ("task_id", "gate_kind", "operation_kind", "idempotency_key");

-- index: collaboration_gate_operations:index:idx_collaboration_gate_operations_revision
CREATE UNIQUE INDEX "idx_collaboration_gate_operations_revision" ON "agent_workflow"."collaboration_gate_operations" ("gate_kind", "gate_ref", "result_gate_revision") WHERE "result_gate_revision" IS NOT NULL;

-- index: collaboration_gate_operations:index:idx_collaboration_gate_operations_one_active
CREATE UNIQUE INDEX "idx_collaboration_gate_operations_one_active" ON "agent_workflow"."collaboration_gate_operations" ("task_id", "gate_kind", "gate_ref", "operation_kind") WHERE "state" IN ('preparing', 'prepared', 'committed', 'cleanup_pending');

-- index: collaboration_gate_operations:index:idx_collaboration_gate_operations_recovery
CREATE INDEX "idx_collaboration_gate_operations_recovery" ON "agent_workflow"."collaboration_gate_operations" ("state", "claim_expires_at", "updated_at");

-- index: collaboration_gate_operations:index:idx_collaboration_gate_operations_task_gate
CREATE INDEX "idx_collaboration_gate_operations_task_gate" ON "agent_workflow"."collaboration_gate_operations" ("task_id", "gate_kind", "gate_ref", "created_at");

-- index: committed_event_deliveries:index:idx_committed_event_deliveries_due
CREATE INDEX "idx_committed_event_deliveries_due" ON "agent_workflow"."committed_event_deliveries" ("state", "next_attempt_at", "claim_expires_at", "created_at");

-- index: committed_event_deliveries:index:idx_committed_event_deliveries_consumer_state
CREATE INDEX "idx_committed_event_deliveries_consumer_state" ON "agent_workflow"."committed_event_deliveries" ("consumer_id", "state", "updated_at");

-- index: committed_events:index:committed_events_aggregate_seq_unique
CREATE UNIQUE INDEX "committed_events_aggregate_seq_unique" ON "agent_workflow"."committed_events" ("producer", "family", "aggregate_kind", "aggregate_id", "aggregate_seq");

-- index: committed_events:index:committed_events_group_ordinal_unique
CREATE UNIQUE INDEX "committed_events_group_ordinal_unique" ON "agent_workflow"."committed_events" ("event_group_id", "event_group_ordinal");

-- index: committed_events:index:idx_committed_events_operation
CREATE INDEX "idx_committed_events_operation" ON "agent_workflow"."committed_events" ("producer", "family", "operation_ref");

-- index: committed_events:index:idx_committed_events_aggregate
CREATE INDEX "idx_committed_events_aggregate" ON "agent_workflow"."committed_events" ("producer", "family", "aggregate_kind", "aggregate_id", "aggregate_seq");

-- index: custom_event_source_definitions:index:idx_custom_event_sources_state
CREATE INDEX "idx_custom_event_sources_state" ON "agent_workflow"."custom_event_source_definitions" ("retired_at", "updated_at");

-- index: custom_event_source_revisions:index:idx_custom_event_source_revisions
CREATE INDEX "idx_custom_event_source_revisions" ON "agent_workflow"."custom_event_source_revisions" ("source_id", "revision");

-- index: development_action_runs:index:dev_action_runs_decision_unique
CREATE UNIQUE INDEX "dev_action_runs_decision_unique" ON "agent_workflow"."development_action_runs" ("decision_id");

-- index: development_action_runs:index:dev_action_runs_single_writable
CREATE UNIQUE INDEX "dev_action_runs_single_writable" ON "agent_workflow"."development_action_runs" ("mission_id") WHERE "writable" = 1 AND "status" IN ('claimed','materializing','running','validating','awaiting-effect');

-- index: development_adapter_definitions:index:development_adapter_definitions_owner_name_unique
CREATE UNIQUE INDEX "development_adapter_definitions_owner_name_unique" ON "agent_workflow"."development_adapter_definitions" (COALESCE("owner_user_id", ''), "name");

-- index: development_agent_attempts:index:dev_agent_attempts_ordinal_unique
CREATE UNIQUE INDEX "dev_agent_attempts_ordinal_unique" ON "agent_workflow"."development_agent_attempts" ("action_run_id", "rerun_seq", "attempt_seq");

-- index: development_agent_attempts:index:idx_dev_agent_attempts_execution_ref
CREATE INDEX "idx_dev_agent_attempts_execution_ref" ON "agent_workflow"."development_agent_attempts" ("execution_ref");

-- index: development_approval_sagas:index:dev_approval_sagas_idem_unique
CREATE UNIQUE INDEX "dev_approval_sagas_idem_unique" ON "agent_workflow"."development_approval_sagas" ("idempotency_key");

-- index: development_approval_sagas:index:idx_dev_approval_sagas_mission
CREATE INDEX "idx_dev_approval_sagas_mission" ON "agent_workflow"."development_approval_sagas" ("mission_id");

-- index: development_approval_sagas:index:idx_dev_approval_sagas_correlation
CREATE INDEX "idx_dev_approval_sagas_correlation" ON "agent_workflow"."development_approval_sagas" ("correlation_ref");

-- index: development_bundle_refs:index:idx_dev_bundle_refs_mission
CREATE INDEX "idx_dev_bundle_refs_mission" ON "agent_workflow"."development_bundle_refs" ("mission_id");

-- index: development_decisions:index:dev_decisions_input_unique
CREATE UNIQUE INDEX "dev_decisions_input_unique" ON "agent_workflow"."development_decisions" ("mission_id", "decision_input_digest");

-- index: development_deferred_wakes:index:dev_deferred_wakes_decision_unique
CREATE UNIQUE INDEX "dev_deferred_wakes_decision_unique" ON "agent_workflow"."development_deferred_wakes" ("mission_id", "decision_id");

-- index: development_deferred_wakes:index:idx_dev_deferred_wakes_due
CREATE INDEX "idx_dev_deferred_wakes_due" ON "agent_workflow"."development_deferred_wakes" ("resume_at") WHERE "state" = 'armed';

-- index: development_effects:index:dev_effects_idempotency_unique
CREATE UNIQUE INDEX "dev_effects_idempotency_unique" ON "agent_workflow"."development_effects" ("idempotency_key");

-- index: development_effects:index:idx_dev_effects_mission_state
CREATE INDEX "idx_dev_effects_mission_state" ON "agent_workflow"."development_effects" ("mission_id", "state");

-- index: development_effects:index:idx_dev_effects_prepared
CREATE INDEX "idx_dev_effects_prepared" ON "agent_workflow"."development_effects" ("created_at") WHERE "state" = 'prepared';

-- index: development_fact_snapshots:index:idx_dev_fact_snapshots_mission
CREATE INDEX "idx_dev_fact_snapshots_mission" ON "agent_workflow"."development_fact_snapshots" ("mission_id");

-- index: development_feedback_ledger:index:dev_feedback_ledger_unique
CREATE UNIQUE INDEX "dev_feedback_ledger_unique" ON "agent_workflow"."development_feedback_ledger" ("mission_id", "thread_ref", "revision", "head_sha");

-- index: development_mission_links:index:dev_mission_links_idem_unique
CREATE UNIQUE INDEX "dev_mission_links_idem_unique" ON "agent_workflow"."development_mission_links" ("idempotency_key");

-- index: development_mission_links:index:idx_dev_mission_links_parent
CREATE INDEX "idx_dev_mission_links_parent" ON "agent_workflow"."development_mission_links" ("parent_mission_id");

-- index: development_mission_links:index:dev_mission_links_child_unique
CREATE UNIQUE INDEX "dev_mission_links_child_unique" ON "agent_workflow"."development_mission_links" ("child_mission_id");

-- index: development_mission_sources:index:idx_dev_mission_sources_mission
CREATE INDEX "idx_dev_mission_sources_mission" ON "agent_workflow"."development_mission_sources" ("mission_id");

-- index: development_missions:index:development_missions_launch_idem_unique
CREATE UNIQUE INDEX "development_missions_launch_idem_unique" ON "agent_workflow"."development_missions" ("launch_idempotency_key") WHERE "launch_idempotency_key" IS NOT NULL;

-- index: development_missions:index:idx_development_missions_status
CREATE INDEX "idx_development_missions_status" ON "agent_workflow"."development_missions" ("status");

-- index: development_missions:index:idx_development_missions_status_employee
CREATE INDEX "idx_development_missions_status_employee" ON "agent_workflow"."development_missions" ("status", "employee_id");

-- index: development_missions:index:idx_development_missions_repo
CREATE INDEX "idx_development_missions_repo" ON "agent_workflow"."development_missions" ("repository_id");

-- index: development_missions:index:idx_development_missions_created
CREATE INDEX "idx_development_missions_created" ON "agent_workflow"."development_missions" ("created_at");

-- index: development_missions:index:idx_development_missions_created_id
CREATE INDEX "idx_development_missions_created_id" ON "agent_workflow"."development_missions" ("created_at", "id");

-- index: development_missions:index:idx_development_missions_open
CREATE INDEX "idx_development_missions_open" ON "agent_workflow"."development_missions" ("created_at", "id") WHERE "terminal_at" IS NULL;

-- index: development_missions:index:idx_development_missions_fenced
CREATE INDEX "idx_development_missions_fenced" ON "agent_workflow"."development_missions" ("id") WHERE "transition_fence" != 'none';

-- index: development_mr_claims:index:dev_mr_claims_active_unique
CREATE UNIQUE INDEX "dev_mr_claims_active_unique" ON "agent_workflow"."development_mr_claims" ("code_host_endpoint_ref", "stable_project_ref", "mr_iid") WHERE "state" = 'active';

-- index: development_mr_claims:index:idx_dev_mr_claims_lookup
CREATE INDEX "idx_dev_mr_claims_lookup" ON "agent_workflow"."development_mr_claims" ("code_host_endpoint_ref", "stable_project_ref", "mr_iid");

-- index: development_repository_upload_plan_entries:index:dev_upload_plan_target_unique
CREATE UNIQUE INDEX "dev_upload_plan_target_unique" ON "agent_workflow"."development_repository_upload_plan_entries" ("plan_id", "repository_target_path");

-- index: development_repository_upload_receipts:index:dev_upload_receipts_unique
CREATE UNIQUE INDEX "dev_upload_receipts_unique" ON "agent_workflow"."development_repository_upload_receipts" ("plan_id", "baseline_snapshot_ref", "receipt_kind");

-- index: development_step_joins:index:idx_dev_step_joins_pending
CREATE INDEX "idx_dev_step_joins_pending" ON "agent_workflow"."development_step_joins" ("mission_id", "settled_result");

-- index: development_step_runs:index:dev_step_runs_replay_unique
CREATE UNIQUE INDEX "dev_step_runs_replay_unique" ON "agent_workflow"."development_step_runs" ("mission_id", "employee_id", "employee_revision", "step_id", "attempt", "input_digest");

-- index: development_step_runs:index:idx_dev_step_runs_mission_state
CREATE INDEX "idx_dev_step_runs_mission_state" ON "agent_workflow"."development_step_runs" ("mission_id", "state");

-- index: development_step_runs:index:idx_dev_step_runs_action
CREATE INDEX "idx_dev_step_runs_action" ON "agent_workflow"."development_step_runs" ("action_run_id");

-- index: development_wake_hints:index:dev_wake_hints_delivery_unique
CREATE UNIQUE INDEX "dev_wake_hints_delivery_unique" ON "agent_workflow"."development_wake_hints" ("mission_id", "delivery_key");

-- index: development_wake_hints:index:idx_dev_wake_hints_unconsumed
CREATE INDEX "idx_dev_wake_hints_unconsumed" ON "agent_workflow"."development_wake_hints" ("mission_id") WHERE "consumed_at" IS NULL;

-- index: digital_employees:index:digital_employees_owner_name_unique
CREATE UNIQUE INDEX "digital_employees_owner_name_unique" ON "agent_workflow"."digital_employees" (COALESCE("owner_user_id", ''), "name");

-- index: doc_versions:index:idx_doc_versions_review_run
CREATE INDEX "idx_doc_versions_review_run" ON "agent_workflow"."doc_versions" ("review_node_run_id", "version_index");

-- index: doc_versions:index:idx_doc_versions_task
CREATE INDEX "idx_doc_versions_task" ON "agent_workflow"."doc_versions" ("task_id");

-- index: doc_versions:index:idx_doc_versions_review_item
CREATE INDEX "idx_doc_versions_review_item" ON "agent_workflow"."doc_versions" ("review_node_run_id", "item_index");

-- index: doc_versions:index:idx_doc_versions_pending_created
CREATE INDEX "idx_doc_versions_pending_created" ON "agent_workflow"."doc_versions" ("created_at") WHERE "decision" = 'pending';

-- index: employee_approval_sagas:index:employee_approval_sagas_idempotency_unique
CREATE UNIQUE INDEX "employee_approval_sagas_idempotency_unique" ON "agent_workflow"."employee_approval_sagas" ("idempotency_key");

-- index: employee_approval_sagas:index:employee_approval_sagas_correlation_unique
CREATE UNIQUE INDEX "employee_approval_sagas_correlation_unique" ON "agent_workflow"."employee_approval_sagas" ("adapter_id", "adapter_revision", "correlation_ref") WHERE "correlation_ref" is not null;

-- index: employee_approval_sagas:index:idx_employee_approval_sagas_case_state
CREATE INDEX "idx_employee_approval_sagas_case_state" ON "agent_workflow"."employee_approval_sagas" ("case_id", "latest_status", "updated_at");

-- index: employee_attention_bindings:index:employee_attention_desired_identity_unique
CREATE UNIQUE INDEX "employee_attention_desired_identity_unique" ON "agent_workflow"."employee_attention_bindings" ("desired_identity_key");

-- index: employee_attention_bindings:index:idx_employee_attention_case_state
CREATE INDEX "idx_employee_attention_case_state" ON "agent_workflow"."employee_attention_bindings" ("case_id", "state", "updated_at");

-- index: employee_case_event_origins:index:employee_case_event_origins_delivery_unique
CREATE UNIQUE INDEX "employee_case_event_origins_delivery_unique" ON "agent_workflow"."employee_case_event_origins" ("event_delivery_id");

-- index: employee_case_event_origins:index:idx_employee_case_event_origins_subscription
CREATE INDEX "idx_employee_case_event_origins_subscription" ON "agent_workflow"."employee_case_event_origins" ("event_subscription_id", "created_at");

-- index: employee_case_inbox:index:employee_case_inbox_delivery_unique
CREATE UNIQUE INDEX "employee_case_inbox_delivery_unique" ON "agent_workflow"."employee_case_inbox" ("delivery_id");

-- index: employee_case_inbox:index:idx_employee_case_inbox_queue
CREATE INDEX "idx_employee_case_inbox_queue" ON "agent_workflow"."employee_case_inbox" ("case_id", "state", "priority", "occurred_at", "event_id");

-- index: employee_case_members:index:idx_employee_case_members_user
CREATE INDEX "idx_employee_case_members_user" ON "agent_workflow"."employee_case_members" ("user_id", "case_id");

-- index: employee_case_metering_receipts:index:idx_employee_case_metering_case
CREATE INDEX "idx_employee_case_metering_case" ON "agent_workflow"."employee_case_metering_receipts" ("case_id", "created_at");

-- index: employee_case_workspaces:index:idx_employee_case_workspaces_repo_state
CREATE INDEX "idx_employee_case_workspaces_repo_state" ON "agent_workflow"."employee_case_workspaces" ("repository_id", "state", "updated_at");

-- index: employee_cases:index:idx_employee_cases_employee_state
CREATE INDEX "idx_employee_cases_employee_state" ON "agent_workflow"."employee_cases" ("employee_id", "employee_revision", "state", "updated_at");

-- index: employee_cases:index:idx_employee_cases_state_employee_terminal
CREATE INDEX "idx_employee_cases_state_employee_terminal" ON "agent_workflow"."employee_cases" ("state", "employee_id", "terminal_kind");

-- index: employee_cases:index:idx_employee_cases_owner_origin_updated
CREATE INDEX "idx_employee_cases_owner_origin_updated" ON "agent_workflow"."employee_cases" ("owner_user_id", "launch_origin", "updated_at", "id");

-- index: employee_change_candidates:index:employee_change_candidates_round_unique
CREATE UNIQUE INDEX "employee_change_candidates_round_unique" ON "agent_workflow"."employee_change_candidates" ("round_id");

-- index: employee_change_candidates:index:idx_employee_change_candidates_case_state
CREATE INDEX "idx_employee_change_candidates_case_state" ON "agent_workflow"."employee_change_candidates" ("case_id", "state", "updated_at");

-- index: employee_channel_results:index:employee_channel_results_identity_unique
CREATE UNIQUE INDEX "employee_channel_results_identity_unique" ON "agent_workflow"."employee_channel_results" ("channel_id", "milestone_type", "envelope_digest");

-- index: employee_channels:index:employee_channels_invocation_unique
CREATE UNIQUE INDEX "employee_channels_invocation_unique" ON "agent_workflow"."employee_channels" ("invocation_id");

-- index: employee_context_links:index:employee_context_links_identity_unique
CREATE UNIQUE INDEX "employee_context_links_identity_unique" ON "agent_workflow"."employee_context_links" ("case_id", "from_context_id", "relation", "to_context_id");

-- index: employee_context_records:index:idx_employee_context_case_type
CREATE INDEX "idx_employee_context_case_type" ON "agent_workflow"."employee_context_records" ("case_id", "type_id", "lifecycle_state");

-- index: employee_definitions:index:employee_definitions_owner_name_unique
CREATE UNIQUE INDEX "employee_definitions_owner_name_unique" ON "agent_workflow"."employee_definitions" (COALESCE("owner_user_id", ''), "name");

-- index: employee_definitions:index:idx_employee_definitions_type
CREATE INDEX "idx_employee_definitions_type" ON "agent_workflow"."employee_definitions" ("type_id", "type_revision", "archived_at");

-- index: employee_input_uploads:index:employee_input_uploads_actor_idempotency_unique
CREATE UNIQUE INDEX "employee_input_uploads_actor_idempotency_unique" ON "agent_workflow"."employee_input_uploads" (COALESCE("actor_user_id", ''), "upload_idempotency_key") WHERE "upload_idempotency_key" IS NOT NULL;

-- index: employee_input_uploads:index:idx_employee_input_uploads_expiry
CREATE INDEX "idx_employee_input_uploads_expiry" ON "agent_workflow"."employee_input_uploads" ("state", "expires_at");

-- index: employee_invocations:index:employee_invocations_idempotency_unique
CREATE UNIQUE INDEX "employee_invocations_idempotency_unique" ON "agent_workflow"."employee_invocations" ("idempotency_key");

-- index: employee_invocations:index:idx_employee_invocations_parent_state
CREATE INDEX "idx_employee_invocations_parent_state" ON "agent_workflow"."employee_invocations" ("parent_case_id", "state", "deadline_at");

-- index: employee_job_templates:index:employee_job_templates_owner_type_name_unique
CREATE UNIQUE INDEX "employee_job_templates_owner_type_name_unique" ON "agent_workflow"."employee_job_templates" (COALESCE("owner_user_id", ''), "type_id", "type_revision", "name");

-- index: employee_os_outbox:index:employee_os_outbox_dedupe_unique
CREATE UNIQUE INDEX "employee_os_outbox_dedupe_unique" ON "agent_workflow"."employee_os_outbox" ("dedupe_key");

-- index: employee_os_outbox:index:idx_employee_os_outbox_due
CREATE INDEX "idx_employee_os_outbox_due" ON "agent_workflow"."employee_os_outbox" ("state", "next_attempt_at", "claim_expires_at");

-- index: employee_reaction_rounds:index:employee_reaction_rounds_inbox_unique
CREATE UNIQUE INDEX "employee_reaction_rounds_inbox_unique" ON "agent_workflow"."employee_reaction_rounds" ("inbox_id");

-- index: employee_reaction_rounds:index:employee_reaction_rounds_one_active
CREATE UNIQUE INDEX "employee_reaction_rounds_one_active" ON "agent_workflow"."employee_reaction_rounds" ("case_id") WHERE "state" IN ('planned', 'running', 'settling');

-- index: employee_reaction_rounds:index:idx_employee_reaction_rounds_execution
CREATE INDEX "idx_employee_reaction_rounds_execution" ON "agent_workflow"."employee_reaction_rounds" ("execution_ref", "state");

-- index: employee_round_workspace_states:index:idx_employee_round_workspace_case
CREATE INDEX "idx_employee_round_workspace_case" ON "agent_workflow"."employee_round_workspace_states" ("case_id", "created_at");

-- index: employee_tool_registration_revisions:index:idx_employee_tool_revisions_state
CREATE INDEX "idx_employee_tool_revisions_state" ON "agent_workflow"."employee_tool_registration_revisions" ("state", "tool_id", "revision");

-- index: employee_tool_registrations:index:idx_employee_tools_node
CREATE INDEX "idx_employee_tools_node" ON "agent_workflow"."employee_tool_registrations" ("type_id", "type_revision", "work_item_ref", "retired_at");

-- index: employee_type_packages:index:idx_employee_type_packages_state
CREATE INDEX "idx_employee_type_packages_state" ON "agent_workflow"."employee_type_packages" ("state", "type_id", "revision");

-- index: event_deliveries:index:event_deliveries_event_subscription_unique
CREATE UNIQUE INDEX "event_deliveries_event_subscription_unique" ON "agent_workflow"."event_deliveries" ("event_id", "subscription_id");

-- index: event_deliveries:index:idx_event_deliveries_pending
CREATE INDEX "idx_event_deliveries_pending" ON "agent_workflow"."event_deliveries" ("subscriber_kind", "subscriber_ref", "state", "next_attempt_at", "created_at");

-- index: event_deliveries:index:idx_event_deliveries_due
CREATE INDEX "idx_event_deliveries_due" ON "agent_workflow"."event_deliveries" ("subscriber_kind", "state", "next_attempt_at", "claim_expires_at");

-- index: event_observer_runs:index:idx_event_observer_runs_source
CREATE INDEX "idx_event_observer_runs_source" ON "agent_workflow"."event_observer_runs" ("source_id", "source_revision", "started_at");

-- index: event_records:index:event_records_source_dedupe_unique
CREATE UNIQUE INDEX "event_records_source_dedupe_unique" ON "agent_workflow"."event_records" ("source_id", "source_revision", "dedupe_key");

-- index: event_records:index:idx_event_records_subject
CREATE INDEX "idx_event_records_subject" ON "agent_workflow"."event_records" ("subject_type", "subject_ref", "occurred_at");

-- index: event_records:index:idx_event_records_audit
CREATE INDEX "idx_event_records_audit" ON "agent_workflow"."event_records" ("observed_at", "id");

-- index: event_records:index:idx_event_records_source_audit
CREATE INDEX "idx_event_records_source_audit" ON "agent_workflow"."event_records" ("source_id", "observed_at", "id");

-- index: event_response_rules:index:idx_event_response_rules_event
CREATE INDEX "idx_event_response_rules_event" ON "agent_workflow"."event_response_rules" ("enabled", "source_id", "source_revision", "event_type_id", "event_type_revision");

-- index: event_response_rules:index:idx_event_response_rules_owner
CREATE INDEX "idx_event_response_rules_owner" ON "agent_workflow"."event_response_rules" ("owner_user_id", "updated_at");

-- index: event_subscriptions:index:event_subscriptions_active_identity_unique
CREATE UNIQUE INDEX "event_subscriptions_active_identity_unique" ON "agent_workflow"."event_subscriptions" ("active_identity_key") WHERE "active_identity_key" IS NOT NULL;

-- index: event_subscriptions:index:idx_event_subscriptions_fanout
CREATE INDEX "idx_event_subscriptions_fanout" ON "agent_workflow"."event_subscriptions" ("event_type_id", "event_type_revision", "subject_type", "subject_ref", "state");

-- index: event_subscriptions:index:idx_event_subscriptions_subscriber
CREATE INDEX "idx_event_subscriptions_subscriber" ON "agent_workflow"."event_subscriptions" ("subscriber_kind", "subscriber_ref", "state");

-- index: event_subscriptions:index:idx_event_subscriptions_mode
CREATE INDEX "idx_event_subscriptions_mode" ON "agent_workflow"."event_subscriptions" ("mode", "state", "updated_at");

-- index: event_subscriptions:index:idx_event_subscriptions_audit
CREATE INDEX "idx_event_subscriptions_audit" ON "agent_workflow"."event_subscriptions" ("mode", "updated_at", "id");

-- index: event_type_catalog:index:idx_event_type_source
CREATE INDEX "idx_event_type_source" ON "agent_workflow"."event_type_catalog" ("source_id", "source_revision", "state");

-- index: fusions:index:idx_fusions_skill
CREATE INDEX "idx_fusions_skill" ON "agent_workflow"."fusions" ("skill_id");

-- index: fusions:index:idx_fusions_status
CREATE INDEX "idx_fusions_status" ON "agent_workflow"."fusions" ("status");

-- index: intent_apply_journal:index:uniq_intent_apply_journal_mutation
CREATE UNIQUE INDEX "uniq_intent_apply_journal_mutation" ON "agent_workflow"."intent_apply_journal" ("session_id", "client_mutation_id");

-- index: intent_apply_journal:index:idx_intent_apply_journal_session
CREATE INDEX "idx_intent_apply_journal_session" ON "agent_workflow"."intent_apply_journal" ("session_id");

-- index: intent_apply_journal:index:idx_intent_apply_journal_state
CREATE INDEX "idx_intent_apply_journal_state" ON "agent_workflow"."intent_apply_journal" ("state");

-- index: intent_draft_resolutions:index:idx_intent_draft_resolutions_session
CREATE INDEX "idx_intent_draft_resolutions_session" ON "agent_workflow"."intent_draft_resolutions" ("session_id", "created_at");

-- index: intent_drafts:index:uniq_intent_drafts_session_revision
CREATE UNIQUE INDEX "uniq_intent_drafts_session_revision" ON "agent_workflow"."intent_drafts" ("session_id", "revision");

-- index: intent_drafts:index:idx_intent_drafts_session
CREATE INDEX "idx_intent_drafts_session" ON "agent_workflow"."intent_drafts" ("session_id");

-- index: intent_provenance:index:idx_intent_provenance_resource
CREATE INDEX "idx_intent_provenance_resource" ON "agent_workflow"."intent_provenance" ("resource_type", "resource_id");

-- index: intent_provenance:index:idx_intent_provenance_session
CREATE INDEX "idx_intent_provenance_session" ON "agent_workflow"."intent_provenance" ("session_id");

-- index: intent_sessions:index:idx_intent_sessions_owner
CREATE INDEX "idx_intent_sessions_owner" ON "agent_workflow"."intent_sessions" ("owner_user_id");

-- index: intent_sessions:index:idx_intent_sessions_owner_status
CREATE INDEX "idx_intent_sessions_owner_status" ON "agent_workflow"."intent_sessions" ("owner_user_id", "status");

-- index: intent_turn_events:index:uniq_intent_turn_events_turn_seq
CREATE UNIQUE INDEX "uniq_intent_turn_events_turn_seq" ON "agent_workflow"."intent_turn_events" ("turn_id", "event_seq");

-- index: intent_turn_events:index:uniq_intent_turn_events_external
CREATE UNIQUE INDEX "uniq_intent_turn_events_external" ON "agent_workflow"."intent_turn_events" ("turn_id", "source", "external_event_id");

-- index: intent_turn_events:index:idx_intent_turn_events_turn
CREATE INDEX "idx_intent_turn_events_turn" ON "agent_workflow"."intent_turn_events" ("turn_id", "event_seq");

-- index: intent_turns:index:uniq_intent_turns_session_seq
CREATE UNIQUE INDEX "uniq_intent_turns_session_seq" ON "agent_workflow"."intent_turns" ("session_id", "seq");

-- index: intent_turns:index:uniq_intent_turns_session_mutation
CREATE UNIQUE INDEX "uniq_intent_turns_session_mutation" ON "agent_workflow"."intent_turns" ("session_id", "client_mutation_id") WHERE "client_mutation_id" IS NOT NULL;

-- index: intent_turns:index:idx_intent_turns_session
CREATE INDEX "idx_intent_turns_session" ON "agent_workflow"."intent_turns" ("session_id");

-- index: intent_working_set_changes:index:uniq_intent_working_set_mutation
CREATE UNIQUE INDEX "uniq_intent_working_set_mutation" ON "agent_workflow"."intent_working_set_changes" ("session_id", "client_mutation_id");

-- index: intent_working_set_changes:index:uniq_intent_working_set_unresolved
CREATE UNIQUE INDEX "uniq_intent_working_set_unresolved" ON "agent_workflow"."intent_working_set_changes" ("session_id") WHERE "state" IN ('queued', 'applying', 'failed');

-- index: intent_working_set_changes:index:idx_intent_working_set_session
CREATE INDEX "idx_intent_working_set_session" ON "agent_workflow"."intent_working_set_changes" ("session_id", "created_at");

-- index: intent_working_set_changes:index:idx_intent_working_set_state
CREATE INDEX "idx_intent_working_set_state" ON "agent_workflow"."intent_working_set_changes" ("state", "updated_at");

-- index: lifecycle_alerts:index:idx_lifecycle_alerts_task
CREATE INDEX "idx_lifecycle_alerts_task" ON "agent_workflow"."lifecycle_alerts" ("task_id", "detected_at");

-- index: lifecycle_alerts:index:idx_lifecycle_alerts_open
CREATE INDEX "idx_lifecycle_alerts_open" ON "agent_workflow"."lifecycle_alerts" ("resolved_at", "severity");

-- index: lifecycle_repair_audit:index:idx_lifecycle_repair_audit_task
CREATE INDEX "idx_lifecycle_repair_audit_task" ON "agent_workflow"."lifecycle_repair_audit" ("task_id", "applied_at");

-- index: lifecycle_repair_audit:index:idx_lifecycle_repair_audit_rule
CREATE INDEX "idx_lifecycle_repair_audit_rule" ON "agent_workflow"."lifecycle_repair_audit" ("alert_rule", "applied_at");

-- index: maintenance_runs:index:idx_maintenance_runs_job_slot
CREATE UNIQUE INDEX "idx_maintenance_runs_job_slot" ON "agent_workflow"."maintenance_runs" ("job_key", "slot_key");

-- index: maintenance_runs:index:idx_maintenance_runs_one_running
CREATE UNIQUE INDEX "idx_maintenance_runs_one_running" ON "agent_workflow"."maintenance_runs" ("job_key") WHERE "state" = 'running';

-- index: maintenance_runs:index:idx_maintenance_runs_one_queued
CREATE UNIQUE INDEX "idx_maintenance_runs_one_queued" ON "agent_workflow"."maintenance_runs" ("job_key") WHERE "state" in ('pending','deferred');

-- index: maintenance_runs:index:idx_maintenance_runs_admission
CREATE INDEX "idx_maintenance_runs_admission" ON "agent_workflow"."maintenance_runs" ("state", "job_class", "scheduled_at");

-- index: maintenance_runs:index:idx_maintenance_runs_lease
CREATE INDEX "idx_maintenance_runs_lease" ON "agent_workflow"."maintenance_runs" ("state", "lease_expires_at");

-- index: maintenance_runs:index:idx_maintenance_runs_last
CREATE INDEX "idx_maintenance_runs_last" ON "agent_workflow"."maintenance_runs" ("finished_at", "job_key");

-- index: mcp_runtime_test_create_receipts:index:idx_mcp_runtime_test_create_receipts_expiry
CREATE INDEX "idx_mcp_runtime_test_create_receipts_expiry" ON "agent_workflow"."mcp_runtime_test_create_receipts" ("expires_at");

-- index: mcp_runtime_test_events:index:uniq_mcp_runtime_test_events_session_seq
CREATE UNIQUE INDEX "uniq_mcp_runtime_test_events_session_seq" ON "agent_workflow"."mcp_runtime_test_events" ("test_session_id", "event_seq");

-- index: mcp_runtime_test_events:index:uniq_mcp_runtime_test_events_external
CREATE UNIQUE INDEX "uniq_mcp_runtime_test_events_external" ON "agent_workflow"."mcp_runtime_test_events" ("test_session_id", "external_event_key") WHERE "external_event_key" IS NOT NULL;

-- index: mcp_runtime_test_events:index:idx_mcp_runtime_test_events_session
CREATE INDEX "idx_mcp_runtime_test_events_session" ON "agent_workflow"."mcp_runtime_test_events" ("test_session_id", "event_seq");

-- index: mcp_runtime_test_session_leases:index:uniq_mcp_runtime_test_session_leases_test_session
CREATE UNIQUE INDEX "uniq_mcp_runtime_test_session_leases_test_session" ON "agent_workflow"."mcp_runtime_test_session_leases" ("test_session_id");

-- index: mcp_runtime_test_sessions:index:uniq_mcp_runtime_test_sessions_owner_mcp_live
CREATE UNIQUE INDEX "uniq_mcp_runtime_test_sessions_owner_mcp_live" ON "agent_workflow"."mcp_runtime_test_sessions" ("mcp_id", "owner_user_id") WHERE "status" IN ('active', 'ending');

-- index: mcp_runtime_test_sessions:index:uniq_mcp_runtime_test_sessions_create
CREATE UNIQUE INDEX "uniq_mcp_runtime_test_sessions_create" ON "agent_workflow"."mcp_runtime_test_sessions" ("mcp_id", "owner_user_id", "client_create_id");

-- index: mcp_runtime_test_sessions:index:idx_mcp_runtime_test_sessions_owner_mcp_updated
CREATE INDEX "idx_mcp_runtime_test_sessions_owner_mcp_updated" ON "agent_workflow"."mcp_runtime_test_sessions" ("owner_user_id", "mcp_id", "updated_at");

-- index: mcp_runtime_test_sessions:index:idx_mcp_runtime_test_sessions_idle
CREATE INDEX "idx_mcp_runtime_test_sessions_idle" ON "agent_workflow"."mcp_runtime_test_sessions" ("status", "idle_deadline_at");

-- index: mcp_runtime_test_turns:index:uniq_mcp_runtime_test_turns_session_seq
CREATE UNIQUE INDEX "uniq_mcp_runtime_test_turns_session_seq" ON "agent_workflow"."mcp_runtime_test_turns" ("session_id", "seq");

-- index: mcp_runtime_test_turns:index:uniq_mcp_runtime_test_turns_message
CREATE UNIQUE INDEX "uniq_mcp_runtime_test_turns_message" ON "agent_workflow"."mcp_runtime_test_turns" ("session_id", "client_message_id");

-- index: mcp_runtime_test_turns:index:idx_mcp_runtime_test_turns_session
CREATE INDEX "idx_mcp_runtime_test_turns_session" ON "agent_workflow"."mcp_runtime_test_turns" ("session_id", "seq");

-- index: mcp_runtime_test_turns:index:idx_mcp_runtime_test_turns_status
CREATE INDEX "idx_mcp_runtime_test_turns_status" ON "agent_workflow"."mcp_runtime_test_turns" ("status", "hard_deadline_at");

-- index: mcps:index:mcps_owner_name_unique
CREATE UNIQUE INDEX "mcps_owner_name_unique" ON "agent_workflow"."mcps" (COALESCE("owner_user_id", ''), "name");

-- index: memories:index:idx_memories_scope_status
CREATE INDEX "idx_memories_scope_status" ON "agent_workflow"."memories" ("scope_type", "scope_id", "status");

-- index: memories:index:idx_memories_status_created
CREATE INDEX "idx_memories_status_created" ON "agent_workflow"."memories" ("status", "created_at");

-- index: memories:index:idx_memories_supersedes
CREATE INDEX "idx_memories_supersedes" ON "agent_workflow"."memories" ("supersedes_id");

-- index: memories:index:idx_memories_created
CREATE INDEX "idx_memories_created" ON "agent_workflow"."memories" ("created_at");

-- index: memories:index:idx_memories_source
CREATE INDEX "idx_memories_source" ON "agent_workflow"."memories" ("source_kind", "source_event_id");

-- index: memories:index:idx_memories_fused_skill_id
CREATE INDEX "idx_memories_fused_skill_id" ON "agent_workflow"."memories" ("fused_into_skill_id", "fused_into_skill_version");

-- index: memory_distill_events:index:idx_distill_events_job_attempt
CREATE INDEX "idx_distill_events_job_attempt" ON "agent_workflow"."memory_distill_events" ("distill_job_id", "attempt_index", "ts");

-- index: memory_distill_events:index:idx_distill_events_session
CREATE INDEX "idx_distill_events_session" ON "agent_workflow"."memory_distill_events" ("distill_job_id", "session_id", "ts");

-- index: memory_distill_jobs:index:idx_distill_jobs_status_next
CREATE INDEX "idx_distill_jobs_status_next" ON "agent_workflow"."memory_distill_jobs" ("status", "next_run_at");

-- index: memory_distill_jobs:index:idx_distill_jobs_debounce
CREATE INDEX "idx_distill_jobs_debounce" ON "agent_workflow"."memory_distill_jobs" ("debounce_key", "status");

-- index: memory_distill_jobs:index:idx_distill_jobs_task
CREATE INDEX "idx_distill_jobs_task" ON "agent_workflow"."memory_distill_jobs" ("task_id", "source_kind");

-- index: memory_scope_move_events:index:idx_memory_scope_move_events_memory_version
CREATE UNIQUE INDEX "idx_memory_scope_move_events_memory_version" ON "agent_workflow"."memory_scope_move_events" ("memory_id", "resulting_version");

-- index: memory_scope_move_events:index:idx_memory_scope_move_events_occurred
CREATE INDEX "idx_memory_scope_move_events_occurred" ON "agent_workflow"."memory_scope_move_events" ("occurred_at", "memory_id");

-- index: mission_input_uploads:index:mission_input_uploads_idem_unique
CREATE UNIQUE INDEX "mission_input_uploads_idem_unique" ON "agent_workflow"."mission_input_uploads" ("actor_user_id", "upload_idempotency_key") WHERE "upload_idempotency_key" IS NOT NULL;

-- index: mission_input_uploads:index:idx_mission_input_uploads_state
CREATE INDEX "idx_mission_input_uploads_state" ON "agent_workflow"."mission_input_uploads" ("state", "expires_at");

-- index: node_run_events:index:idx_events_node
CREATE INDEX "idx_events_node" ON "agent_workflow"."node_run_events" ("node_run_id", "id");

-- index: node_run_events:index:idx_events_session
CREATE INDEX "idx_events_session" ON "agent_workflow"."node_run_events" ("node_run_id", "session_id", "id");

-- index: node_runs:index:idx_node_runs_task
CREATE INDEX "idx_node_runs_task" ON "agent_workflow"."node_runs" ("task_id", "node_id", "iteration", "retry_index");

-- index: node_runs:index:idx_node_runs_parent
CREATE INDEX "idx_node_runs_parent" ON "agent_workflow"."node_runs" ("parent_node_run_id");

-- index: node_runs:index:idx_node_runs_child_task
CREATE INDEX "idx_node_runs_child_task" ON "agent_workflow"."node_runs" ("child_task_id");

-- index: node_runs:index:idx_node_runs_status_active
CREATE INDEX "idx_node_runs_status_active" ON "agent_workflow"."node_runs" ("status", "started_at");

-- index: observer_activations:index:idx_observer_activations_due
CREATE INDEX "idx_observer_activations_due" ON "agent_workflow"."observer_activations" ("state", "next_scan_at", "lease_expires_at");

-- index: oidc_providers:index:idx_oidc_providers_enabled
CREATE INDEX "idx_oidc_providers_enabled" ON "agent_workflow"."oidc_providers" ("enabled");

-- index: plugins:index:plugins_owner_name_unique
CREATE UNIQUE INDEX "plugins_owner_name_unique" ON "agent_workflow"."plugins" (COALESCE("owner_user_id", ''), "name");

-- index: recovery_events:index:idx_recovery_events_task
CREATE INDEX "idx_recovery_events_task" ON "agent_workflow"."recovery_events" ("task_id", "created_at");

-- index: recovery_events:index:idx_recovery_events_kind
CREATE INDEX "idx_recovery_events_kind" ON "agent_workflow"."recovery_events" ("kind", "created_at");

-- index: repo_capability_config:index:uniq_repo_capability_cell
CREATE UNIQUE INDEX "uniq_repo_capability_cell" ON "agent_workflow"."repo_capability_config" ("repo_id", "capability");

-- index: repo_capability_config:index:idx_repo_capability_template
CREATE INDEX "idx_repo_capability_template" ON "agent_workflow"."repo_capability_config" ("template_id");

-- index: repo_capability_config:index:idx_repo_capability_readiness
CREATE INDEX "idx_repo_capability_readiness" ON "agent_workflow"."repo_capability_config" ("readiness");

-- index: repo_group_nodes:index:idx_rgn_cached_repo
CREATE INDEX "idx_rgn_cached_repo" ON "agent_workflow"."repo_group_nodes" ("cached_repo_id");

-- index: repo_group_nodes:index:idx_rgn_child_group
CREATE INDEX "idx_rgn_child_group" ON "agent_workflow"."repo_group_nodes" ("child_group_id");

-- index: repository_employee_assignments:index:repository_employee_assignments_scope_unique
CREATE UNIQUE INDEX "repository_employee_assignments_scope_unique" ON "agent_workflow"."repository_employee_assignments" ("scope_kind", COALESCE("scope_ref", ''));

-- index: repository_transport_connections:index:repository_transport_connections_provider_generation_uq
CREATE UNIQUE INDEX "repository_transport_connections_provider_generation_uq" ON "agent_workflow"."repository_transport_connections" ("provider", "connection_generation");

-- index: resource_bundle_applies:index:uniq_resource_bundle_applies_key
CREATE UNIQUE INDEX "uniq_resource_bundle_applies_key" ON "agent_workflow"."resource_bundle_applies" ("scope", "key");

-- index: resource_bundle_applies:index:idx_resource_bundle_applies_state
CREATE INDEX "idx_resource_bundle_applies_state" ON "agent_workflow"."resource_bundle_applies" ("state");

-- index: resource_bundle_applies:index:idx_resource_bundle_applies_actor
CREATE INDEX "idx_resource_bundle_applies_actor" ON "agent_workflow"."resource_bundle_applies" ("actor_user_id");

-- index: resource_grants:index:idx_resource_grants_user
CREATE INDEX "idx_resource_grants_user" ON "agent_workflow"."resource_grants" ("user_id");

-- index: review_comments:index:idx_review_comments_version
CREATE INDEX "idx_review_comments_version" ON "agent_workflow"."review_comments" ("doc_version_id", "anchor_section_path");

-- index: review_node_reviewers:index:idx_review_node_reviewers_actor
CREATE INDEX "idx_review_node_reviewers_actor" ON "agent_workflow"."review_node_reviewers" ("reviewer_user_id", "task_id", "review_node_id");

-- index: review_node_reviewers:index:idx_review_node_reviewers_node
CREATE INDEX "idx_review_node_reviewers_node" ON "agent_workflow"."review_node_reviewers" ("task_id", "review_node_id");

-- index: runtime_session_leases:index:idx_runtime_session_leases_task
CREATE INDEX "idx_runtime_session_leases_task" ON "agent_workflow"."runtime_session_leases" ("task_id");

-- index: runtime_session_leases:index:idx_runtime_session_leases_created_run
CREATE INDEX "idx_runtime_session_leases_created_run" ON "agent_workflow"."runtime_session_leases" ("created_node_run_id");

-- index: runtime_session_leases:index:idx_runtime_session_leases_lease_run
CREATE INDEX "idx_runtime_session_leases_lease_run" ON "agent_workflow"."runtime_session_leases" ("lease_node_run_id");

-- index: scheduled_tasks:index:idx_scheduled_tasks_due
CREATE INDEX "idx_scheduled_tasks_due" ON "agent_workflow"."scheduled_tasks" ("enabled", "next_run_at");

-- index: scheduled_tasks:index:idx_scheduled_tasks_owner
CREATE INDEX "idx_scheduled_tasks_owner" ON "agent_workflow"."scheduled_tasks" ("owner_user_id");

-- index: skill_operations:index:uq_skill_operations_active
CREATE UNIQUE INDEX "uq_skill_operations_active" ON "agent_workflow"."skill_operations" ("skill_id") WHERE "active" = 1;

-- index: skill_versions:index:uq_skill_versions_skill_v
CREATE UNIQUE INDEX "uq_skill_versions_skill_v" ON "agent_workflow"."skill_versions" ("skill_id", "version_index");

-- index: skill_versions:index:idx_skill_versions_created
CREATE INDEX "idx_skill_versions_created" ON "agent_workflow"."skill_versions" ("created_at");

-- index: skill_versions:index:idx_skill_versions_fusion
CREATE INDEX "idx_skill_versions_fusion" ON "agent_workflow"."skill_versions" ("fusion_id");

-- index: skills:index:skills_owner_name_unique
CREATE UNIQUE INDEX "skills_owner_name_unique" ON "agent_workflow"."skills" (COALESCE("owner_user_id", ''), "name");

-- index: task_archive_audit:index:idx_task_archive_audit_created
CREATE INDEX "idx_task_archive_audit_created" ON "agent_workflow"."task_archive_audit" ("created_at");

-- index: task_collaborators:index:idx_task_collab_user
CREATE INDEX "idx_task_collab_user" ON "agent_workflow"."task_collaborators" ("user_id");

-- index: task_collaborators:index:idx_task_collab_task
CREATE INDEX "idx_task_collab_task" ON "agent_workflow"."task_collaborators" ("task_id");

-- index: task_execution_effect_attempts:index:idx_task_execution_attempts_effect_no
CREATE UNIQUE INDEX "idx_task_execution_attempts_effect_no" ON "agent_workflow"."task_execution_effect_attempts" ("effect_id", "attempt_no");

-- index: task_execution_effect_attempts:index:idx_task_execution_attempts_one_active
CREATE UNIQUE INDEX "idx_task_execution_attempts_one_active" ON "agent_workflow"."task_execution_effect_attempts" ("effect_id") WHERE "state" IN ('prepared', 'acting', 'recovery-required');

-- index: task_execution_effect_fences:index:idx_task_execution_effect_fences_active_key
CREATE UNIQUE INDEX "idx_task_execution_effect_fences_active_key" ON "agent_workflow"."task_execution_effect_fences" ("fence_key") WHERE "released_at" IS NULL;

-- index: task_execution_effects:index:idx_task_execution_effects_task_operation_generation
CREATE UNIQUE INDEX "idx_task_execution_effects_task_operation_generation" ON "agent_workflow"."task_execution_effects" ("task_id", "operation_key", "operation_generation");

-- index: task_execution_effects:index:idx_task_execution_effects_lineage_family_generation
CREATE UNIQUE INDEX "idx_task_execution_effects_lineage_family_generation" ON "agent_workflow"."task_execution_effects" ("execution_lineage_id", "operation_family_key", "operation_generation");

-- index: task_execution_effects:index:idx_task_execution_effects_task_state
CREATE INDEX "idx_task_execution_effects_task_state" ON "agent_workflow"."task_execution_effects" ("task_id", "state");

-- index: task_execution_intents:index:idx_task_execution_intents_task_state
CREATE INDEX "idx_task_execution_intents_task_state" ON "agent_workflow"."task_execution_intents" ("task_id", "state");

-- index: task_execution_intents:index:idx_task_execution_intents_pending_task
CREATE UNIQUE INDEX "idx_task_execution_intents_pending_task" ON "agent_workflow"."task_execution_intents" ("task_id") WHERE "state" = 'pending';

-- index: task_execution_intents:index:idx_task_execution_intents_claimed_task
CREATE UNIQUE INDEX "idx_task_execution_intents_claimed_task" ON "agent_workflow"."task_execution_intents" ("task_id") WHERE "state" = 'claimed';

-- index: task_execution_lineage_operation_records:index:idx_task_execution_lineage_watermark
CREATE UNIQUE INDEX "idx_task_execution_lineage_watermark" ON "agent_workflow"."task_execution_lineage_operation_records" ("execution_lineage_id", "operation_family_key") WHERE "record_kind" = 'generation-watermark';

-- index: task_execution_lineage_operation_records:index:idx_task_execution_lineage_decision
CREATE UNIQUE INDEX "idx_task_execution_lineage_decision" ON "agent_workflow"."task_execution_lineage_operation_records" ("execution_lineage_id", "operation_family_key", "operation_generation") WHERE "record_kind" = 'replay-decision';

-- index: task_execution_lineage_operation_records:index:idx_task_execution_lineage_decision_state
CREATE INDEX "idx_task_execution_lineage_decision_state" ON "agent_workflow"."task_execution_lineage_operation_records" ("record_kind", "decision_state", "updated_at");

-- index: task_execution_maintenance_claims:index:idx_task_execution_maintenance_state_updated
CREATE INDEX "idx_task_execution_maintenance_state_updated" ON "agent_workflow"."task_execution_maintenance_claims" ("state", "updated_at");

-- index: task_execution_maintenance_members:index:idx_task_execution_maintenance_members_active_task
CREATE UNIQUE INDEX "idx_task_execution_maintenance_members_active_task" ON "agent_workflow"."task_execution_maintenance_members" ("task_id") WHERE "released_at" IS NULL;

-- index: task_execution_owners:index:idx_task_execution_owners_state_lease
CREATE INDEX "idx_task_execution_owners_state_lease" ON "agent_workflow"."task_execution_owners" ("state", "lease_until");

-- index: task_feedback:index:idx_task_feedback_task
CREATE INDEX "idx_task_feedback_task" ON "agent_workflow"."task_feedback" ("task_id", "created_at");

-- index: task_node_clarify_directives:index:idx_task_node_clarify_directives_task
CREATE INDEX "idx_task_node_clarify_directives_task" ON "agent_workflow"."task_node_clarify_directives" ("task_id");

-- index: task_questions:index:idx_task_questions_task
CREATE INDEX "idx_task_questions_task" ON "agent_workflow"."task_questions" ("task_id");

-- index: task_questions:index:idx_task_questions_origin
CREATE INDEX "idx_task_questions_origin" ON "agent_workflow"."task_questions" ("origin_node_run_id");

-- index: task_questions:index:uniq_task_questions_identity
CREATE UNIQUE INDEX "uniq_task_questions_identity" ON "agent_workflow"."task_questions" ("origin_node_run_id", "question_id", "role_kind");

-- index: task_repos:index:idx_task_repos_repo_path
CREATE INDEX "idx_task_repos_repo_path" ON "agent_workflow"."task_repos" ("repo_path");

-- index: task_repos:index:idx_task_repos_repo_url
CREATE INDEX "idx_task_repos_repo_url" ON "agent_workflow"."task_repos" ("repo_url");

-- index: task_repos:index:idx_task_repos_cached_repo_id
CREATE INDEX "idx_task_repos_cached_repo_id" ON "agent_workflow"."task_repos" ("cached_repo_id");

-- index: task_repos:index:idx_task_repos_cached_repo_task
CREATE INDEX "idx_task_repos_cached_repo_task" ON "agent_workflow"."task_repos" ("cached_repo_id", "task_id");

-- index: tasks:index:idx_tasks_live
CREATE INDEX "idx_tasks_live" ON "agent_workflow"."tasks" ("id") WHERE "deleted_at" is null;

-- index: tasks:index:idx_tasks_list_started_id
CREATE INDEX "idx_tasks_list_started_id" ON "agent_workflow"."tasks" ("started_at", "id");

-- index: tasks:index:idx_tasks_branch_started_id
CREATE INDEX "idx_tasks_branch_started_id" ON "agent_workflow"."tasks" ("branch_started_at", "id");

-- index: tasks:index:idx_tasks_cached_repo
CREATE INDEX "idx_tasks_cached_repo" ON "agent_workflow"."tasks" ("cached_repo_id");

-- index: tasks:index:idx_tasks_status_finished
CREATE INDEX "idx_tasks_status_finished" ON "agent_workflow"."tasks" ("status", "finished_at");

-- index: tasks:index:idx_tasks_source_agent
CREATE INDEX "idx_tasks_source_agent" ON "agent_workflow"."tasks" ("source_agent_id");

-- index: tasks:index:idx_tasks_code_round
CREATE INDEX "idx_tasks_code_round" ON "agent_workflow"."tasks" ("code_round_id");

-- index: tasks:index:idx_tasks_digital_employee_round
CREATE INDEX "idx_tasks_digital_employee_round" ON "agent_workflow"."tasks" ("digital_employee_round_id");

-- index: tasks:index:idx_tasks_list_status_started_id
CREATE INDEX "idx_tasks_list_status_started_id" ON "agent_workflow"."tasks" ("status", "started_at", "id");

-- index: tasks:index:idx_tasks_list_parent_started_id
CREATE INDEX "idx_tasks_list_parent_started_id" ON "agent_workflow"."tasks" ("parent_task_id", "started_at", "id");

-- index: tasks:index:idx_tasks_list_owner_started_id
CREATE INDEX "idx_tasks_list_owner_started_id" ON "agent_workflow"."tasks" ("owner_user_id", "started_at", "id");

-- index: tasks:index:idx_tasks_workflow
CREATE INDEX "idx_tasks_workflow" ON "agent_workflow"."tasks" ("workflow_id", "started_at");

-- index: tasks:index:idx_tasks_scheduled_task
CREATE INDEX "idx_tasks_scheduled_task" ON "agent_workflow"."tasks" ("scheduled_task_id");

-- index: tasks:index:idx_tasks_webhook_trigger
CREATE INDEX "idx_tasks_webhook_trigger" ON "agent_workflow"."tasks" ("webhook_trigger_id");

-- index: tasks:index:idx_tasks_event_subscription
CREATE INDEX "idx_tasks_event_subscription" ON "agent_workflow"."tasks" ("event_subscription_id");

-- index: tasks:index:idx_tasks_event_delivery_unique
CREATE UNIQUE INDEX "idx_tasks_event_delivery_unique" ON "agent_workflow"."tasks" ("event_delivery_id") WHERE "event_delivery_id" IS NOT NULL;

-- index: tasks:index:idx_tasks_source_termination
CREATE INDEX "idx_tasks_source_termination" ON "agent_workflow"."tasks" ("source_termination_binding", "source_termination_launch_rev");

-- index: token_audit:index:idx_token_audit_user_created
CREATE INDEX "idx_token_audit_user_created" ON "agent_workflow"."token_audit" ("user_id", "created_at");

-- index: token_audit:index:idx_token_audit_pat_created
CREATE INDEX "idx_token_audit_pat_created" ON "agent_workflow"."token_audit" ("pat_id", "created_at");

-- index: token_audit:index:idx_token_audit_created
CREATE INDEX "idx_token_audit_created" ON "agent_workflow"."token_audit" ("created_at");

-- index: token_delete_snapshot:index:idx_token_delete_snapshot_audit
CREATE INDEX "idx_token_delete_snapshot_audit" ON "agent_workflow"."token_delete_snapshot" ("audit_id");

-- index: token_delete_snapshot:index:idx_token_delete_snapshot_created
CREATE INDEX "idx_token_delete_snapshot_created" ON "agent_workflow"."token_delete_snapshot" ("created_at");

-- index: user_access_audit:index:idx_user_access_audit_target_revision
CREATE INDEX "idx_user_access_audit_target_revision" ON "agent_workflow"."user_access_audit" ("target_user_id", "access_revision");

-- index: user_access_audit:index:idx_user_access_audit_created
CREATE INDEX "idx_user_access_audit_created" ON "agent_workflow"."user_access_audit" ("created_at");

-- index: user_access_audit:index:idx_user_access_audit_operation
CREATE INDEX "idx_user_access_audit_operation" ON "agent_workflow"."user_access_audit" ("operation_id");

-- index: user_identities:index:idx_user_identities_user
CREATE INDEX "idx_user_identities_user" ON "agent_workflow"."user_identities" ("user_id");

-- index: user_identities:index:idx_user_identities_provider
CREATE INDEX "idx_user_identities_provider" ON "agent_workflow"."user_identities" ("provider_id");

-- index: user_pats:index:idx_user_pats_user
CREATE INDEX "idx_user_pats_user" ON "agent_workflow"."user_pats" ("user_id");

-- index: user_permission_grants:index:idx_user_permission_grants_permission
CREATE INDEX "idx_user_permission_grants_permission" ON "agent_workflow"."user_permission_grants" ("permission");

-- index: user_repository_transport_credentials:index:idx_user_repository_transport_credentials_provider_generation
CREATE INDEX "idx_user_repository_transport_credentials_provider_generation" ON "agent_workflow"."user_repository_transport_credentials" ("provider", "connection_generation");

-- index: user_sessions:index:idx_user_sessions_user
CREATE INDEX "idx_user_sessions_user" ON "agent_workflow"."user_sessions" ("user_id", "expires_at");

-- index: users:index:idx_users_status
CREATE INDEX "idx_users_status" ON "agent_workflow"."users" ("status");

-- index: verification_profiles:index:verification_profiles_owner_name_unique
CREATE UNIQUE INDEX "verification_profiles_owner_name_unique" ON "agent_workflow"."verification_profiles" (COALESCE("owner_user_id", ''), "name");

-- index: webhook_deliveries:index:idx_webhook_deliveries_endpoint_time
CREATE INDEX "idx_webhook_deliveries_endpoint_time" ON "agent_workflow"."webhook_deliveries" ("endpoint_id", "received_at");

-- index: webhook_deliveries:index:idx_webhook_deliveries_received_at
CREATE INDEX "idx_webhook_deliveries_received_at" ON "agent_workflow"."webhook_deliveries" ("received_at");

-- index: webhook_deliveries:index:idx_webhook_deliveries_status_time
CREATE INDEX "idx_webhook_deliveries_status_time" ON "agent_workflow"."webhook_deliveries" ("status", "received_at");

-- index: webhook_deliveries:index:idx_webhook_deliveries_event_time
CREATE INDEX "idx_webhook_deliveries_event_time" ON "agent_workflow"."webhook_deliveries" ("event_type", "received_at");

-- index: webhook_deliveries:index:idx_webhook_deliveries_repo_time
CREATE INDEX "idx_webhook_deliveries_repo_time" ON "agent_workflow"."webhook_deliveries" ("repo_path", "received_at");

-- index: webhook_endpoints:index:idx_webhook_endpoints_url_token
CREATE UNIQUE INDEX "idx_webhook_endpoints_url_token" ON "agent_workflow"."webhook_endpoints" ("url_token");

-- index: webhook_mr_control_effects:index:idx_webhook_mr_effect_delivery
CREATE UNIQUE INDEX "idx_webhook_mr_effect_delivery" ON "agent_workflow"."webhook_mr_control_effects" ("delivery_id");

-- index: webhook_mr_control_effects:index:idx_webhook_mr_effect_stream_revision
CREATE UNIQUE INDEX "idx_webhook_mr_effect_stream_revision" ON "agent_workflow"."webhook_mr_control_effects" ("endpoint_id", "stream_key", "revision");

-- index: webhook_mr_control_effects:index:idx_webhook_mr_effect_due
CREATE INDEX "idx_webhook_mr_effect_due" ON "agent_workflow"."webhook_mr_control_effects" ("status", "next_attempt_at");

-- index: webhook_mr_control_targets:index:idx_webhook_mr_target_task
CREATE INDEX "idx_webhook_mr_target_task" ON "agent_workflow"."webhook_mr_control_targets" ("task_id");

-- index: webhook_mr_launch_guards:index:idx_webhook_mr_guard_stream_revision
CREATE INDEX "idx_webhook_mr_guard_stream_revision" ON "agent_workflow"."webhook_mr_launch_guards" ("endpoint_id", "stream_key", "launch_revision");

-- index: webhook_mr_launch_guards:index:idx_webhook_mr_guard_task
CREATE INDEX "idx_webhook_mr_guard_task" ON "agent_workflow"."webhook_mr_launch_guards" ("task_id");

-- index: webhook_mr_launch_guards:index:idx_webhook_mr_guard_status
CREATE INDEX "idx_webhook_mr_guard_status" ON "agent_workflow"."webhook_mr_launch_guards" ("status", "updated_at");

-- index: webhook_mr_stream_states:index:idx_webhook_mr_stream_endpoint_state
CREATE INDEX "idx_webhook_mr_stream_endpoint_state" ON "agent_workflow"."webhook_mr_stream_states" ("endpoint_id", "state");

-- index: webhook_trigger_fires:index:idx_webhook_fires_trigger_time
CREATE INDEX "idx_webhook_fires_trigger_time" ON "agent_workflow"."webhook_trigger_fires" ("trigger_id", "fired_at");

-- index: webhook_trigger_fires:index:idx_webhook_fires_delivery
CREATE INDEX "idx_webhook_fires_delivery" ON "agent_workflow"."webhook_trigger_fires" ("delivery_id");

-- index: webhook_trigger_fires:index:idx_webhook_fires_stream
CREATE INDEX "idx_webhook_fires_stream" ON "agent_workflow"."webhook_trigger_fires" ("trigger_id", "stream_key", "fired_at");

-- index: webhook_triggers:index:idx_webhook_triggers_endpoint_enabled
CREATE INDEX "idx_webhook_triggers_endpoint_enabled" ON "agent_workflow"."webhook_triggers" ("endpoint_id", "enabled");

-- index: webhook_triggers:index:idx_webhook_triggers_owner
CREATE INDEX "idx_webhook_triggers_owner" ON "agent_workflow"."webhook_triggers" ("owner_user_id");

-- index: workgroup_assignments:index:idx_wg_assign_task
CREATE INDEX "idx_wg_assign_task" ON "agent_workflow"."workgroup_assignments" ("task_id", "status");

-- index: workgroup_members:index:uq_workgroup_members_display
CREATE UNIQUE INDEX "uq_workgroup_members_display" ON "agent_workflow"."workgroup_members" ("workgroup_id", "display_name");

-- index: workgroup_members:index:idx_workgroup_members_group
CREATE INDEX "idx_workgroup_members_group" ON "agent_workflow"."workgroup_members" ("workgroup_id");

-- index: workgroup_messages:index:idx_wg_msg_task
CREATE INDEX "idx_wg_msg_task" ON "agent_workflow"."workgroup_messages" ("task_id", "id");

-- index: workgroups:index:workgroups_owner_name_unique
CREATE UNIQUE INDEX "workgroups_owner_name_unique" ON "agent_workflow"."workgroups" (COALESCE("owner_user_id", ''), "name");

-- constraint: action_template_revisions:fk:action_template_revisions_template_id_action_templates_id_fk
ALTER TABLE "agent_workflow"."action_template_revisions" ADD CONSTRAINT "action_template_revisions_template_id_action_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "agent_workflow"."action_templates" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: automation_policy_revisions:fk:automation_policy_revisions_policy_id_automation_policies_id_fk
ALTER TABLE "agent_workflow"."automation_policy_revisions" ADD CONSTRAINT "automation_policy_revisions_policy_id_automation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "agent_workflow"."automation_policies" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: cached_repos:unique:cached_repos_url_hash_unique
ALTER TABLE "agent_workflow"."cached_repos" ADD CONSTRAINT "cached_repos_url_hash_unique" UNIQUE ("url_hash");

-- constraint: clarify_rounds:fk:clarify_rounds_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."clarify_rounds" ADD CONSTRAINT "clarify_rounds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: clarify_rounds:fk:clarify_rounds_asking_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."clarify_rounds" ADD CONSTRAINT "clarify_rounds_asking_node_run_id_node_runs_id_fk" FOREIGN KEY ("asking_node_run_id") REFERENCES "agent_workflow"."node_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: clarify_rounds:fk:clarify_rounds_intermediary_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."clarify_rounds" ADD CONSTRAINT "clarify_rounds_intermediary_node_run_id_node_runs_id_fk" FOREIGN KEY ("intermediary_node_run_id") REFERENCES "agent_workflow"."node_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: collaboration_gate_artifacts:check:collaboration_gate_artifacts_byte_size_nonnegative
ALTER TABLE "agent_workflow"."collaboration_gate_artifacts" ADD CONSTRAINT "collaboration_gate_artifacts_byte_size_nonnegative" CHECK ("byte_size" >= 0);

-- constraint: collaboration_gate_artifacts:check:collaboration_gate_artifacts_receipt_json_valid
ALTER TABLE "agent_workflow"."collaboration_gate_artifacts" ADD CONSTRAINT "collaboration_gate_artifacts_receipt_json_valid" CHECK ("receipt_json" IS NULL OR json_valid("receipt_json"));

-- constraint: collaboration_gate_artifacts:fk:collaboration_gate_artifacts_operation_id_collaboration_gate_operations_id_fk
ALTER TABLE "agent_workflow"."collaboration_gate_artifacts" ADD CONSTRAINT "collaboration_gate_artifacts_operation_id_collabor_4d082f595e5b" FOREIGN KEY ("operation_id") REFERENCES "agent_workflow"."collaboration_gate_operations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_task_revision_nonnegative
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_task_revision_nonnegative" CHECK ("expected_task_revision" >= 0);

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_gate_revision_nonnegative
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_gate_revision_nonnegative" CHECK ("expected_gate_revision" >= 0);

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_result_revision_next
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_result_revision_next" CHECK ("result_gate_revision" IS NULL OR "result_gate_revision" = "expected_gate_revision" + 1);

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_claim_epoch_nonnegative
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_claim_epoch_nonnegative" CHECK ("claim_epoch" >= 0);

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_schema_version_positive
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_schema_version_positive" CHECK ("schema_version" > 0);

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_manifest_json_valid
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_manifest_json_valid" CHECK (json_valid("manifest_json"));

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_receipt_json_valid
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_receipt_json_valid" CHECK ("receipt_json" IS NULL OR json_valid("receipt_json"));

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_failure_json_valid
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_failure_json_valid" CHECK ("failure_json" IS NULL OR json_valid("failure_json"));

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_committed_shape
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_committed_shape" CHECK ("state" <> 'committed' OR ("result_gate_revision" IS NOT NULL AND "receipt_json" IS NOT NULL AND "committed_at" IS NOT NULL));

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_completed_shape
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_completed_shape" CHECK ("state" <> 'completed' OR ("failure_json" IS NOT NULL OR ("result_gate_revision" IS NOT NULL AND "receipt_json" IS NOT NULL AND "committed_at" IS NOT NULL)));

-- constraint: collaboration_gate_operations:check:collaboration_gate_operations_failed_shape
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_failed_shape" CHECK ("state" <> 'failed' OR "failure_json" IS NOT NULL);

-- constraint: collaboration_gate_operations:fk:collaboration_gate_operations_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."collaboration_gate_operations" ADD CONSTRAINT "collaboration_gate_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: committed_event_aggregate_heads:check:committed_event_aggregate_heads_last_seq_positive
ALTER TABLE "agent_workflow"."committed_event_aggregate_heads" ADD CONSTRAINT "committed_event_aggregate_heads_last_seq_positive" CHECK ("last_seq" > 0);

-- constraint: committed_event_deliveries:check:committed_event_deliveries_attempt_nonnegative
ALTER TABLE "agent_workflow"."committed_event_deliveries" ADD CONSTRAINT "committed_event_deliveries_attempt_nonnegative" CHECK ("attempt_count" >= 0);

-- constraint: committed_event_deliveries:check:committed_event_deliveries_lease_epoch_nonnegative
ALTER TABLE "agent_workflow"."committed_event_deliveries" ADD CONSTRAINT "committed_event_deliveries_lease_epoch_nonnegative" CHECK ("lease_epoch" >= 0);

-- constraint: committed_event_deliveries:check:committed_event_deliveries_replay_generation_nonnegative
ALTER TABLE "agent_workflow"."committed_event_deliveries" ADD CONSTRAINT "committed_event_deliveries_replay_generation_nonnegative" CHECK ("replay_generation" >= 0);

-- constraint: committed_event_deliveries:fk:committed_event_deliveries_event_id_committed_events_id_fk
ALTER TABLE "agent_workflow"."committed_event_deliveries" ADD CONSTRAINT "committed_event_deliveries_event_id_committed_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "agent_workflow"."committed_events" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: committed_event_family_cutovers:check:committed_event_family_cutovers_epoch_positive
ALTER TABLE "agent_workflow"."committed_event_family_cutovers" ADD CONSTRAINT "committed_event_family_cutovers_epoch_positive" CHECK ("epoch" > 0);

-- constraint: committed_events:check:committed_events_schema_v1
ALTER TABLE "agent_workflow"."committed_events" ADD CONSTRAINT "committed_events_schema_v1" CHECK ("schema_version" = 1);

-- constraint: committed_events:check:committed_events_group_ordinal_nonnegative
ALTER TABLE "agent_workflow"."committed_events" ADD CONSTRAINT "committed_events_group_ordinal_nonnegative" CHECK ("event_group_ordinal" >= 0);

-- constraint: committed_events:check:committed_events_aggregate_seq_positive
ALTER TABLE "agent_workflow"."committed_events" ADD CONSTRAINT "committed_events_aggregate_seq_positive" CHECK ("aggregate_seq" > 0);

-- constraint: committed_events:check:committed_events_producer_epoch_positive
ALTER TABLE "agent_workflow"."committed_events" ADD CONSTRAINT "committed_events_producer_epoch_positive" CHECK ("producer_epoch" > 0);

-- constraint: committed_events:check:committed_events_payload_json_valid
ALTER TABLE "agent_workflow"."committed_events" ADD CONSTRAINT "committed_events_payload_json_valid" CHECK (json_valid("payload_json"));

-- constraint: committed_events:check:committed_events_payload_digest_shape
ALTER TABLE "agent_workflow"."committed_events" ADD CONSTRAINT "committed_events_payload_digest_shape" CHECK (length("payload_digest") = 64 OR "payload_digest" = 'canonical-hex-v1:' || lower(hex("payload_json")));

-- constraint: custom_event_source_revisions:fk:custom_event_source_revisions_source_id_custom_event_source_definitions_id_fk
ALTER TABLE "agent_workflow"."custom_event_source_revisions" ADD CONSTRAINT "custom_event_source_revisions_source_id_custom_eve_0ff963268a83" FOREIGN KEY ("source_id") REFERENCES "agent_workflow"."custom_event_source_definitions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_action_runs:fk:development_action_runs_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_action_runs" ADD CONSTRAINT "development_action_runs_mission_id_development_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_adapter_definition_revisions:fk:development_adapter_definition_revisions_adapter_id_development_adapter_definitions_id_fk
ALTER TABLE "agent_workflow"."development_adapter_definition_revisions" ADD CONSTRAINT "development_adapter_definition_revisions_adapter_i_147cf7c4a221" FOREIGN KEY ("adapter_id") REFERENCES "agent_workflow"."development_adapter_definitions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_agent_attempts:fk:development_agent_attempts_action_run_id_development_action_runs_id_fk
ALTER TABLE "agent_workflow"."development_agent_attempts" ADD CONSTRAINT "development_agent_attempts_action_run_id_developme_3d3b074560bb" FOREIGN KEY ("action_run_id") REFERENCES "agent_workflow"."development_action_runs" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_approval_sagas:fk:development_approval_sagas_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_approval_sagas" ADD CONSTRAINT "development_approval_sagas_mission_id_development__5886264c140b" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_approval_sagas:fk:development_approval_sagas_step_run_id_development_step_runs_id_fk
ALTER TABLE "agent_workflow"."development_approval_sagas" ADD CONSTRAINT "development_approval_sagas_step_run_id_development_ba15044b16d7" FOREIGN KEY ("step_run_id") REFERENCES "agent_workflow"."development_step_runs" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_bundle_refs:fk:development_bundle_refs_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_bundle_refs" ADD CONSTRAINT "development_bundle_refs_mission_id_development_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_decisions:fk:development_decisions_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_decisions" ADD CONSTRAINT "development_decisions_mission_id_development_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_deferred_wakes:fk:development_deferred_wakes_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_deferred_wakes" ADD CONSTRAINT "development_deferred_wakes_mission_id_development__44b54f5464c1" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_effects:fk:development_effects_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_effects" ADD CONSTRAINT "development_effects_mission_id_development_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_fact_snapshots:fk:development_fact_snapshots_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_fact_snapshots" ADD CONSTRAINT "development_fact_snapshots_mission_id_development__f23708033cce" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_feedback_ledger:fk:development_feedback_ledger_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_feedback_ledger" ADD CONSTRAINT "development_feedback_ledger_mission_id_development_67f5b2123306" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_mission_links:fk:development_mission_links_parent_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_mission_links" ADD CONSTRAINT "development_mission_links_parent_mission_id_develo_f327baef86f4" FOREIGN KEY ("parent_mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_mission_links:fk:development_mission_links_parent_step_run_id_development_step_runs_id_fk
ALTER TABLE "agent_workflow"."development_mission_links" ADD CONSTRAINT "development_mission_links_parent_step_run_id_devel_5ae3a3eabfa7" FOREIGN KEY ("parent_step_run_id") REFERENCES "agent_workflow"."development_step_runs" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_mission_links:fk:development_mission_links_child_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_mission_links" ADD CONSTRAINT "development_mission_links_child_mission_id_develop_c5db09d1d172" FOREIGN KEY ("child_mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_mission_sources:fk:development_mission_sources_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_mission_sources" ADD CONSTRAINT "development_mission_sources_mission_id_development_18b469725042" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_mr_claims:fk:development_mr_claims_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_mr_claims" ADD CONSTRAINT "development_mr_claims_mission_id_development_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_repository_upload_plan_entries:fk:development_repository_upload_plan_entries_plan_id_development_repository_upload_plans_id_fk
ALTER TABLE "agent_workflow"."development_repository_upload_plan_entries" ADD CONSTRAINT "development_repository_upload_plan_entries_plan_id_c49b09384582" FOREIGN KEY ("plan_id") REFERENCES "agent_workflow"."development_repository_upload_plans" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_repository_upload_plans:fk:development_repository_upload_plans_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_repository_upload_plans" ADD CONSTRAINT "development_repository_upload_plans_mission_id_dev_346f2394746d" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_repository_upload_receipts:fk:development_repository_upload_receipts_plan_id_development_repository_upload_plans_id_fk
ALTER TABLE "agent_workflow"."development_repository_upload_receipts" ADD CONSTRAINT "development_repository_upload_receipts_plan_id_dev_2c3bab9954c9" FOREIGN KEY ("plan_id") REFERENCES "agent_workflow"."development_repository_upload_plans" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_step_joins:fk:development_step_joins_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_step_joins" ADD CONSTRAINT "development_step_joins_mission_id_development_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_step_runs:fk:development_step_runs_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_step_runs" ADD CONSTRAINT "development_step_runs_mission_id_development_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: development_wake_hints:fk:development_wake_hints_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."development_wake_hints" ADD CONSTRAINT "development_wake_hints_mission_id_development_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: digital_employee_revisions:fk:digital_employee_revisions_employee_id_digital_employees_id_fk
ALTER TABLE "agent_workflow"."digital_employee_revisions" ADD CONSTRAINT "digital_employee_revisions_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "agent_workflow"."digital_employees" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: doc_versions:fk:doc_versions_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."doc_versions" ADD CONSTRAINT "doc_versions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: doc_versions:fk:doc_versions_review_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."doc_versions" ADD CONSTRAINT "doc_versions_review_node_run_id_node_runs_id_fk" FOREIGN KEY ("review_node_run_id") REFERENCES "agent_workflow"."node_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: employee_approval_sagas:fk:employee_approval_sagas_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_approval_sagas" ADD CONSTRAINT "employee_approval_sagas_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_approval_sagas:fk:employee_approval_sagas_submit_round_id_employee_reaction_rounds_id_fk
ALTER TABLE "agent_workflow"."employee_approval_sagas" ADD CONSTRAINT "employee_approval_sagas_submit_round_id_employee_r_191362b9c92f" FOREIGN KEY ("submit_round_id") REFERENCES "agent_workflow"."employee_reaction_rounds" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_attention_bindings:fk:employee_attention_bindings_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_attention_bindings" ADD CONSTRAINT "employee_attention_bindings_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_attention_bindings:fk:employee_attention_bindings_context_id_employee_context_records_id_fk
ALTER TABLE "agent_workflow"."employee_attention_bindings" ADD CONSTRAINT "employee_attention_bindings_context_id_employee_co_fe5b453e173a" FOREIGN KEY ("context_id") REFERENCES "agent_workflow"."employee_context_records" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_case_event_origins:fk:employee_case_event_origins_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_case_event_origins" ADD CONSTRAINT "employee_case_event_origins_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_case_inbox:fk:employee_case_inbox_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_case_inbox" ADD CONSTRAINT "employee_case_inbox_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_case_members:fk:employee_case_members_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_case_members" ADD CONSTRAINT "employee_case_members_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: employee_case_members:fk:employee_case_members_user_id_users_id_fk
ALTER TABLE "agent_workflow"."employee_case_members" ADD CONSTRAINT "employee_case_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: employee_case_metering_receipts:fk:employee_case_metering_receipts_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_case_metering_receipts" ADD CONSTRAINT "employee_case_metering_receipts_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: employee_case_workspaces:fk:employee_case_workspaces_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_case_workspaces" ADD CONSTRAINT "employee_case_workspaces_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_change_candidates:fk:employee_change_candidates_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_change_candidates" ADD CONSTRAINT "employee_change_candidates_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_change_candidates:fk:employee_change_candidates_round_id_employee_reaction_rounds_id_fk
ALTER TABLE "agent_workflow"."employee_change_candidates" ADD CONSTRAINT "employee_change_candidates_round_id_employee_react_a8d55d68619e" FOREIGN KEY ("round_id") REFERENCES "agent_workflow"."employee_reaction_rounds" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_channel_results:fk:employee_channel_results_channel_id_employee_channels_id_fk
ALTER TABLE "agent_workflow"."employee_channel_results" ADD CONSTRAINT "employee_channel_results_channel_id_employee_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "agent_workflow"."employee_channels" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_channels:fk:employee_channels_invocation_id_employee_invocations_id_fk
ALTER TABLE "agent_workflow"."employee_channels" ADD CONSTRAINT "employee_channels_invocation_id_employee_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "agent_workflow"."employee_invocations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_channels:fk:employee_channels_parent_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_channels" ADD CONSTRAINT "employee_channels_parent_case_id_employee_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_channels:fk:employee_channels_child_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_channels" ADD CONSTRAINT "employee_channels_child_case_id_employee_cases_id_fk" FOREIGN KEY ("child_case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_context_links:fk:employee_context_links_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_context_links" ADD CONSTRAINT "employee_context_links_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_context_records:fk:employee_context_records_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_context_records" ADD CONSTRAINT "employee_context_records_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_context_revisions:fk:employee_context_revisions_context_id_employee_context_records_id_fk
ALTER TABLE "agent_workflow"."employee_context_revisions" ADD CONSTRAINT "employee_context_revisions_context_id_employee_con_e9ee9b9a1144" FOREIGN KEY ("context_id") REFERENCES "agent_workflow"."employee_context_records" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_definition_revisions:fk:employee_definition_revisions_employee_id_employee_definitions_id_fk
ALTER TABLE "agent_workflow"."employee_definition_revisions" ADD CONSTRAINT "employee_definition_revisions_employee_id_employee_8e76e11ba591" FOREIGN KEY ("employee_id") REFERENCES "agent_workflow"."employee_definitions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_external_context_bindings:fk:employee_external_context_bindings_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_external_context_bindings" ADD CONSTRAINT "employee_external_context_bindings_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_external_context_bindings:fk:employee_external_context_bindings_context_id_employee_context_records_id_fk
ALTER TABLE "agent_workflow"."employee_external_context_bindings" ADD CONSTRAINT "employee_external_context_bindings_context_id_empl_e9977b5da35f" FOREIGN KEY ("context_id") REFERENCES "agent_workflow"."employee_context_records" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_invocations:fk:employee_invocations_parent_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_invocations" ADD CONSTRAINT "employee_invocations_parent_case_id_employee_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_invocations:fk:employee_invocations_parent_round_id_employee_reaction_rounds_id_fk
ALTER TABLE "agent_workflow"."employee_invocations" ADD CONSTRAINT "employee_invocations_parent_round_id_employee_reac_8b1facd8653a" FOREIGN KEY ("parent_round_id") REFERENCES "agent_workflow"."employee_reaction_rounds" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_job_template_revisions:fk:employee_job_template_revisions_template_id_employee_job_templates_id_fk
ALTER TABLE "agent_workflow"."employee_job_template_revisions" ADD CONSTRAINT "employee_job_template_revisions_template_id_employ_8afd92d090c2" FOREIGN KEY ("template_id") REFERENCES "agent_workflow"."employee_job_templates" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_os_outbox:fk:employee_os_outbox_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_os_outbox" ADD CONSTRAINT "employee_os_outbox_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_os_settings:fk:employee_os_settings_execution_policy_revision_employee_execution_policy_revisions_revision_fk
ALTER TABLE "agent_workflow"."employee_os_settings" ADD CONSTRAINT "employee_os_settings_execution_policy_revision_emp_9984f9183d04" FOREIGN KEY ("execution_policy_revision") REFERENCES "agent_workflow"."employee_execution_policy_revisions" ("revision") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_reaction_rounds:fk:employee_reaction_rounds_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_reaction_rounds" ADD CONSTRAINT "employee_reaction_rounds_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_reaction_rounds:fk:employee_reaction_rounds_inbox_id_employee_case_inbox_id_fk
ALTER TABLE "agent_workflow"."employee_reaction_rounds" ADD CONSTRAINT "employee_reaction_rounds_inbox_id_employee_case_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "agent_workflow"."employee_case_inbox" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_round_workspace_states:fk:employee_round_workspace_states_round_id_employee_reaction_rounds_id_fk
ALTER TABLE "agent_workflow"."employee_round_workspace_states" ADD CONSTRAINT "employee_round_workspace_states_round_id_employee__b93987d3d270" FOREIGN KEY ("round_id") REFERENCES "agent_workflow"."employee_reaction_rounds" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_round_workspace_states:fk:employee_round_workspace_states_case_id_employee_cases_id_fk
ALTER TABLE "agent_workflow"."employee_round_workspace_states" ADD CONSTRAINT "employee_round_workspace_states_case_id_employee_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "agent_workflow"."employee_cases" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: employee_tool_registration_revisions:fk:employee_tool_registration_revisions_tool_id_employee_tool_registrations_id_fk
ALTER TABLE "agent_workflow"."employee_tool_registration_revisions" ADD CONSTRAINT "employee_tool_registration_revisions_tool_id_emplo_636fb0d8fb9f" FOREIGN KEY ("tool_id") REFERENCES "agent_workflow"."employee_tool_registrations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: event_deliveries:fk:event_deliveries_event_id_event_records_id_fk
ALTER TABLE "agent_workflow"."event_deliveries" ADD CONSTRAINT "event_deliveries_event_id_event_records_id_fk" FOREIGN KEY ("event_id") REFERENCES "agent_workflow"."event_records" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: event_deliveries:fk:event_deliveries_subscription_id_event_subscriptions_id_fk
ALTER TABLE "agent_workflow"."event_deliveries" ADD CONSTRAINT "event_deliveries_subscription_id_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "agent_workflow"."event_subscriptions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: intent_apply_journal:fk:intent_apply_journal_session_id_intent_sessions_id_fk
ALTER TABLE "agent_workflow"."intent_apply_journal" ADD CONSTRAINT "intent_apply_journal_session_id_intent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."intent_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: intent_draft_resolutions:fk:intent_draft_resolutions_draft_id_intent_drafts_id_fk
ALTER TABLE "agent_workflow"."intent_draft_resolutions" ADD CONSTRAINT "intent_draft_resolutions_draft_id_intent_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "agent_workflow"."intent_drafts" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: intent_draft_resolutions:fk:intent_draft_resolutions_session_id_intent_sessions_id_fk
ALTER TABLE "agent_workflow"."intent_draft_resolutions" ADD CONSTRAINT "intent_draft_resolutions_session_id_intent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."intent_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: intent_drafts:fk:intent_drafts_session_id_intent_sessions_id_fk
ALTER TABLE "agent_workflow"."intent_drafts" ADD CONSTRAINT "intent_drafts_session_id_intent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."intent_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: intent_turn_events:fk:intent_turn_events_turn_id_intent_turns_id_fk
ALTER TABLE "agent_workflow"."intent_turn_events" ADD CONSTRAINT "intent_turn_events_turn_id_intent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "agent_workflow"."intent_turns" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: intent_turns:fk:intent_turns_session_id_intent_sessions_id_fk
ALTER TABLE "agent_workflow"."intent_turns" ADD CONSTRAINT "intent_turns_session_id_intent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."intent_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: intent_working_set_changes:fk:intent_working_set_changes_session_id_intent_sessions_id_fk
ALTER TABLE "agent_workflow"."intent_working_set_changes" ADD CONSTRAINT "intent_working_set_changes_session_id_intent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."intent_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: legacy_code_work_item_links:fk:legacy_code_work_item_links_mission_id_development_missions_id_fk
ALTER TABLE "agent_workflow"."legacy_code_work_item_links" ADD CONSTRAINT "legacy_code_work_item_links_mission_id_development_d4b1915e353c" FOREIGN KEY ("mission_id") REFERENCES "agent_workflow"."development_missions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: lifecycle_alerts:fk:lifecycle_alerts_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."lifecycle_alerts" ADD CONSTRAINT "lifecycle_alerts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: mcp_probes:unique:mcp_probes_mcp_id_unique
ALTER TABLE "agent_workflow"."mcp_probes" ADD CONSTRAINT "mcp_probes_mcp_id_unique" UNIQUE ("mcp_id");

-- constraint: mcp_probes:fk:mcp_probes_mcp_id_mcps_id_fk
ALTER TABLE "agent_workflow"."mcp_probes" ADD CONSTRAINT "mcp_probes_mcp_id_mcps_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "agent_workflow"."mcps" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: mcp_runtime_test_create_receipts:check:mcp_runtime_test_create_receipts_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_create_receipts" ADD CONSTRAINT "mcp_runtime_test_create_receipts_shape" CHECK (length("request_digest") = 64 AND "request_digest" !~ '[^0-9a-f]' AND "created_at" >= 0 AND "expires_at" > "created_at");

-- constraint: mcp_runtime_test_create_receipts:fk:mcp_runtime_test_create_receipts_mcp_id_mcps_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_create_receipts" ADD CONSTRAINT "mcp_runtime_test_create_receipts_mcp_id_mcps_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "agent_workflow"."mcps" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: mcp_runtime_test_create_receipts:fk:mcp_runtime_test_create_receipts_owner_user_id_users_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_create_receipts" ADD CONSTRAINT "mcp_runtime_test_create_receipts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: mcp_runtime_test_events:check:mcp_runtime_test_events_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_events" ADD CONSTRAINT "mcp_runtime_test_events_shape" CHECK ("event_seq" > 0 AND "ts" >= 0 AND "source" IN ('stream', 'live-child', 'post-run-child') AND ( "external_event_key" IS NULL OR ( length("external_event_key") = 64 AND "external_event_key" !~ '[^0-9a-f]' ) ));

-- constraint: mcp_runtime_test_events:fk:mcp_runtime_test_events_test_session_id_mcp_runtime_test_sessions_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_events" ADD CONSTRAINT "mcp_runtime_test_events_test_session_id_mcp_runtim_47e8aec33a5f" FOREIGN KEY ("test_session_id") REFERENCES "agent_workflow"."mcp_runtime_test_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: mcp_runtime_test_session_leases:check:mcp_runtime_test_session_leases_all_or_none
ALTER TABLE "agent_workflow"."mcp_runtime_test_session_leases" ADD CONSTRAINT "mcp_runtime_test_session_leases_all_or_none" CHECK (( ( "lease_turn_id" IS NULL AND "lease_acquired_at" IS NULL AND "lease_nonce_digest" IS NULL ) OR ( "lease_turn_id" IS NOT NULL AND "lease_acquired_at" IS NOT NULL AND "lease_nonce_digest" IS NOT NULL ) ));

-- constraint: mcp_runtime_test_session_leases:check:mcp_runtime_test_session_leases_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_session_leases" ADD CONSTRAINT "mcp_runtime_test_session_leases_shape" CHECK ("protocol" IN ('opencode', 'claude-code') AND ( "lease_nonce_digest" IS NULL OR ( length("lease_nonce_digest") = 64 AND "lease_nonce_digest" !~ '[^0-9a-f]' ) ));

-- constraint: mcp_runtime_test_session_leases:fk:mcp_runtime_test_session_leases_test_session_id_mcp_runtime_test_sessions_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_session_leases" ADD CONSTRAINT "mcp_runtime_test_session_leases_test_session_id_mc_2a89b094c931" FOREIGN KEY ("test_session_id") REFERENCES "agent_workflow"."mcp_runtime_test_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: mcp_runtime_test_session_leases:fk:mcp_runtime_test_session_leases_created_turn_id_mcp_runtime_test_turns_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_session_leases" ADD CONSTRAINT "mcp_runtime_test_session_leases_created_turn_id_mc_733839fa8fd3" FOREIGN KEY ("created_turn_id") REFERENCES "agent_workflow"."mcp_runtime_test_turns" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: mcp_runtime_test_session_leases:fk:mcp_runtime_test_session_leases_current_turn_id_mcp_runtime_test_turns_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_session_leases" ADD CONSTRAINT "mcp_runtime_test_session_leases_current_turn_id_mc_f098fab5ac06" FOREIGN KEY ("current_turn_id") REFERENCES "agent_workflow"."mcp_runtime_test_turns" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: mcp_runtime_test_session_leases:fk:mcp_runtime_test_session_leases_lease_turn_id_mcp_runtime_test_turns_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_session_leases" ADD CONSTRAINT "mcp_runtime_test_session_leases_lease_turn_id_mcp__6fa69ac53f6f" FOREIGN KEY ("lease_turn_id") REFERENCES "agent_workflow"."mcp_runtime_test_turns" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: mcp_runtime_test_sessions:check:mcp_runtime_test_sessions_status_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_sessions" ADD CONSTRAINT "mcp_runtime_test_sessions_status_shape" CHECK (( ( "status" = 'active' AND "end_reason" IS NULL AND "ended_at" IS NULL AND ( ("in_flight_turn_id" IS NOT NULL AND "idle_deadline_at" IS NULL) OR ( "in_flight_turn_id" IS NULL AND "idle_deadline_at" IS NOT NULL AND "native_session_state" = 'ready' AND "continuation_blocked_reason" IS NULL ) ) ) OR ( "status" = 'ending' AND "end_reason" IS NOT NULL AND "ended_at" IS NULL AND "idle_deadline_at" IS NULL ) OR ( "status" = 'ended' AND "end_reason" IS NOT NULL AND "ended_at" IS NOT NULL AND "in_flight_turn_id" IS NULL AND "idle_deadline_at" IS NULL ) ));

-- constraint: mcp_runtime_test_sessions:check:mcp_runtime_test_sessions_hash_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_sessions" ADD CONSTRAINT "mcp_runtime_test_sessions_hash_shape" CHECK (length("client_create_digest") = 64 AND "client_create_digest" !~ '[^0-9a-f]' AND length("mcp_config_hash") = 64 AND "mcp_config_hash" !~ '[^0-9a-f]');

-- constraint: mcp_runtime_test_sessions:check:mcp_runtime_test_sessions_enum_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_sessions" ADD CONSTRAINT "mcp_runtime_test_sessions_enum_shape" CHECK ("status" IN ('active', 'ending', 'ended') AND "runtime_protocol" IN ('opencode', 'claude-code') AND "native_session_state" IN ('pending', 'ready', 'unusable') AND "cleanup_state" IN ('not-started', 'pending', 'complete', 'quarantined') AND ( "end_reason" IS NULL OR "end_reason" IN ( 'user', 'idle-timeout', 'mcp-deleted', 'mcp-disabled', 'mcp-config-changed', 'access-revoked', 'runtime-disabled', 'runtime-deleted', 'runtime-profile-changed', 'runtime-session-reset', 'capture-truncated', 'capture-incomplete', 'session-unusable' ) ) AND ( "continuation_blocked_reason" IS NULL OR "continuation_blocked_reason" IN ( 'mcp-config-changed', 'runtime-profile-changed', 'capture-truncated', 'capture-incomplete' ) ) AND "turn_seq" >= 0 AND "session_version" >= 0);

-- constraint: mcp_runtime_test_sessions:fk:mcp_runtime_test_sessions_mcp_id_mcps_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_sessions" ADD CONSTRAINT "mcp_runtime_test_sessions_mcp_id_mcps_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "agent_workflow"."mcps" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: mcp_runtime_test_sessions:fk:mcp_runtime_test_sessions_owner_user_id_users_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_sessions" ADD CONSTRAINT "mcp_runtime_test_sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: mcp_runtime_test_turns:check:mcp_runtime_test_turns_enum_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_turns" ADD CONSTRAINT "mcp_runtime_test_turns_enum_shape" CHECK ("status" IN ( 'queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted' ) AND "capture_state" IN ('live', 'complete', 'truncated', 'incomplete') AND ( "capture_incomplete_reason" IS NULL OR "capture_incomplete_reason" IN ( 'stream-persist-failed', 'stream-frame-limit-exceeded', 'child-capture-failed', 'post-exit-flush-timeout' ) ));

-- constraint: mcp_runtime_test_turns:check:mcp_runtime_test_turns_counter_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_turns" ADD CONSTRAINT "mcp_runtime_test_turns_counter_shape" CHECK ("seq" > 0 AND "hard_deadline_at" >= "created_at" AND "capture_last_event_seq" >= 0 AND "capture_event_bytes" >= 0 AND ("capture_first_event_seq" IS NULL OR "capture_first_event_seq" > 0) AND ("duration_ms" IS NULL OR "duration_ms" >= 0));

-- constraint: mcp_runtime_test_turns:check:mcp_runtime_test_turns_lifecycle_shape
ALTER TABLE "agent_workflow"."mcp_runtime_test_turns" ADD CONSTRAINT "mcp_runtime_test_turns_lifecycle_shape" CHECK (( "status" = 'queued' AND "started_at" IS NULL AND "finished_at" IS NULL ) OR ( "status" = 'running' AND "started_at" IS NOT NULL AND "finished_at" IS NULL ) OR ( "status" IN ( 'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted' ) AND "finished_at" IS NOT NULL ));

-- constraint: mcp_runtime_test_turns:fk:mcp_runtime_test_turns_session_id_mcp_runtime_test_sessions_id_fk
ALTER TABLE "agent_workflow"."mcp_runtime_test_turns" ADD CONSTRAINT "mcp_runtime_test_turns_session_id_mcp_runtime_test_f98966f21820" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."mcp_runtime_test_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: memory_distill_events:fk:memory_distill_events_distill_job_id_memory_distill_jobs_id_fk
ALTER TABLE "agent_workflow"."memory_distill_events" ADD CONSTRAINT "memory_distill_events_distill_job_id_memory_distill_jobs_id_fk" FOREIGN KEY ("distill_job_id") REFERENCES "agent_workflow"."memory_distill_jobs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: memory_scope_move_events:check:memory_scope_move_events_actor_source
ALTER TABLE "agent_workflow"."memory_scope_move_events" ADD CONSTRAINT "memory_scope_move_events_actor_source" CHECK ("actor_source" IN ('session','pat','daemon','cli','system'));

-- constraint: memory_scope_move_events:check:memory_scope_move_events_from_scope
ALTER TABLE "agent_workflow"."memory_scope_move_events" ADD CONSTRAINT "memory_scope_move_events_from_scope" CHECK (("from_scope_type" = 'global' AND "from_scope_id" IS NULL) OR ("from_scope_type" IN ('agent','workflow','repo','repo_group') AND "from_scope_id" IS NOT NULL AND length("from_scope_id") > 0));

-- constraint: memory_scope_move_events:check:memory_scope_move_events_to_scope
ALTER TABLE "agent_workflow"."memory_scope_move_events" ADD CONSTRAINT "memory_scope_move_events_to_scope" CHECK (("to_scope_type" = 'global' AND "to_scope_id" IS NULL) OR ("to_scope_type" IN ('agent','workflow','repo','repo_group') AND "to_scope_id" IS NOT NULL AND length("to_scope_id") > 0));

-- constraint: memory_scope_move_events:check:memory_scope_move_events_not_noop
ALTER TABLE "agent_workflow"."memory_scope_move_events" ADD CONSTRAINT "memory_scope_move_events_not_noop" CHECK ("from_scope_type" <> "to_scope_type" OR "from_scope_id" IS DISTINCT FROM "to_scope_id");

-- constraint: memory_scope_move_events:check:memory_scope_move_events_version_step
ALTER TABLE "agent_workflow"."memory_scope_move_events" ADD CONSTRAINT "memory_scope_move_events_version_step" CHECK ("expected_version" > 0 AND "resulting_version" = "expected_version" + 1);

-- constraint: memory_scope_move_events:check:memory_scope_move_events_time_nonnegative
ALTER TABLE "agent_workflow"."memory_scope_move_events" ADD CONSTRAINT "memory_scope_move_events_time_nonnegative" CHECK ("occurred_at" >= 0);

-- constraint: node_run_events:fk:node_run_events_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."node_run_events" ADD CONSTRAINT "node_run_events_node_run_id_node_runs_id_fk" FOREIGN KEY ("node_run_id") REFERENCES "agent_workflow"."node_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: node_run_outputs:fk:node_run_outputs_node_run_id_node_runs_id_fk
ALTER TABLE "agent_workflow"."node_run_outputs" ADD CONSTRAINT "node_run_outputs_node_run_id_node_runs_id_fk" FOREIGN KEY ("node_run_id") REFERENCES "agent_workflow"."node_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: node_runs:fk:node_runs_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."node_runs" ADD CONSTRAINT "node_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: oidc_providers:unique:oidc_providers_slug_unique
ALTER TABLE "agent_workflow"."oidc_providers" ADD CONSTRAINT "oidc_providers_slug_unique" UNIQUE ("slug");

-- constraint: repo_group_nodes:fk:repo_group_nodes_group_id_repo_groups_id_fk
ALTER TABLE "agent_workflow"."repo_group_nodes" ADD CONSTRAINT "repo_group_nodes_group_id_repo_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "agent_workflow"."repo_groups" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: repo_group_nodes:fk:repo_group_nodes_cached_repo_id_cached_repos_id_fk
ALTER TABLE "agent_workflow"."repo_group_nodes" ADD CONSTRAINT "repo_group_nodes_cached_repo_id_cached_repos_id_fk" FOREIGN KEY ("cached_repo_id") REFERENCES "agent_workflow"."cached_repos" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: repository_transport_connections:check:repository_transport_connections_generation_length
ALTER TABLE "agent_workflow"."repository_transport_connections" ADD CONSTRAINT "repository_transport_connections_generation_length" CHECK (length("connection_generation") BETWEEN 1 AND 128);

-- constraint: resource_grants:fk:resource_grants_user_id_users_id_fk
ALTER TABLE "agent_workflow"."resource_grants" ADD CONSTRAINT "resource_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: review_comments:fk:review_comments_doc_version_id_doc_versions_id_fk
ALTER TABLE "agent_workflow"."review_comments" ADD CONSTRAINT "review_comments_doc_version_id_doc_versions_id_fk" FOREIGN KEY ("doc_version_id") REFERENCES "agent_workflow"."doc_versions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: review_node_reviewers:fk:review_node_reviewers_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."review_node_reviewers" ADD CONSTRAINT "review_node_reviewers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: review_node_reviewers:fk:review_node_reviewers_reviewer_user_id_users_id_fk
ALTER TABLE "agent_workflow"."review_node_reviewers" ADD CONSTRAINT "review_node_reviewers_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: review_node_reviewers:fk:review_node_reviewers_assigned_by_user_id_users_id_fk
ALTER TABLE "agent_workflow"."review_node_reviewers" ADD CONSTRAINT "review_node_reviewers_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: runtime_session_leases:check:runtime_session_leases_all_or_none
ALTER TABLE "agent_workflow"."runtime_session_leases" ADD CONSTRAINT "runtime_session_leases_all_or_none" CHECK (( ( "lease_node_run_id" IS NULL AND "lease_nonce_digest" IS NULL AND "leased_at" IS NULL ) OR ( "lease_node_run_id" IS NOT NULL AND "lease_nonce_digest" IS NOT NULL AND "leased_at" IS NOT NULL ) ));

-- constraint: runtime_session_leases:check:runtime_session_leases_protocol_shape
ALTER TABLE "agent_workflow"."runtime_session_leases" ADD CONSTRAINT "runtime_session_leases_protocol_shape" CHECK ("protocol" IN ('opencode', 'claude-code'));

-- constraint: runtime_session_leases:check:runtime_session_leases_reset_pending_held
ALTER TABLE "agent_workflow"."runtime_session_leases" ADD CONSTRAINT "runtime_session_leases_reset_pending_held" CHECK ("reset_pending" = FALSE OR "lease_node_run_id" IS NOT NULL);

-- constraint: runtime_session_leases:check:runtime_session_leases_reset_pending_shape
ALTER TABLE "agent_workflow"."runtime_session_leases" ADD CONSTRAINT "runtime_session_leases_reset_pending_shape" CHECK ("reset_pending" IN (FALSE, TRUE));

-- constraint: runtime_session_leases:fk:runtime_session_leases_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."runtime_session_leases" ADD CONSTRAINT "runtime_session_leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: runtimes:unique:runtimes_name_unique
ALTER TABLE "agent_workflow"."runtimes" ADD CONSTRAINT "runtimes_name_unique" UNIQUE ("name");

-- constraint: skill_versions:fk:skill_versions_skill_id_skills_id_fk
ALTER TABLE "agent_workflow"."skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "agent_workflow"."skills" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_collaborators:fk:task_collaborators_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_collaborators" ADD CONSTRAINT "task_collaborators_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_collaborators:fk:task_collaborators_user_id_users_id_fk
ALTER TABLE "agent_workflow"."task_collaborators" ADD CONSTRAINT "task_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: task_execution_effect_attempts:check:task_execution_attempts_no_positive
ALTER TABLE "agent_workflow"."task_execution_effect_attempts" ADD CONSTRAINT "task_execution_attempts_no_positive" CHECK ("attempt_no" > 0);

-- constraint: task_execution_effect_attempts:check:task_execution_attempts_epoch_positive
ALTER TABLE "agent_workflow"."task_execution_effect_attempts" ADD CONSTRAINT "task_execution_attempts_epoch_positive" CHECK ("epoch" > 0);

-- constraint: task_execution_effect_attempts:fk:task_execution_effect_attempts_effect_id_task_execution_effects_id_fk
ALTER TABLE "agent_workflow"."task_execution_effect_attempts" ADD CONSTRAINT "task_execution_effect_attempts_effect_id_task_exec_dd101cf90ddf" FOREIGN KEY ("effect_id") REFERENCES "agent_workflow"."task_execution_effects" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_effect_attempts:fk:task_execution_effect_attempts_intent_id_task_execution_intents_id_fk
ALTER TABLE "agent_workflow"."task_execution_effect_attempts" ADD CONSTRAINT "task_execution_effect_attempts_intent_id_task_exec_6d21cf2aca30" FOREIGN KEY ("intent_id") REFERENCES "agent_workflow"."task_execution_intents" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_effect_fences:check:task_execution_effect_fences_epoch_positive
ALTER TABLE "agent_workflow"."task_execution_effect_fences" ADD CONSTRAINT "task_execution_effect_fences_epoch_positive" CHECK ("acquired_epoch" > 0);

-- constraint: task_execution_effect_fences:fk:task_execution_effect_fences_effect_attempt_id_task_execution_effect_attempts_id_fk
ALTER TABLE "agent_workflow"."task_execution_effect_fences" ADD CONSTRAINT "task_execution_effect_fences_effect_attempt_id_tas_e1b169c32dd1" FOREIGN KEY ("effect_attempt_id") REFERENCES "agent_workflow"."task_execution_effect_attempts" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_effects:check:task_execution_effects_generation_nonnegative
ALTER TABLE "agent_workflow"."task_execution_effects" ADD CONSTRAINT "task_execution_effects_generation_nonnegative" CHECK ("operation_generation" >= 0);

-- constraint: task_execution_effects:fk:task_execution_effects_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_execution_effects" ADD CONSTRAINT "task_execution_effects_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_effects:fk:task_execution_effects_origin_intent_id_task_execution_intents_id_fk
ALTER TABLE "agent_workflow"."task_execution_effects" ADD CONSTRAINT "task_execution_effects_origin_intent_id_task_execu_7e144c8d36fe" FOREIGN KEY ("origin_intent_id") REFERENCES "agent_workflow"."task_execution_intents" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_effects:fk:task_execution_effects_current_intent_id_task_execution_intents_id_fk
ALTER TABLE "agent_workflow"."task_execution_effects" ADD CONSTRAINT "task_execution_effects_current_intent_id_task_exec_671350815f49" FOREIGN KEY ("current_intent_id") REFERENCES "agent_workflow"."task_execution_intents" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_intents:check:task_execution_intents_generation_nonnegative
ALTER TABLE "agent_workflow"."task_execution_intents" ADD CONSTRAINT "task_execution_intents_generation_nonnegative" CHECK ("operation_generation" >= 0);

-- constraint: task_execution_intents:fk:task_execution_intents_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_execution_intents" ADD CONSTRAINT "task_execution_intents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_lineage_operation_records:check:task_execution_lineage_revision_positive
ALTER TABLE "agent_workflow"."task_execution_lineage_operation_records" ADD CONSTRAINT "task_execution_lineage_revision_positive" CHECK ("record_revision" > 0);

-- constraint: task_execution_lineage_operation_records:check:task_execution_lineage_record_shape
ALTER TABLE "agent_workflow"."task_execution_lineage_operation_records" ADD CONSTRAINT "task_execution_lineage_record_shape" CHECK (( ("record_kind" = 'generation-watermark' AND "highest_settled_generation" IS NOT NULL AND "operation_generation" IS NULL AND "decision_state" IS NULL) OR ("record_kind" = 'replay-decision' AND "operation_generation" IS NOT NULL AND "highest_settled_generation" IS NULL AND "decision_state" IS NOT NULL) ));

-- constraint: task_execution_maintenance_claims:check:task_execution_maintenance_revision_positive
ALTER TABLE "agent_workflow"."task_execution_maintenance_claims" ADD CONSTRAINT "task_execution_maintenance_revision_positive" CHECK ("revision" > 0);

-- constraint: task_execution_maintenance_members:fk:task_execution_maintenance_members_claim_id_task_execution_maintenance_claims_id_fk
ALTER TABLE "agent_workflow"."task_execution_maintenance_members" ADD CONSTRAINT "task_execution_maintenance_members_claim_id_task_e_f62fa5a702b6" FOREIGN KEY ("claim_id") REFERENCES "agent_workflow"."task_execution_maintenance_claims" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_execution_owners:check:task_execution_owners_epoch_positive
ALTER TABLE "agent_workflow"."task_execution_owners" ADD CONSTRAINT "task_execution_owners_epoch_positive" CHECK ("epoch" > 0);

-- constraint: task_execution_owners:check:task_execution_owners_revision_positive
ALTER TABLE "agent_workflow"."task_execution_owners" ADD CONSTRAINT "task_execution_owners_revision_positive" CHECK ("revision" > 0);

-- constraint: task_execution_owners:fk:task_execution_owners_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_execution_owners" ADD CONSTRAINT "task_execution_owners_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_node_clarify_directives:fk:task_node_clarify_directives_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_node_clarify_directives" ADD CONSTRAINT "task_node_clarify_directives_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_questions:fk:task_questions_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_questions" ADD CONSTRAINT "task_questions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_repos:fk:task_repos_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_repos" ADD CONSTRAINT "task_repos_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: task_space_nodes:fk:task_space_nodes_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."task_space_nodes" ADD CONSTRAINT "task_space_nodes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: tasks:fk:tasks_parent_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: user_identities:fk:user_identities_user_id_users_id_fk
ALTER TABLE "agent_workflow"."user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: user_identities:fk:user_identities_provider_id_oidc_providers_id_fk
ALTER TABLE "agent_workflow"."user_identities" ADD CONSTRAINT "user_identities_provider_id_oidc_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "agent_workflow"."oidc_providers" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

-- constraint: user_pats:unique:user_pats_token_hash_unique
ALTER TABLE "agent_workflow"."user_pats" ADD CONSTRAINT "user_pats_token_hash_unique" UNIQUE ("token_hash");

-- constraint: user_pats:fk:user_pats_user_id_users_id_fk
ALTER TABLE "agent_workflow"."user_pats" ADD CONSTRAINT "user_pats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: user_permission_grants:fk:user_permission_grants_user_id_users_id_fk
ALTER TABLE "agent_workflow"."user_permission_grants" ADD CONSTRAINT "user_permission_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: user_repository_transport_credentials:fk:user_repository_transport_credentials_user_id_users_id_fk
ALTER TABLE "agent_workflow"."user_repository_transport_credentials" ADD CONSTRAINT "user_repository_transport_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: user_repository_transport_credentials:fk:user_repository_transport_credentials_connection_fk
ALTER TABLE "agent_workflow"."user_repository_transport_credentials" ADD CONSTRAINT "user_repository_transport_credentials_connection_fk" FOREIGN KEY ("provider", "connection_generation") REFERENCES "agent_workflow"."repository_transport_connections" ("provider", "connection_generation") ON UPDATE CASCADE ON DELETE CASCADE;

-- constraint: user_sessions:unique:user_sessions_token_hash_unique
ALTER TABLE "agent_workflow"."user_sessions" ADD CONSTRAINT "user_sessions_token_hash_unique" UNIQUE ("token_hash");

-- constraint: user_sessions:fk:user_sessions_user_id_users_id_fk
ALTER TABLE "agent_workflow"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: users:unique:users_username_unique
ALTER TABLE "agent_workflow"."users" ADD CONSTRAINT "users_username_unique" UNIQUE ("username");

-- constraint: users:unique:users_email_unique
ALTER TABLE "agent_workflow"."users" ADD CONSTRAINT "users_email_unique" UNIQUE ("email");

-- constraint: verification_profile_revisions:fk:verification_profile_revisions_profile_id_verification_profiles_id_fk
ALTER TABLE "agent_workflow"."verification_profile_revisions" ADD CONSTRAINT "verification_profile_revisions_profile_id_verifica_e654c156f61c" FOREIGN KEY ("profile_id") REFERENCES "agent_workflow"."verification_profiles" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: webhook_trigger_fires:fk:webhook_trigger_fires_trigger_id_webhook_triggers_id_fk
ALTER TABLE "agent_workflow"."webhook_trigger_fires" ADD CONSTRAINT "webhook_trigger_fires_trigger_id_webhook_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "agent_workflow"."webhook_triggers" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: webhook_trigger_streams:fk:webhook_trigger_streams_trigger_id_webhook_triggers_id_fk
ALTER TABLE "agent_workflow"."webhook_trigger_streams" ADD CONSTRAINT "webhook_trigger_streams_trigger_id_webhook_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "agent_workflow"."webhook_triggers" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: webhook_triggers:fk:webhook_triggers_endpoint_id_webhook_endpoints_id_fk
ALTER TABLE "agent_workflow"."webhook_triggers" ADD CONSTRAINT "webhook_triggers_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "agent_workflow"."webhook_endpoints" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- constraint: workgroup_assignments:fk:workgroup_assignments_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."workgroup_assignments" ADD CONSTRAINT "workgroup_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: workgroup_member_cursors:fk:workgroup_member_cursors_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."workgroup_member_cursors" ADD CONSTRAINT "workgroup_member_cursors_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: workgroup_members:fk:workgroup_members_workgroup_id_workgroups_id_fk
ALTER TABLE "agent_workflow"."workgroup_members" ADD CONSTRAINT "workgroup_members_workgroup_id_workgroups_id_fk" FOREIGN KEY ("workgroup_id") REFERENCES "agent_workflow"."workgroups" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: workgroup_messages:fk:workgroup_messages_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."workgroup_messages" ADD CONSTRAINT "workgroup_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: workgroup_messages:fk:workgroup_messages_trigger_message_id_workgroup_messages_id_fk
ALTER TABLE "agent_workflow"."workgroup_messages" ADD CONSTRAINT "workgroup_messages_trigger_message_id_workgroup_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "agent_workflow"."workgroup_messages" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

-- constraint: workgroup_task_state:fk:workgroup_task_state_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."workgroup_task_state" ADD CONSTRAINT "workgroup_task_state_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- metadata: migration-table
CREATE TABLE "agent_workflow_meta"."schema_migrations" (baseline_id TEXT PRIMARY KEY, contract_digest TEXT NOT NULL, plan_digest TEXT NOT NULL, applied_at BIGINT NOT NULL);

-- metadata: contract-table
CREATE TABLE "agent_workflow_meta"."schema_contract" (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), contract_digest TEXT NOT NULL, active_table_count BIGINT NOT NULL, archive_only_table_count BIGINT NOT NULL);

-- metadata: contract-row
INSERT INTO "agent_workflow_meta"."schema_contract" (singleton, contract_digest, active_table_count, archive_only_table_count) VALUES (TRUE, 'sha256:99c8b91bc3e8dcb123b3783dec558ef8b7958c7c3eca4922959862d78d846729', 178, 6);

-- metadata: logical-copy-operations
CREATE TABLE "agent_workflow_meta"."logical_copy_operations" (operation_id TEXT PRIMARY KEY, source_generation_id TEXT NOT NULL, contract_digest TEXT NOT NULL, plan_digest TEXT NOT NULL, stage TEXT NOT NULL CHECK (stage IN ('prepared', 'copying', 'verified', 'activated', 'finalized')), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);

-- metadata: logical-copy-chunks
CREATE TABLE "agent_workflow_meta"."logical_copy_chunks" (operation_id TEXT NOT NULL REFERENCES "agent_workflow_meta"."logical_copy_operations" (operation_id) ON DELETE RESTRICT, table_id TEXT NOT NULL, chunk_index BIGINT NOT NULL, chunk_digest TEXT NOT NULL, row_count BIGINT NOT NULL, first_key_json TEXT, last_key_json TEXT, committed_at BIGINT NOT NULL, PRIMARY KEY (operation_id, table_id, chunk_index));

-- metadata: database-generations
CREATE TABLE "agent_workflow_meta"."database_generations" (generation_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES "agent_workflow_meta"."logical_copy_operations" (operation_id) ON DELETE RESTRICT, source_generation_id TEXT NOT NULL, contract_digest TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('prepared', 'active', 'retired')), activated_at BIGINT, first_live_write_at BIGINT);
