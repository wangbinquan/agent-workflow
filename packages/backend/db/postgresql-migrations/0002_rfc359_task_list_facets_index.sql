-- index: tasks:index:idx_tasks_list_facets_cover
CREATE INDEX "idx_tasks_list_facets_cover" ON "agent_workflow"."tasks" ("catalog_visibility", "source_agent_name", "workgroup_id", "status", "id");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:0a8fe7af8576c0642020a55a1609f2fe48df69a22459234ba785f2148a69f4d4', active_table_count = 178, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:4cf10ecd7bdb13887e94766ac7ef16df4d4c2b3b6e68a08b481685ad1629cf94' RETURNING contract_digest;
