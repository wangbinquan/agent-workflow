-- table: clarify_mindmap_command_receipts
CREATE TABLE "agent_workflow"."clarify_mindmap_command_receipts" (
  "session_id" TEXT COLLATE "C" NOT NULL,
  "request_id" TEXT COLLATE "C" NOT NULL,
  "request_digest" TEXT COLLATE "C" NOT NULL,
  "command_json" TEXT COLLATE "C" NOT NULL,
  "result_json" TEXT COLLATE "C" NOT NULL,
  "metadata_json" TEXT COLLATE "C" NOT NULL,
  "session_revision" BIGINT NOT NULL,
  "actor_id" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "clarify_mindmap_command_receipts_pkey" PRIMARY KEY ("session_id", "request_id")
);

-- table: clarify_mindmap_node_revisions
CREATE TABLE "agent_workflow"."clarify_mindmap_node_revisions" (
  "node_id" TEXT COLLATE "C" NOT NULL,
  "session_revision" BIGINT NOT NULL,
  "body_json" TEXT COLLATE "C" NOT NULL,
  "actor_id" TEXT COLLATE "C",
  "created_at" BIGINT NOT NULL,
  CONSTRAINT "clarify_mindmap_node_revisions_pkey" PRIMARY KEY ("node_id", "session_revision")
);

-- table: clarify_mindmap_nodes
CREATE TABLE "agent_workflow"."clarify_mindmap_nodes" (
  "id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "parent_id" TEXT COLLATE "C",
  "sort_order" BIGINT NOT NULL,
  "body_json" TEXT COLLATE "C" NOT NULL,
  CONSTRAINT "clarify_mindmap_nodes_pkey" PRIMARY KEY ("id")
);

-- table: clarify_mindmap_sessions
CREATE TABLE "agent_workflow"."clarify_mindmap_sessions" (
  "id" TEXT COLLATE "C" NOT NULL,
  "task_id" TEXT COLLATE "C" NOT NULL,
  "round_id" TEXT COLLATE "C" NOT NULL,
  "entry_ref" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "metadata_json" TEXT COLLATE "C" NOT NULL,
  "source_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "updated_at" BIGINT NOT NULL,
  CONSTRAINT "clarify_mindmap_sessions_pkey" PRIMARY KEY ("id")
);

-- table: clarify_mindmap_snapshots
CREATE TABLE "agent_workflow"."clarify_mindmap_snapshots" (
  "id" TEXT COLLATE "C" NOT NULL,
  "session_id" TEXT COLLATE "C" NOT NULL,
  "revision" BIGINT NOT NULL,
  "digest" TEXT COLLATE "C" NOT NULL,
  "content_json" TEXT COLLATE "C" NOT NULL,
  "markdown" TEXT COLLATE "C" NOT NULL,
  "plan_json" TEXT COLLATE "C" NOT NULL,
  "created_at" BIGINT NOT NULL,
  "finalized_at" BIGINT,
  "finalized_by" TEXT COLLATE "C",
  CONSTRAINT "clarify_mindmap_snapshots_pkey" PRIMARY KEY ("id")
);

-- index: clarify_mindmap_command_receipts:index:idx_mindmap_receipts_history
CREATE INDEX "idx_mindmap_receipts_history" ON "agent_workflow"."clarify_mindmap_command_receipts" ("session_id", "session_revision");

-- index: clarify_mindmap_nodes:index:idx_mindmap_nodes_parent
CREATE INDEX "idx_mindmap_nodes_parent" ON "agent_workflow"."clarify_mindmap_nodes" ("session_id", "parent_id", "sort_order");

-- index: clarify_mindmap_sessions:index:idx_mindmap_sessions_round
CREATE UNIQUE INDEX "idx_mindmap_sessions_round" ON "agent_workflow"."clarify_mindmap_sessions" ("round_id");

-- index: clarify_mindmap_sessions:index:idx_mindmap_sessions_entry
CREATE UNIQUE INDEX "idx_mindmap_sessions_entry" ON "agent_workflow"."clarify_mindmap_sessions" ("task_id", "entry_ref");

-- index: clarify_mindmap_snapshots:index:idx_mindmap_snapshots_session
CREATE INDEX "idx_mindmap_snapshots_session" ON "agent_workflow"."clarify_mindmap_snapshots" ("session_id", "revision");

-- constraint: clarify_mindmap_command_receipts:fk:clarify_mindmap_command_receipts_session_id_clarify_mindmap_sessions_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_command_receipts" ADD CONSTRAINT "clarify_mindmap_command_receipts_session_id_clarif_29e9cd414115" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."clarify_mindmap_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: clarify_mindmap_node_revisions:fk:clarify_mindmap_node_revisions_node_id_clarify_mindmap_nodes_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_node_revisions" ADD CONSTRAINT "clarify_mindmap_node_revisions_node_id_clarify_min_33487613ec18" FOREIGN KEY ("node_id") REFERENCES "agent_workflow"."clarify_mindmap_nodes" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: clarify_mindmap_nodes:fk:clarify_mindmap_nodes_session_id_clarify_mindmap_sessions_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_nodes" ADD CONSTRAINT "clarify_mindmap_nodes_session_id_clarify_mindmap_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."clarify_mindmap_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: clarify_mindmap_sessions:fk:clarify_mindmap_sessions_task_id_tasks_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_sessions" ADD CONSTRAINT "clarify_mindmap_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "agent_workflow"."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: clarify_mindmap_sessions:fk:clarify_mindmap_sessions_round_id_clarify_rounds_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_sessions" ADD CONSTRAINT "clarify_mindmap_sessions_round_id_clarify_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "agent_workflow"."clarify_rounds" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- constraint: clarify_mindmap_snapshots:fk:clarify_mindmap_snapshots_session_id_clarify_mindmap_sessions_id_fk
ALTER TABLE "agent_workflow"."clarify_mindmap_snapshots" ADD CONSTRAINT "clarify_mindmap_snapshots_session_id_clarify_mindm_5a30b8c04e81" FOREIGN KEY ("session_id") REFERENCES "agent_workflow"."clarify_mindmap_sessions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- metadata: advance-contract-row
UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = 'sha256:f093173a29f7875afcbd167fae1d2687cc3118431348a2f3a848acb8cb929d49', active_table_count = 243, archive_only_table_count = 6 WHERE singleton = TRUE AND contract_digest = 'sha256:75bf736d0ce25c25e293ba78e82d378ccca540edc2807fa27345d4f8c33dcd27' RETURNING contract_digest;
