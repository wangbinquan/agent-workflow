-- index: tasks:index:idx_tasks_cached_repo_task
CREATE INDEX "idx_tasks_cached_repo_task" ON "agent_workflow"."tasks" ("cached_repo_id", "id");

-- index: tasks:index:idx_tasks_overview_counts
CREATE INDEX "idx_tasks_overview_counts" ON "agent_workflow"."tasks" ("status", "parent_task_id", "catalog_visibility", "finished_at");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:4cf10ecd7bdb13887e94766ac7ef16df4d4c2b3b6e68a08b481685ad1629cf94', active_table_count = 178, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:9aabfa484e39f2fa45bfbd7e67a0cffe0b92ead58ebdfa69e14855ec80036b4e' RETURNING contract_digest;
