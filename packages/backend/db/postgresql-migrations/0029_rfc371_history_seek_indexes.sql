-- index: observation_projection_history:index:observation_projection_history_section_seek
CREATE INDEX "observation_projection_history_section_seek" ON "agent_workflow"."observation_projection_history" ("kind", "section", "key");

-- index: observation_projection_history:index:observation_projection_history_parent_seek
CREATE INDEX "observation_projection_history_parent_seek" ON "agent_workflow"."observation_projection_history" ("kind", "section", "parent", "key");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:eb43cc8054f008f9a44ea7cc7e67464b09cebfa15ae2db08d09b65b9ccd519af', active_table_count = 268, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:a467469ed6c6b065395211bd72c2c6434ad1155ed5cd3a528ad1f65f623dac7b' RETURNING contract_digest;
