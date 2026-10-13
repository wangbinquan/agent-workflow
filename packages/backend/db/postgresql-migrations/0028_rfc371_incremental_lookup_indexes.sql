-- index: observation_projection_current:index:observation_projection_current_task
CREATE INDEX "observation_projection_current_task" ON "agent_workflow"."observation_projection_current" ("kind", "section", "task_id", "key");

-- index: observation_projection_current:index:observation_projection_current_section
CREATE INDEX "observation_projection_current_section" ON "agent_workflow"."observation_projection_current" ("kind", "section", "key");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:a467469ed6c6b065395211bd72c2c6434ad1155ed5cd3a528ad1f65f623dac7b', active_table_count = 268, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:756df370ab27436daa9e84cc9bf0c15db8eebc4a60bd0f04dbce903c247c8f1e' RETURNING contract_digest;
