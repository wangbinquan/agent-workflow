-- table: retire:memory_distill_execution_receipts
DROP TABLE "agent_workflow"."memory_distill_execution_receipts";

-- table: retire:system_host_execution_write_contexts
DROP TABLE "agent_workflow"."system_host_execution_write_contexts";

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:6eb9dac29f4c6e0d2740931a221f51e277b1b7a5be785c5af4bf87784ce3afc3', active_table_count = 189, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:32c305d87968bc9cd4bf179e3f94d5cee2a92a8dc3cfa5fbfbce93f2336da22b' RETURNING contract_digest;
