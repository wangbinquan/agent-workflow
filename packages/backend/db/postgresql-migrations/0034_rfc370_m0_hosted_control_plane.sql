-- table: application_configuration
CREATE TABLE "agent_workflow"."application_configuration" (
  "id" TEXT COLLATE "C" NOT NULL,
  "document" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "application_configuration_pkey" PRIMARY KEY ("id")
);

-- table: external_identities
CREATE TABLE "agent_workflow"."external_identities" (
  "id" TEXT COLLATE "C" NOT NULL,
  "issuer" TEXT COLLATE "C" NOT NULL,
  "subject" TEXT COLLATE "C" NOT NULL,
  "user_id" TEXT COLLATE "C" NOT NULL,
  "linked_at" BIGINT NOT NULL,
  CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- table: skill_content_entries
CREATE TABLE "agent_workflow"."skill_content_entries" (
  "skill_id" TEXT COLLATE "C" NOT NULL,
  "tree" TEXT COLLATE "C" NOT NULL,
  "path" TEXT COLLATE "C" NOT NULL,
  "encoding" TEXT COLLATE "C" NOT NULL,
  "content" TEXT COLLATE "C" NOT NULL,
  "size" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "skill_content_entries_pkey" PRIMARY KEY ("skill_id", "tree", "path")
);

-- index: external_identities:index:idx_external_identities_user
CREATE INDEX "idx_external_identities_user" ON "agent_workflow"."external_identities" ("user_id");

-- index: external_identities:index:external_identities_issuer_subject_unique
CREATE UNIQUE INDEX "external_identities_issuer_subject_unique" ON "agent_workflow"."external_identities" ("issuer", "subject");

-- constraint: application_configuration:check:application_configuration_id_fixed
ALTER TABLE "agent_workflow"."application_configuration" ADD CONSTRAINT "application_configuration_id_fixed" CHECK ("id" = 'global');

-- constraint: external_identities:fk:external_identities_user_id_users_id_fk
ALTER TABLE "agent_workflow"."external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "agent_workflow"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: skill_content_entries:check:skill_content_entries_encoding_enum
ALTER TABLE "agent_workflow"."skill_content_entries" ADD CONSTRAINT "skill_content_entries_encoding_enum" CHECK ("encoding" IN ('utf8', 'base64'));

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:9a9f65081c639b1d354a58e543207a8bf87c68d33797a321a338c23720228493', active_table_count = 192, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:6eb9dac29f4c6e0d2740931a221f51e277b1b7a5be785c5af4bf87784ce3afc3' RETURNING contract_digest;
