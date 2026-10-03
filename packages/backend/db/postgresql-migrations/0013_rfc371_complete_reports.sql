-- table: observation_report_counts
CREATE TABLE "agent_workflow"."observation_report_counts" (
  "report_id" TEXT COLLATE "C" NOT NULL,
  "section" TEXT COLLATE "C" NOT NULL,
  "parent" TEXT COLLATE "C" NOT NULL,
  "total" TEXT COLLATE "C" NOT NULL DEFAULT '0',
  "actual" TEXT COLLATE "C" NOT NULL DEFAULT '0',
  "declared" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "observation_report_counts_pkey" PRIMARY KEY ("report_id", "section", "parent")
);

-- table: observation_report_pages
CREATE TABLE "agent_workflow"."observation_report_pages" (
  "report_id" TEXT COLLATE "C" NOT NULL,
  "ordinal" TEXT COLLATE "C" NOT NULL,
  "previous_digest" TEXT COLLATE "C" NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  "items_count" BIGINT NOT NULL,
  CONSTRAINT "observation_report_pages_pkey" PRIMARY KEY ("report_id", "ordinal")
);

-- table: observation_report_receipts
CREATE TABLE "agent_workflow"."observation_report_receipts" (
  "report_id" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_report_receipts_pkey" PRIMARY KEY ("report_id", "key")
);

-- table: observation_report_rows
CREATE TABLE "agent_workflow"."observation_report_rows" (
  "report_id" TEXT COLLATE "C" NOT NULL,
  "ordinal" TEXT COLLATE "C" NOT NULL,
  "section" TEXT COLLATE "C" NOT NULL,
  "parent" TEXT COLLATE "C" NOT NULL,
  "key" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_report_rows_pkey" PRIMARY KEY ("report_id", "ordinal")
);

-- table: observation_reports
CREATE TABLE "agent_workflow"."observation_reports" (
  "id" TEXT COLLATE "C" NOT NULL,
  "request_key" TEXT COLLATE "C" NOT NULL,
  "generation" TEXT COLLATE "C" NOT NULL,
  "owner" TEXT COLLATE "C" NOT NULL,
  "actor_scope" TEXT COLLATE "C" NOT NULL,
  "request" TEXT COLLATE "C" NOT NULL,
  "state" TEXT COLLATE "C" NOT NULL,
  "report" TEXT COLLATE "C" NOT NULL,
  "manifest" TEXT COLLATE "C",
  "progress" TEXT COLLATE "C" NOT NULL,
  "lease_until" BIGINT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "observation_reports_pkey" PRIMARY KEY ("id")
);

-- index: observation_report_rows:index:observation_report_row_identity_idx
CREATE UNIQUE INDEX "observation_report_row_identity_idx" ON "agent_workflow"."observation_report_rows" ("report_id", "section", "parent", "key");

-- index: observation_report_rows:index:observation_report_row_page_idx
CREATE INDEX "observation_report_row_page_idx" ON "agent_workflow"."observation_report_rows" ("report_id", "section", "parent", "ordinal");

-- index: observation_reports:index:observation_report_request_idx
CREATE UNIQUE INDEX "observation_report_request_idx" ON "agent_workflow"."observation_reports" ("request_key");

-- index: observation_reports:index:observation_report_recovery_idx
CREATE INDEX "observation_report_recovery_idx" ON "agent_workflow"."observation_reports" ("state", "lease_until");

-- constraint: observation_report_counts:fk:observation_report_counts_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_counts" ADD CONSTRAINT "observation_report_counts_report_id_observation_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "agent_workflow"."observation_reports" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: observation_report_pages:check:observation_report_page_size_ck
ALTER TABLE "agent_workflow"."observation_report_pages" ADD CONSTRAINT "observation_report_page_size_ck" CHECK ("items_count" BETWEEN 1 AND 500);

-- constraint: observation_report_pages:fk:observation_report_pages_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_pages" ADD CONSTRAINT "observation_report_pages_report_id_observation_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "agent_workflow"."observation_reports" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: observation_report_receipts:fk:observation_report_receipts_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_receipts" ADD CONSTRAINT "observation_report_receipts_report_id_observation_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "agent_workflow"."observation_reports" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: observation_report_rows:fk:observation_report_rows_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_rows" ADD CONSTRAINT "observation_report_rows_report_id_observation_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "agent_workflow"."observation_reports" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: observation_reports:check:observation_report_state_ck
ALTER TABLE "agent_workflow"."observation_reports" ADD CONSTRAINT "observation_report_state_ck" CHECK ("state" IN ('building','not-ready','failed','ready'));

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:a76becc4828a1999aca866a29860fa5ba23e6cad21fd9eecbe48434fe8f18cc1', active_table_count = 202, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:adabb68099bbd7e59fd320b658db36b20786fcaecafe8994a0721f624e0bdaa6' RETURNING contract_digest;
