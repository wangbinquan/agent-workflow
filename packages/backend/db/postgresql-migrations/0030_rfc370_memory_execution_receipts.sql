-- table: memory_distill_execution_receipts
CREATE TABLE "agent_workflow"."memory_distill_execution_receipts" (
  "execution_ref" TEXT COLLATE "C" NOT NULL,
  "job_id" TEXT COLLATE "C" NOT NULL,
  "attempt_index" BIGINT NOT NULL,
  "round_index" BIGINT NOT NULL,
  "context_json" TEXT COLLATE "C" NOT NULL,
  "retained_ref" TEXT COLLATE "C" NOT NULL,
  "recovery_ref" TEXT COLLATE "C",
  "started_at" BIGINT,
  "prepared_at" BIGINT NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "terminal_json" TEXT COLLATE "C",
  "settlement" TEXT COLLATE "C",
  CONSTRAINT "memory_distill_execution_receipts_pkey" PRIMARY KEY ("execution_ref")
);

-- index: memory_distill_execution_receipts:index:idx_distill_execution_job_attempt
CREATE INDEX "idx_distill_execution_job_attempt" ON "agent_workflow"."memory_distill_execution_receipts" ("job_id", "attempt_index", "round_index");

-- index: memory_distill_execution_receipts:index:idx_distill_execution_state_prepared
CREATE INDEX "idx_distill_execution_state_prepared" ON "agent_workflow"."memory_distill_execution_receipts" ("state", "prepared_at");

-- constraint: memory_distill_execution_receipts:check:memory_distill_execution_receipts_state_enum
ALTER TABLE "agent_workflow"."memory_distill_execution_receipts" ADD CONSTRAINT "memory_distill_execution_receipts_state_enum" CHECK ("state" IN ('prepared', 'started', 'terminal', 'reaped', 'closed'));

-- constraint: memory_distill_execution_receipts:check:memory_distill_execution_receipts_attempt_nonnegative
ALTER TABLE "agent_workflow"."memory_distill_execution_receipts" ADD CONSTRAINT "memory_distill_execution_receipts_attempt_nonnegative" CHECK ("attempt_index" >= 0);

-- constraint: memory_distill_execution_receipts:check:memory_distill_execution_receipts_round_nonnegative
ALTER TABLE "agent_workflow"."memory_distill_execution_receipts" ADD CONSTRAINT "memory_distill_execution_receipts_round_nonnegative" CHECK ("round_index" >= 0);

-- constraint: memory_distill_execution_receipts:check:memory_distill_execution_receipts_context_json_valid
ALTER TABLE "agent_workflow"."memory_distill_execution_receipts" ADD CONSTRAINT "memory_distill_execution_receipts_context_json_valid" CHECK (json_valid("context_json"));

-- constraint: memory_distill_execution_receipts:check:memory_distill_execution_receipts_terminal_json_valid
ALTER TABLE "agent_workflow"."memory_distill_execution_receipts" ADD CONSTRAINT "memory_distill_execution_receipts_terminal_json_valid" CHECK ("terminal_json" IS NULL OR json_valid("terminal_json"));

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:3cc614cfbea2a089604a914d4a6f19f54c47ed160ba369ad823e78f1994dd58b', active_table_count = 269, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:eb43cc8054f008f9a44ea7cc7e67464b09cebfa15ae2db08d09b65b9ccd519af' RETURNING contract_digest;
