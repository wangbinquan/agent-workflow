-- table: development_designs
CREATE TABLE "agent_workflow"."development_designs" (
  "id" TEXT COLLATE "C" NOT NULL,
  "case_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "presentation_json" TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  "presentation_revision" BIGINT NOT NULL DEFAULT 1,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "development_designs_pkey" PRIMARY KEY ("id")
);

-- table: development_design_revisions
CREATE TABLE "agent_workflow"."development_design_revisions" (
  "design_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "artifact_ref" TEXT COLLATE "C" NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  "request_id" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "development_design_revisions_pkey" PRIMARY KEY ("design_id", "revision")
);

-- table: development_design_proposals
CREATE TABLE "agent_workflow"."development_design_proposals" (
  "design_id" TEXT COLLATE "C" NOT NULL,
  "id" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "request_digest" TEXT COLLATE "C" NOT NULL,
  "status" TEXT COLLATE "C" NOT NULL,
  "version" BIGINT NOT NULL,
  "payload_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "development_design_proposals_pkey" PRIMARY KEY ("design_id", "id")
);

-- table: development_design_baselines
CREATE TABLE "agent_workflow"."development_design_baselines" (
  "design_id" TEXT COLLATE "C" NOT NULL,
  "id" TEXT COLLATE "C" NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  "artifact_ref" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "development_design_baselines_pkey" PRIMARY KEY ("design_id", "id")
);

-- table: development_design_links
CREATE TABLE "agent_workflow"."development_design_links" (
  "design_id" TEXT COLLATE "C" NOT NULL,
  "id" TEXT COLLATE "C" NOT NULL,
  "kind" TEXT COLLATE "C" NOT NULL,
  "payload_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "development_design_links_pkey" PRIMARY KEY ("design_id", "id")
);

-- index: development_designs:index:development_designs_case_uq
CREATE UNIQUE INDEX "development_designs_case_uq" ON "agent_workflow"."development_designs" ("case_id");

-- index: development_design_revisions:index:development_design_revisions_request_uq
CREATE UNIQUE INDEX "development_design_revisions_request_uq" ON "agent_workflow"."development_design_revisions" ("design_id", "request_id");

-- index: development_design_proposals:index:development_design_proposals_status_idx
CREATE INDEX "development_design_proposals_status_idx" ON "agent_workflow"."development_design_proposals" ("design_id", "kind", "status");

-- index: development_design_baselines:index:development_design_baselines_digest_idx
CREATE INDEX "development_design_baselines_digest_idx" ON "agent_workflow"."development_design_baselines" ("design_id", "digest");

-- index: development_design_links:index:development_design_links_kind_idx
CREATE INDEX "development_design_links_kind_idx" ON "agent_workflow"."development_design_links" ("design_id", "kind");

-- constraint: development_designs:check:development_designs_revision_ck
ALTER TABLE "agent_workflow"."development_designs" ADD CONSTRAINT "development_designs_revision_ck" CHECK ("revision" > 0 AND "presentation_revision" > 0);

-- constraint: development_design_revisions:check:development_design_revisions_revision_ck
ALTER TABLE "agent_workflow"."development_design_revisions" ADD CONSTRAINT "development_design_revisions_revision_ck" CHECK ("revision" > 0);

-- constraint: development_design_proposals:check:development_design_proposals_version_ck
ALTER TABLE "agent_workflow"."development_design_proposals" ADD CONSTRAINT "development_design_proposals_version_ck" CHECK ("version" > 0);

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:3f8b275e388697cc6d9f5005dc3c9cf9acd70fe97c1bb00407223dfcf4d39743', active_table_count = 216, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:8e6510d4d0927d538692ecf22cde0b1fa9a97c733a9e044af8d9768418ecb956' RETURNING contract_digest;
