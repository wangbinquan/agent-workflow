-- RFC-304 T50b — the reverse index that lets a requirement close.
--
-- A `requirement` work item is anchored to the REQUIREMENT (`issue-88`), and it
-- is finished when the merge request it produced is merged. Those two facts
-- never meet on their own: the MR terminal event carries a provider, a project
-- and an MR number, and nothing in it mentions the issue. Without a lookup from
-- one to the other, the work item stays open forever — the code shipped, the
-- platform never noticed, and the requirement sits in the activity view as
-- in-progress indefinitely.
--
-- The forward direction is already recorded (`anchor_meta.producedMr`), but a
-- forward pointer is unusable here: the terminal event arrives knowing only the
-- MR, so answering "which work item produced this?" would mean scanning every
-- open work item's JSON on every merge event in the deployment.

CREATE TABLE code_produced_mrs (
  -- `endpoint|project|iid`, each component encoded — the shape the terminal
  -- event can construct from what it carries.
  mr_key TEXT PRIMARY KEY,
  code_host_endpoint_id TEXT NOT NULL,
  stable_project_id TEXT NOT NULL,
  mr_iid TEXT NOT NULL,
  -- The work item that produced it.
  work_item_id TEXT NOT NULL,
  -- The round that opened it, for the activity view's "where did this come
  -- from" and for orphan cleanup.
  round_id TEXT,
  created_at INTEGER NOT NULL,
  -- Set when the MR reached a terminal state and the work item was advanced.
  -- Kept rather than deleted: "this requirement produced that MR, and it was
  -- merged on the 14th" is exactly what someone reading the history wants.
  closed_at INTEGER
);
--> statement-breakpoint
-- "What did this work item produce?" — the forward question, for the state view.
CREATE INDEX idx_code_produced_mrs_item ON code_produced_mrs (work_item_id);
