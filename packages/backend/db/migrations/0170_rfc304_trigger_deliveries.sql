-- RFC-304 T61 — the delivery chain, so "it stopped working" has an answer.
--
-- An administrator reporting "review stopped on this repository" can check
-- three things today, and all three fail to distinguish the cases:
--
--   `readiness = ready`  says the CONFIG is complete, not that anything ran;
--   last trigger time    says nothing arrived, but not whether the webhook was
--                        never sent, arrived and was dropped by routing, or is
--                        queued behind a merge-request lease;
--   "send a test event"  proves only that the test path works, if it takes a
--                        shortcut past the real one.
--
-- Each case has a different fix — reconfigure the hook, correct the routing,
-- wait or raise a quota — so without this table the administrator is guessing.
--
-- The `reason` column carries the value. "dropped" on its own moves the
-- question rather than answering it.

CREATE TABLE code_trigger_deliveries (
  id TEXT PRIMARY KEY,
  -- Shared with the round and the ingress event, so one id follows the whole
  -- story across tables. Without it the chain reconstructs by timestamp
  -- proximity, which is wrong exactly when the platform is busy.
  correlation_id TEXT NOT NULL,
  -- Soft links: these rows outlive the endpoint and the work item, because the
  -- most useful delivery record is often for something that no longer exists.
  code_host_endpoint_id TEXT,
  stable_project_id TEXT,
  anchor_kind TEXT,
  anchor_id TEXT,
  -- Which capability routing selected; NULL while it has not chosen, and for a
  -- delivery that was deliberately dropped before routing.
  capability TEXT,
  -- The furthest step reached: received|matched|routed|queued|round|published.
  step TEXT NOT NULL,
  -- ok | dropped | failed. `dropped` is NOT a failure — a healthy platform
  -- drops most deliveries, and colouring them red trains an administrator to
  -- ignore the colour that means something is broken.
  outcome TEXT NOT NULL,
  -- Why, for dropped and failed. The whole point of the row.
  reason TEXT,
  -- Queue diagnostics, populated only while `step = 'queued'`. Age and position
  -- together are what separates "queued" from "stuck"; an administrator who
  -- cannot tell them apart restarts the daemon, which discards the queue and
  -- turns a wait into a loss.
  queued_at INTEGER,
  queue_position INTEGER,
  waiting_on TEXT,
  round_id TEXT,
  -- True for a delivery produced by "send a test event". It walks the SAME
  -- path; the flag exists so the list can separate real traffic from probes,
  -- not so the code can take a shortcut for it.
  is_probe INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
-- "What happened on this repository lately" — the question an administrator
-- arrives with, answered without a scan.
CREATE INDEX idx_code_trigger_deliveries_project
  ON code_trigger_deliveries (stable_project_id, created_at);
--> statement-breakpoint
-- Following one story across tables.
CREATE INDEX idx_code_trigger_deliveries_correlation
  ON code_trigger_deliveries (correlation_id);
--> statement-breakpoint
-- "Show me what is stuck", which is a different question from "what happened".
CREATE INDEX idx_code_trigger_deliveries_outcome
  ON code_trigger_deliveries (outcome, created_at);
