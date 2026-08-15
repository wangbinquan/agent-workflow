-- RFC-304 T35/T36 — what a wake-up leaves behind when it starts no round.
--
-- The monitor's commonest outcome is `noop`: a pipeline going green, an
-- ordinary comment, an update with nothing outstanding. At 50 active merge
-- requests and three such events a day each, that is ~150 healthy wake-ups
-- daily, and by design none of them creates a task or says anything on the
-- merge request.
--
-- Without this table those 150 wake-ups are indistinguishable from the monitor
-- being broken — the two questions an operator actually asks ("did it look?"
-- and "when did it last look?") would have no answer, and the natural fix
-- would be the one N7 forbids: poll and see.
--
-- One row per conclusion, not per event: several events can collapse into one
-- observation, and an observation names the revision it was made against.

CREATE TABLE code_work_observations (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  -- Why nothing ran, or what did. `noop` dominates; `dispatched` records the
  -- wake-ups that did open a round, so the two are readable as one timeline.
  kind TEXT NOT NULL,
  -- The arbitration's own words, shown verbatim in the activity view. Written
  -- by the department's script, so the platform does not paraphrase it.
  reason TEXT NOT NULL,
  -- The head sha this conclusion was drawn against. A later observation at the
  -- same revision is a repeat; at a new one it is a fresh judgement.
  observed_revision TEXT,
  -- Shared with the round this wake-up dispatched, and with the ingress event
  -- that caused it (T10e) — one causation id per causal chain.
  causation_id TEXT,
  -- The ingress event this observation answers, when there was one. A wake
  -- request and a periodic recovery pass legitimately have none.
  event_id TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
-- The activity view reads "the last few observations for this item", and the
-- staleness question reads "the newest one" — both are this index.
CREATE INDEX idx_code_work_observations_item
  ON code_work_observations (work_item_id, created_at DESC);
--> statement-breakpoint
-- T10e: an ingress event is claimed by exactly ONE top-level capability, and
-- this is where that claim is durable. A partial index because most rows have
-- no event id (wake requests, recovery passes) and NULLs do not conflict.
CREATE UNIQUE INDEX uniq_code_work_observations_event
  ON code_work_observations (event_id)
  WHERE event_id IS NOT NULL;
