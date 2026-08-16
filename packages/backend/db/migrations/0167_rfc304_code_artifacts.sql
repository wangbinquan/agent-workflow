-- RFC-304 T2c — immutable artifacts, so a confirmation pushes what was shown.
--
-- The patch path posts a diff and waits, sometimes for days. By the time the
-- reply arrives the agent's worktree is long gone, and re-running the model
-- would produce a DIFFERENT change carrying the same justification. Freezing
-- the change as a commit at the moment it is posted is what makes "yes" mean
-- something: the push replays that object, byte for byte.
--
-- The commit lives in git; this table is the index that knows it exists, what
-- it was built on, and whether anything still needs it.
--
-- `keep_ref` is the reason the object survives at all. A commit reachable only
-- from a removed worktree's detached HEAD is unreferenced, and `git gc` may
-- prune it while a human is still deciding — so every artifact holds a ref, and
-- releasing the artifact deletes it.

CREATE TABLE code_artifacts (
  id TEXT PRIMARY KEY,
  -- Which repository's object store holds the commit. Part of the identity:
  -- the same sha in a different clone is a different (or absent) object.
  repo_path TEXT NOT NULL,
  -- The frozen commit.
  commit_sha TEXT NOT NULL,
  -- What it was built on. `verify-baseline` compares this against the branch
  -- head at confirmation time; a mismatch abandons rather than force-pushing.
  base_sha TEXT NOT NULL,
  -- Content digest of the diff, as shown to the human (short form appears in
  -- the posted comment). Distinct from `commit_sha`: two commits with different
  -- parents or timestamps can carry the identical change, and it is the CHANGE
  -- the human agreed to.
  digest TEXT NOT NULL,
  -- The git ref keeping the commit alive; dropped on release.
  keep_ref TEXT NOT NULL,
  -- The round that produced it, for the activity view and for orphan cleanup.
  round_id TEXT,
  -- The work item and generation it belongs to. A confirmation arriving after
  -- the generation moved is refused: the change describes code that has since
  -- been rewritten.
  work_item_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  -- How many pending things still need this object. Reaching zero is what makes
  -- it collectable — an artifact nobody is waiting on is dead weight in the
  -- object store, and on a busy repository that adds up.
  ref_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'live',
  created_at INTEGER NOT NULL,
  released_at INTEGER
);
--> statement-breakpoint
-- The confirmation path looks an artifact up by what the comment carried.
CREATE INDEX idx_code_artifacts_digest ON code_artifacts (digest);
--> statement-breakpoint
-- "What is still pending on this work item?" — the question the monitor and the
-- activity view both ask.
CREATE INDEX idx_code_artifacts_item ON code_artifacts (work_item_id, state);
--> statement-breakpoint
-- Reclamation scans for live artifacts nobody references.
CREATE INDEX idx_code_artifacts_reclaim ON code_artifacts (state, ref_count);
