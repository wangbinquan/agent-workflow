-- table: employee_reaction_artifacts
CREATE TABLE "agent_workflow"."employee_reaction_artifacts" (
  "digest" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "body" TEXT COLLATE "C" NOT NULL,
  "bytes" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "employee_reaction_artifacts_pkey" PRIMARY KEY ("digest")
);

-- table: employee_reaction_dispatch
CREATE TABLE "agent_workflow"."employee_reaction_dispatch" (
  "round_ref" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "claim_epoch" BIGINT NOT NULL DEFAULT 0,
  "next_attempt_at" BIGINT NOT NULL DEFAULT 0,
  "dispatch_attempts" BIGINT NOT NULL DEFAULT 0,
  "dispatch_claimed_by" TEXT COLLATE "C",
  "dispatch_lease_expires_at" BIGINT,
  "last_dispatch_error" TEXT COLLATE "C",
  "operation_ref" TEXT COLLATE "C",
  "retry_feedback_ref" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "employee_reaction_dispatch_pkey" PRIMARY KEY ("round_ref")
);

-- table: reaction_execution_admissions
CREATE TABLE "agent_workflow"."reaction_execution_admissions" (
  "operation_ref" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "round_ref" TEXT COLLATE "C" NOT NULL,
  "claim_epoch" BIGINT NOT NULL,
  "fence_revision" BIGINT NOT NULL,
  "request_hash" TEXT COLLATE "C" NOT NULL,
  "authority_subject" TEXT COLLATE "C" NOT NULL,
  "authority_revision" BIGINT NOT NULL,
  "execution_ref" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL DEFAULT 'admitted',
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "reaction_execution_admissions_pkey" PRIMARY KEY ("operation_ref")
);

-- index: employee_reaction_artifacts:index:idx_employee_reaction_artifacts_kind
CREATE INDEX "idx_employee_reaction_artifacts_kind" ON "agent_workflow"."employee_reaction_artifacts" ("kind", "created_at");

-- index: employee_reaction_dispatch:index:idx_employee_reaction_dispatch_due
CREATE INDEX "idx_employee_reaction_dispatch_due" ON "agent_workflow"."employee_reaction_dispatch" ("next_attempt_at", "dispatch_lease_expires_at");

-- index: employee_reaction_dispatch:index:idx_employee_reaction_dispatch_case
CREATE INDEX "idx_employee_reaction_dispatch_case" ON "agent_workflow"."employee_reaction_dispatch" ("case_id");

-- index: reaction_execution_admissions:index:idx_reaction_execution_admissions_round
CREATE INDEX "idx_reaction_execution_admissions_round" ON "agent_workflow"."reaction_execution_admissions" ("round_ref", "claim_epoch");

-- index: reaction_execution_admissions:index:idx_reaction_execution_admissions_execution
CREATE INDEX "idx_reaction_execution_admissions_execution" ON "agent_workflow"."reaction_execution_admissions" ("execution_ref");

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:85b914204bdf43d5d3333d819113b3c226c22376465d4540f5d74d1ae7866bf0', active_table_count = 186, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:1c5c6ed6ba01159c5bd73a92fe1b5f24ec9920a6395d41c77ec687c71502d6da' RETURNING contract_digest;
