-- table: observation_report_retained_revisions
CREATE TABLE "agent_workflow"."observation_report_retained_revisions" (
  "report_id" TEXT COLLATE "C" NOT NULL,
  "revision" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "observation_report_retained_revisions_pkey" PRIMARY KEY ("report_id")
);

-- constraint: observation_report_retained_revisions:fk:observation_report_retained_revisions_report_id_observation_reports_id_fk
ALTER TABLE "agent_workflow"."observation_report_retained_revisions" ADD CONSTRAINT "observation_report_retained_revisions_report_id_ob_4f98a17976d2" FOREIGN KEY ("report_id") REFERENCES "agent_workflow"."observation_reports" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- function: observation_report_retained_revisions:insert
CREATE FUNCTION "agent_workflow"."observation_report_retained_insert"() RETURNS trigger LANGUAGE plpgsql AS $aw_retained$
DECLARE target_report RECORD;
BEGIN
  FOR target_report IN SELECT p."id", p."state" FROM "agent_workflow"."observation_reports" p JOIN (SELECT DISTINCT "report_id" FROM aw_new_rows) affected ON affected."report_id" = p."id" ORDER BY p."id" FOR UPDATE OF p LOOP
    IF target_report."state" <> 'building' THEN
      INSERT INTO "agent_workflow"."observation_report_retained_revisions" ("report_id", "revision") VALUES (target_report."id", gen_random_uuid()::text) ON CONFLICT ("report_id") DO UPDATE SET "revision" = EXCLUDED."revision";
    END IF;
  END LOOP;
  RETURN NULL;
END;
$aw_retained$;

-- function: observation_report_retained_revisions:update
CREATE FUNCTION "agent_workflow"."observation_report_retained_update"() RETURNS trigger LANGUAGE plpgsql AS $aw_retained$
DECLARE target_report RECORD;
BEGIN
  FOR target_report IN SELECT p."id", p."state" FROM "agent_workflow"."observation_reports" p JOIN (SELECT "report_id" FROM aw_old_rows UNION SELECT "report_id" FROM aw_new_rows) affected ON affected."report_id" = p."id" ORDER BY p."id" FOR UPDATE OF p LOOP
    IF target_report."state" <> 'building' THEN
      INSERT INTO "agent_workflow"."observation_report_retained_revisions" ("report_id", "revision") VALUES (target_report."id", gen_random_uuid()::text) ON CONFLICT ("report_id") DO UPDATE SET "revision" = EXCLUDED."revision";
    END IF;
  END LOOP;
  RETURN NULL;
END;
$aw_retained$;

-- function: observation_report_retained_revisions:delete
CREATE FUNCTION "agent_workflow"."observation_report_retained_delete"() RETURNS trigger LANGUAGE plpgsql AS $aw_retained$
DECLARE target_report RECORD;
BEGIN
  FOR target_report IN SELECT p."id", p."state" FROM "agent_workflow"."observation_reports" p JOIN (SELECT DISTINCT "report_id" FROM aw_old_rows) affected ON affected."report_id" = p."id" ORDER BY p."id" FOR UPDATE OF p LOOP
    IF target_report."state" <> 'building' THEN
      INSERT INTO "agent_workflow"."observation_report_retained_revisions" ("report_id", "revision") VALUES (target_report."id", gen_random_uuid()::text) ON CONFLICT ("report_id") DO UPDATE SET "revision" = EXCLUDED."revision";
    END IF;
  END LOOP;
  RETURN NULL;
END;
$aw_retained$;

-- trigger: observation_report_pages:retained:insert
CREATE TRIGGER "observation_report_pages_retained_insert" AFTER INSERT ON "agent_workflow"."observation_report_pages" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_insert"();

-- trigger: observation_report_pages:retained:update
CREATE TRIGGER "observation_report_pages_retained_update" AFTER UPDATE ON "agent_workflow"."observation_report_pages" REFERENCING OLD TABLE AS aw_old_rows NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_update"();

-- trigger: observation_report_pages:retained:delete
CREATE TRIGGER "observation_report_pages_retained_delete" AFTER DELETE ON "agent_workflow"."observation_report_pages" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_delete"();

-- trigger: observation_report_rows:retained:insert
CREATE TRIGGER "observation_report_rows_retained_insert" AFTER INSERT ON "agent_workflow"."observation_report_rows" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_insert"();

-- trigger: observation_report_rows:retained:update
CREATE TRIGGER "observation_report_rows_retained_update" AFTER UPDATE ON "agent_workflow"."observation_report_rows" REFERENCING OLD TABLE AS aw_old_rows NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_update"();

-- trigger: observation_report_rows:retained:delete
CREATE TRIGGER "observation_report_rows_retained_delete" AFTER DELETE ON "agent_workflow"."observation_report_rows" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_delete"();

-- trigger: observation_report_counts:retained:insert
CREATE TRIGGER "observation_report_counts_retained_insert" AFTER INSERT ON "agent_workflow"."observation_report_counts" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_insert"();

-- trigger: observation_report_counts:retained:update
CREATE TRIGGER "observation_report_counts_retained_update" AFTER UPDATE ON "agent_workflow"."observation_report_counts" REFERENCING OLD TABLE AS aw_old_rows NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_update"();

-- trigger: observation_report_counts:retained:delete
CREATE TRIGGER "observation_report_counts_retained_delete" AFTER DELETE ON "agent_workflow"."observation_report_counts" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_delete"();

-- trigger: observation_report_receipts:retained:insert
CREATE TRIGGER "observation_report_receipts_retained_insert" AFTER INSERT ON "agent_workflow"."observation_report_receipts" REFERENCING NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_insert"();

-- trigger: observation_report_receipts:retained:update
CREATE TRIGGER "observation_report_receipts_retained_update" AFTER UPDATE ON "agent_workflow"."observation_report_receipts" REFERENCING OLD TABLE AS aw_old_rows NEW TABLE AS aw_new_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_update"();

-- trigger: observation_report_receipts:retained:delete
CREATE TRIGGER "observation_report_receipts_retained_delete" AFTER DELETE ON "agent_workflow"."observation_report_receipts" REFERENCING OLD TABLE AS aw_old_rows FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow"."observation_report_retained_delete"();

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:7123a13ba607ab51076656280e9bca40f36369df085f2c017693b8768eb63e11', active_table_count = 216, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:ad118eb1d59bd9930e60e1789b070e713b6a1bc596d6b1f964849195d2b1bb1c' RETURNING contract_digest;
