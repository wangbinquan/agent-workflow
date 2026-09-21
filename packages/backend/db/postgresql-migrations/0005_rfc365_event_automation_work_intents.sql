-- table: event_automation_work_intents
CREATE TABLE "agent_workflow"."event_automation_work_intents" (
  "origin_ref" TEXT COLLATE "C" NOT NULL,
  "delivery_id" TEXT COLLATE "C" NOT NULL,
  "subscription_id" TEXT COLLATE "C" NOT NULL,
  "rule_id" TEXT COLLATE "C" NOT NULL,
  "rule_revision" BIGINT NOT NULL,
  "rule_digest" TEXT COLLATE "C" NOT NULL,
  "owner_user_id" TEXT COLLATE "C" NOT NULL,
  "port_id" TEXT COLLATE "C" NOT NULL,
  "target_payload_json" TEXT COLLATE "C" NOT NULL,
  "target_format_version" BIGINT NOT NULL DEFAULT 1,
  "target_digest" TEXT COLLATE "C" NOT NULL,
  "resolved_target_ref" TEXT COLLATE "C" NOT NULL,
  "receipt_ref" TEXT COLLATE "C",
  "status" TEXT COLLATE "C" NOT NULL DEFAULT 'prepared',
  "claim_owner" TEXT COLLATE "C" NOT NULL,
  "claim_attempt" BIGINT NOT NULL,
  "last_error" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "event_automation_work_intents_pkey" PRIMARY KEY ("origin_ref")
);

-- index: event_automation_work_intents:index:event_automation_work_intents_delivery_unique
CREATE UNIQUE INDEX "event_automation_work_intents_delivery_unique" ON "agent_workflow"."event_automation_work_intents" ("delivery_id");

-- index: event_automation_work_intents:index:event_automation_work_intents_origin_port_unique
CREATE UNIQUE INDEX "event_automation_work_intents_origin_port_unique" ON "agent_workflow"."event_automation_work_intents" ("origin_ref", "port_id");

-- index: event_automation_work_intents:index:idx_event_automation_work_intents_status
CREATE INDEX "idx_event_automation_work_intents_status" ON "agent_workflow"."event_automation_work_intents" ("status", "updated_at");

-- constraint: event_automation_work_intents:fk:event_automation_work_intents_delivery_id_event_deliveries_id_fk
ALTER TABLE "agent_workflow"."event_automation_work_intents" ADD CONSTRAINT "event_automation_work_intents_delivery_id_event_de_cadd1fff97f2" FOREIGN KEY ("delivery_id") REFERENCES "agent_workflow"."event_deliveries" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:1c5c6ed6ba01159c5bd73a92fe1b5f24ec9920a6395d41c77ec687c71502d6da', active_table_count = 183, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:a27693137b6fd52a93912ee8d0e204ae58bb685bdcd2d80eb98538f9e07c9286' RETURNING contract_digest;
