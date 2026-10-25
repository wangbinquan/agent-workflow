-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:b865c16370a06f33a96f5fe499f73c70c3e61b5125f7f3dac0303a5c350b6b1c', active_table_count = 216, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:3f8b275e388697cc6d9f5005dc3c9cf9acd70fe97c1bb00407223dfcf4d39743' RETURNING contract_digest;
