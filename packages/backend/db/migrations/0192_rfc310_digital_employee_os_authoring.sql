-- RFC-310 OS revision: authoring model for the canonical four-level hierarchy
-- (digital employee -> employee type -> work item -> tool). Existing RFC-310
-- Mission tables stay readable during cutover, but the new canonical APIs only
-- write these tables. No data backfill is required by the product decision.

CREATE TABLE `employee_type_packages` (
	`type_id` text NOT NULL,
	`revision` integer NOT NULL,
	`descriptor_json` text NOT NULL,
	`descriptor_digest` text NOT NULL,
	`state` text NOT NULL DEFAULT 'published',
	`registered_at` integer NOT NULL,
	PRIMARY KEY(`type_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `idx_employee_type_packages_state` ON `employee_type_packages` (`state`, `type_id`, `revision`);
--> statement-breakpoint

CREATE TABLE `employee_tool_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`type_id` text NOT NULL,
	`type_revision` integer NOT NULL,
	`work_item_ref` text NOT NULL,
	`draft_json` text NOT NULL,
	`published_revision` integer,
	`owner_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_employee_tools_node` ON `employee_tool_registrations` (`type_id`, `type_revision`, `work_item_ref`, `retired_at`);
--> statement-breakpoint

CREATE TABLE `employee_tool_registration_revisions` (
	`tool_id` text NOT NULL REFERENCES `employee_tool_registrations`(`id`),
	`revision` integer NOT NULL,
	`content_json` text NOT NULL,
	`content_digest` text NOT NULL,
	`validation_receipt_json` text NOT NULL,
	`state` text NOT NULL DEFAULT 'published',
	`published_at` integer NOT NULL,
	`published_by` text,
	PRIMARY KEY(`tool_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `idx_employee_tool_revisions_state` ON `employee_tool_registration_revisions` (`state`, `tool_id`, `revision`);
--> statement-breakpoint

CREATE TABLE `employee_job_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`type_id` text NOT NULL,
	`type_revision` integer NOT NULL,
	`name` text NOT NULL,
	`draft_json` text NOT NULL,
	`published_revision` integer,
	`owner_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_job_templates_type_name_unique` ON `employee_job_templates` (`type_id`, `type_revision`, `name`);
--> statement-breakpoint

CREATE TABLE `employee_job_template_revisions` (
	`template_id` text NOT NULL REFERENCES `employee_job_templates`(`id`),
	`revision` integer NOT NULL,
	`content_json` text NOT NULL,
	`content_digest` text NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text,
	PRIMARY KEY(`template_id`, `revision`)
);
--> statement-breakpoint

CREATE TABLE `employee_work_scope_revisions` (
	`scope_id` text NOT NULL,
	`revision` integer NOT NULL,
	`type_id` text NOT NULL,
	`type_revision` integer NOT NULL,
	`encoded_scope_json` text NOT NULL,
	`display_summary` text NOT NULL,
	`content_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	PRIMARY KEY(`scope_id`, `revision`)
);
--> statement-breakpoint

CREATE TABLE `employee_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type_id` text NOT NULL,
	`type_revision` integer NOT NULL,
	`draft_json` text NOT NULL,
	`published_revision` integer,
	`owner_user_id` text,
	`visibility` text NOT NULL DEFAULT 'private',
	`acl_revision` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_definitions_owner_name_unique` ON `employee_definitions` (COALESCE(`owner_user_id`, ''), `name`);
--> statement-breakpoint
CREATE INDEX `idx_employee_definitions_type` ON `employee_definitions` (`type_id`, `type_revision`, `archived_at`);
--> statement-breakpoint

CREATE TABLE `employee_definition_revisions` (
	`employee_id` text NOT NULL REFERENCES `employee_definitions`(`id`),
	`revision` integer NOT NULL,
	`content_json` text NOT NULL,
	`content_digest` text NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text,
	PRIMARY KEY(`employee_id`, `revision`)
);
--> statement-breakpoint

CREATE TABLE `employee_execution_policy_revisions` (
	`revision` integer PRIMARY KEY NOT NULL,
	`content_json` text NOT NULL,
	`content_digest` text NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text
);
--> statement-breakpoint

CREATE TABLE `employee_os_settings` (
	`singleton_key` text PRIMARY KEY NOT NULL,
	`execution_policy_revision` integer NOT NULL REFERENCES `employee_execution_policy_revisions`(`revision`),
	`updated_at` integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE `employee_input_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`original_name` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`blob_ref` text NOT NULL,
	`upload_idempotency_key` text,
	`state` text NOT NULL DEFAULT 'pending',
	`claimed_by_case_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_input_uploads_actor_idempotency_unique` ON `employee_input_uploads` (COALESCE(`actor_user_id`, ''), `upload_idempotency_key`) WHERE `upload_idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_employee_input_uploads_expiry` ON `employee_input_uploads` (`state`, `expires_at`);
--> statement-breakpoint

ALTER TABLE `tasks` ADD `digital_employee_round_id` text;
--> statement-breakpoint
CREATE INDEX `idx_tasks_digital_employee_round` ON `tasks` (`digital_employee_round_id`);
--> statement-breakpoint
CREATE INDEX `idx_development_missions_open` ON `development_missions` (`created_at`, `id`) WHERE `terminal_at` IS NULL;
--> statement-breakpoint

CREATE TABLE `event_sources` (
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`descriptor_json` text NOT NULL,
	`descriptor_digest` text NOT NULL,
	`state` text NOT NULL DEFAULT 'published',
	`registered_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `revision`)
);
--> statement-breakpoint

CREATE TABLE `event_type_catalog` (
	`event_type_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`descriptor_json` text NOT NULL,
	`descriptor_digest` text NOT NULL,
	`state` text NOT NULL DEFAULT 'published',
	`registered_at` integer NOT NULL,
	PRIMARY KEY(`event_type_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `idx_event_type_source` ON `event_type_catalog` (`source_id`, `source_revision`, `state`);
--> statement-breakpoint

CREATE TABLE `event_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type_id` text NOT NULL,
	`event_type_revision` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`subject_type` text NOT NULL,
	`subject_ref` text NOT NULL,
	`subscriber_kind` text NOT NULL,
	`subscriber_ref` text NOT NULL,
	`active_identity_key` text,
	`state` text NOT NULL DEFAULT 'active',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`cancelled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_subscriptions_active_identity_unique` ON `event_subscriptions` (`active_identity_key`) WHERE `active_identity_key` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_event_subscriptions_fanout` ON `event_subscriptions` (`event_type_id`, `event_type_revision`, `subject_type`, `subject_ref`, `state`);
--> statement-breakpoint
CREATE INDEX `idx_event_subscriptions_subscriber` ON `event_subscriptions` (`subscriber_kind`, `subscriber_ref`, `state`);
--> statement-breakpoint

CREATE TABLE `observer_activations` (
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`subscriber_count` integer NOT NULL DEFAULT 0,
	`state` text NOT NULL DEFAULT 'idle',
	`generation` integer NOT NULL DEFAULT 0,
	`wake_epoch` integer NOT NULL DEFAULT 0,
	`cursor_json` text,
	`lease_owner` text,
	`lease_epoch` integer NOT NULL DEFAULT 0,
	`lease_expires_at` integer,
	`next_scan_at` integer,
	`last_scan_at` integer,
	`last_success_at` integer,
	`last_error_code` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `source_revision`)
);
--> statement-breakpoint
CREATE INDEX `idx_observer_activations_due` ON `observer_activations` (`state`, `next_scan_at`, `lease_expires_at`);
--> statement-breakpoint

CREATE TABLE `event_observer_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`generation` integer NOT NULL,
	`lease_epoch` integer NOT NULL,
	`wake_epoch` integer NOT NULL,
	`cursor_before_json` text,
	`cursor_after_json` text,
	`state` text NOT NULL,
	`observation_count` integer NOT NULL DEFAULT 0,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error_code` text,
	`error_detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_event_observer_runs_source` ON `event_observer_runs` (`source_id`, `source_revision`, `started_at`);
--> statement-breakpoint

CREATE TABLE `event_records` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type_id` text NOT NULL,
	`event_type_revision` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`subject_type` text NOT NULL,
	`subject_ref` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`summary_json` text NOT NULL,
	`payload_artifact_ref` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_records_source_dedupe_unique` ON `event_records` (`source_id`, `source_revision`, `dedupe_key`);
--> statement-breakpoint
CREATE INDEX `idx_event_records_subject` ON `event_records` (`subject_type`, `subject_ref`, `occurred_at`);
--> statement-breakpoint

CREATE TABLE `event_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL REFERENCES `event_records`(`id`),
	`subscription_id` text NOT NULL REFERENCES `event_subscriptions`(`id`),
	`subscriber_kind` text NOT NULL,
	`subscriber_ref` text NOT NULL,
	`delivery_class` text NOT NULL,
	`priority` integer NOT NULL,
	`state` text NOT NULL DEFAULT 'pending',
	`attempt_count` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	`accepted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_deliveries_event_subscription_unique` ON `event_deliveries` (`event_id`, `subscription_id`);
--> statement-breakpoint
CREATE INDEX `idx_event_deliveries_pending` ON `event_deliveries` (`subscriber_kind`, `subscriber_ref`, `state`, `priority`, `created_at`);
--> statement-breakpoint

CREATE TABLE `employee_os_writer_state` (
	`id` text PRIMARY KEY NOT NULL,
	`active_generation` integer NOT NULL,
	`mode` text NOT NULL,
	`legacy_admissions_enabled` integer NOT NULL,
	`legacy_open_mission_count` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `employee_os_writer_state` (
	`id`, `active_generation`, `mode`, `legacy_admissions_enabled`,
	`legacy_open_mission_count`, `updated_at`
) VALUES ('global', 0, 'pre-cutover', 1, 0, unixepoch() * 1000);
--> statement-breakpoint

CREATE TABLE `employee_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`employee_revision` integer NOT NULL,
	`type_id` text NOT NULL,
	`type_revision` integer NOT NULL,
	`primary_context_id` text NOT NULL,
	`execution_policy_revision` integer NOT NULL,
	`state` text NOT NULL DEFAULT 'active',
	`terminal_kind` text,
	`block_reason` text,
	`current_work_item_ref` text,
	`active_round_id` text,
	`revision` integer NOT NULL DEFAULT 1,
	`writer_generation` integer NOT NULL DEFAULT 1,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`terminal_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_employee_cases_employee_state` ON `employee_cases` (`employee_id`, `employee_revision`, `state`, `updated_at`);
--> statement-breakpoint

CREATE TABLE `employee_case_workspaces` (
	`case_id` text PRIMARY KEY NOT NULL REFERENCES `employee_cases`(`id`),
	`repository_id` text NOT NULL,
	`cached_repo_id` text NOT NULL,
	`baseline_sha` text NOT NULL,
	`target_branch` text NOT NULL,
	`source_branch` text NOT NULL,
	`remote_head_sha` text,
	`state` text NOT NULL DEFAULT 'active',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_employee_case_workspaces_repo_state` ON `employee_case_workspaces` (`repository_id`, `state`, `updated_at`);
--> statement-breakpoint

CREATE TABLE `employee_round_workspace_states` (
	`round_id` text NOT NULL REFERENCES `employee_reaction_rounds`(`id`),
	`attempt_ordinal` integer NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`baseline_sha` text NOT NULL,
	`pre_state_json` text NOT NULL,
	`checkpoint_digest` text NOT NULL,
	`validation_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`round_id`, `attempt_ordinal`)
);
--> statement-breakpoint
CREATE INDEX `idx_employee_round_workspace_case` ON `employee_round_workspace_states` (`case_id`, `created_at`);
--> statement-breakpoint

CREATE TABLE `employee_change_candidates` (
	`candidate_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`round_id` text NOT NULL REFERENCES `employee_reaction_rounds`(`id`),
	`baseline_sha` text NOT NULL,
	`tree_oid` text NOT NULL,
	`receipt_json` text NOT NULL,
	`summary_source` text NOT NULL,
	`state` text NOT NULL DEFAULT 'prepared',
	`commit_sha` text,
	`push_receipt_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_change_candidates_round_unique` ON `employee_change_candidates` (`round_id`);
--> statement-breakpoint
CREATE INDEX `idx_employee_change_candidates_case_state` ON `employee_change_candidates` (`case_id`, `state`, `updated_at`);
--> statement-breakpoint

CREATE TABLE `employee_context_records` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`type_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`current_revision` integer NOT NULL,
	`lifecycle_state` text NOT NULL,
	`state_json` text NOT NULL,
	`artifact_refs_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_employee_context_case_type` ON `employee_context_records` (`case_id`, `type_id`, `lifecycle_state`);
--> statement-breakpoint

CREATE TABLE `employee_context_revisions` (
	`context_id` text NOT NULL REFERENCES `employee_context_records`(`id`),
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`artifact_refs_json` text NOT NULL,
	`content_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`context_id`, `revision`)
);
--> statement-breakpoint

CREATE TABLE `employee_context_links` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`from_context_id` text NOT NULL,
	`relation` text NOT NULL,
	`to_context_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_context_links_identity_unique` ON `employee_context_links` (`case_id`, `from_context_id`, `relation`, `to_context_id`);
--> statement-breakpoint

CREATE TABLE `employee_external_context_bindings` (
	`subject_type` text NOT NULL,
	`subject_ref` text NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`context_id` text NOT NULL REFERENCES `employee_context_records`(`id`),
	`binding_revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`subject_type`, `subject_ref`)
);
--> statement-breakpoint

CREATE TABLE `employee_attention_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`context_id` text NOT NULL REFERENCES `employee_context_records`(`id`),
	`context_revision` integer NOT NULL,
	`event_type_id` text NOT NULL,
	`event_type_revision` integer NOT NULL,
	`subject_type` text NOT NULL,
	`subject_ref` text NOT NULL,
	`desired_identity_key` text NOT NULL,
	`event_subscription_id` text,
	`state` text NOT NULL DEFAULT 'desired',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_attention_desired_identity_unique` ON `employee_attention_bindings` (`desired_identity_key`);
--> statement-breakpoint
CREATE INDEX `idx_employee_attention_case_state` ON `employee_attention_bindings` (`case_id`, `state`, `updated_at`);
--> statement-breakpoint

CREATE TABLE `employee_os_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text REFERENCES `employee_cases`(`id`),
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`state` text NOT NULL DEFAULT 'pending',
	`attempt_count` integer NOT NULL DEFAULT 0,
	`next_attempt_at` integer NOT NULL,
	`claimed_by` text,
	`claim_expires_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_os_outbox_dedupe_unique` ON `employee_os_outbox` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `idx_employee_os_outbox_due` ON `employee_os_outbox` (`state`, `next_attempt_at`, `claim_expires_at`);
--> statement-breakpoint

CREATE TABLE `employee_case_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`delivery_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type_id` text NOT NULL,
	`event_type_revision` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`subject_type` text NOT NULL,
	`subject_ref` text NOT NULL,
	`delivery_class` text NOT NULL,
	`priority` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`summary` text NOT NULL,
	`payload_artifact_ref` text,
	`state` text NOT NULL DEFAULT 'pending',
	`round_id` text,
	`accepted_at` integer NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_case_inbox_delivery_unique` ON `employee_case_inbox` (`delivery_id`);
--> statement-breakpoint
CREATE INDEX `idx_employee_case_inbox_queue` ON `employee_case_inbox` (`case_id`, `state`, `priority`, `occurred_at`, `event_id`);
--> statement-breakpoint

CREATE TABLE `employee_reaction_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`case_revision` integer NOT NULL,
	`inbox_id` text REFERENCES `employee_case_inbox`(`id`),
	`employee_id` text NOT NULL,
	`employee_revision` integer NOT NULL,
	`rule_id` text NOT NULL,
	`work_item_ref` text NOT NULL,
	`work_contract_id` text NOT NULL,
	`work_contract_version` integer NOT NULL,
	`tool_id` text,
	`tool_revision` integer,
	`execution_policy_revision` integer NOT NULL,
	`input_context_refs_json` text NOT NULL,
	`plan_json` text NOT NULL,
	`state` text NOT NULL DEFAULT 'planned',
	`execution_ref` text,
	`output_json` text,
	`attempt_ordinal` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_reaction_rounds_inbox_unique` ON `employee_reaction_rounds` (`inbox_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_reaction_rounds_one_active` ON `employee_reaction_rounds` (`case_id`) WHERE `state` IN ('planned', 'running', 'settling');
--> statement-breakpoint
CREATE INDEX `idx_employee_reaction_rounds_execution` ON `employee_reaction_rounds` (`execution_ref`, `state`);
--> statement-breakpoint

CREATE TABLE `employee_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`parent_case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`parent_round_id` text NOT NULL REFERENCES `employee_reaction_rounds`(`id`),
	`target_employee_id` text NOT NULL,
	`target_employee_revision` integer NOT NULL,
	`target_work_scope_ref_json` text NOT NULL,
	`input_envelope_ref` text NOT NULL,
	`input_digest` text NOT NULL,
	`completion_contract_ref_json` text NOT NULL,
	`deadline_at` integer NOT NULL,
	`child_case_id` text,
	`state` text NOT NULL DEFAULT 'requested',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_invocations_idempotency_unique` ON `employee_invocations` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_employee_invocations_parent_state` ON `employee_invocations` (`parent_case_id`, `state`, `deadline_at`);
--> statement-breakpoint

CREATE TABLE `employee_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL REFERENCES `employee_invocations`(`id`),
	`parent_case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`child_case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`correlation_ref` text NOT NULL,
	`result_contract_ref_json` text NOT NULL,
	`state` text NOT NULL DEFAULT 'open',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_channels_invocation_unique` ON `employee_channels` (`invocation_id`);
--> statement-breakpoint

CREATE TABLE `employee_channel_results` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL REFERENCES `employee_channels`(`id`),
	`milestone_type` text NOT NULL,
	`envelope_json` text NOT NULL,
	`envelope_digest` text NOT NULL,
	`monotonic` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_channel_results_identity_unique` ON `employee_channel_results` (`channel_id`, `milestone_type`, `envelope_digest`);
--> statement-breakpoint

CREATE TABLE `employee_approval_sagas` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL REFERENCES `employee_cases`(`id`),
	`submit_round_id` text NOT NULL REFERENCES `employee_reaction_rounds`(`id`),
	`adapter_id` text NOT NULL,
	`adapter_revision` integer NOT NULL,
	`validated_draft_ref` text NOT NULL,
	`deadline_at` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`intent_digest` text NOT NULL,
	`correlation_ref` text,
	`external_request_ref` text,
	`submitted_revision` text,
	`submitted_at` text,
	`latest_status` text NOT NULL DEFAULT 'prepared',
	`observed_revision` text,
	`evidence_ref` text,
	`observed_at` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_approval_sagas_idempotency_unique` ON `employee_approval_sagas` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_approval_sagas_correlation_unique` ON `employee_approval_sagas` (`adapter_id`, `adapter_revision`, `correlation_ref`) WHERE `correlation_ref` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_employee_approval_sagas_case_state` ON `employee_approval_sagas` (`case_id`, `latest_status`, `updated_at`);
