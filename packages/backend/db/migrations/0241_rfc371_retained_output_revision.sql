CREATE TABLE "observation_report_retained_revisions" ("report_id" text PRIMARY KEY NOT NULL, "revision" text NOT NULL, FOREIGN KEY ("report_id") REFERENCES "observation_reports"("id") ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE TRIGGER "observation_report_pages_retained_insert" AFTER INSERT ON "observation_report_pages" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = NEW."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_pages_retained_update" AFTER UPDATE ON "observation_report_pages" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = OLD."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = NEW."report_id" AND "state" <> 'building' AND NEW."report_id" <> OLD."report_id" ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_pages_retained_delete" AFTER DELETE ON "observation_report_pages" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = OLD."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_rows_retained_insert" AFTER INSERT ON "observation_report_rows" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = NEW."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_rows_retained_update" AFTER UPDATE ON "observation_report_rows" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = OLD."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = NEW."report_id" AND "state" <> 'building' AND NEW."report_id" <> OLD."report_id" ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_rows_retained_delete" AFTER DELETE ON "observation_report_rows" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = OLD."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_counts_retained_insert" AFTER INSERT ON "observation_report_counts" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = NEW."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_counts_retained_update" AFTER UPDATE ON "observation_report_counts" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = OLD."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = NEW."report_id" AND "state" <> 'building' AND NEW."report_id" <> OLD."report_id" ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_counts_retained_delete" AFTER DELETE ON "observation_report_counts" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = OLD."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_receipts_retained_insert" AFTER INSERT ON "observation_report_receipts" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = NEW."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_receipts_retained_update" AFTER UPDATE ON "observation_report_receipts" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = OLD."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = NEW."report_id" AND "state" <> 'building' AND NEW."report_id" <> OLD."report_id" ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
--> statement-breakpoint
CREATE TRIGGER "observation_report_receipts_retained_delete" AFTER DELETE ON "observation_report_receipts" BEGIN
INSERT INTO "observation_report_retained_revisions" ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = OLD."report_id" AND "state" <> 'building' ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";
END;
