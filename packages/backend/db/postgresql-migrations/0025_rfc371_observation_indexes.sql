-- index: observation_projection_changes:index:observation_projection_changes_ready
CREATE INDEX "observation_projection_changes_ready" ON "agent_workflow"."observation_projection_changes" ("completed", "retry_at", "created_at", "id");

-- index: observation_projection_history:index:observation_projection_history_scope_day
CREATE INDEX "observation_projection_history_scope_day" ON "agent_workflow"."observation_projection_history" ("kind", "section", "component", "cohort_at", "key");

-- index: observation_projection_work:index:observation_projection_work_unapplied
CREATE INDEX "observation_projection_work_unapplied" ON "agent_workflow"."observation_projection_work" ("applied_revision", "id");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:aeaf35a854b78e2a6afa7c4d8c0b5fe8412dda9dcc742388defeff8ff5c29c0f', active_table_count = 252, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:6bd17728b5c120475ca8955d629b9c669a89087371adddeb2ee59da58585e1d7' RETURNING contract_digest;
