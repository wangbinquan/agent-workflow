-- RFC-304 T52/T54 — what "three attempts" counts, and where the count lives.
--
-- The quota is keyed by `(work item, failure fingerprint)`, NOT by work item.
-- Design §6.4 (E9) is explicit about why: keyed by work item alone, a long-lived
-- merge request permanently loses automatic repair the third time it meets any
-- CI problem — three unrelated ones, months apart — and nobody can see it
-- happen, because the quota was spent by failures the author has forgotten.
--
-- The count therefore has to OUTLIVE the round. One round is one attempt: the
-- pipeline fails, a round runs, and whatever it did, the next pipeline event
-- opens a new round. Without this table each of those rounds would believe it
-- was the first, and the platform would retry the same broken fix forever.
--
-- The per-attempt prose is here for one reason: when the quota runs out, the
-- comment has to say what was already tried. A hand-off that says only "three
-- attempts failed" tells the person nothing they can act on, and they redo the
-- first attempt by hand.

CREATE TABLE code_fix_attempts (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  -- The normalized failure identity (see failureFingerprint.ts). Two runs of the
  -- SAME failure must land on the same value here or the quota never engages;
  -- two genuinely different failures must not, or a problem nobody has tried
  -- gets no attempts at all.
  fingerprint TEXT NOT NULL,
  -- 1-based, and unique per (item, fingerprint) below. This is the attempt
  -- NUMBER rather than a count read at write time: two rounds racing on the same
  -- item would both read "2 so far" and both write attempt 3, quietly turning a
  -- three-attempt quota into four.
  attempt_seq INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  -- What the agent said it did, in its own words — this is quoted back to the
  -- person, so it is stored verbatim and never paraphrased here.
  summary TEXT NOT NULL,
  -- What actually happened, decided by the gate rather than by the agent:
  -- `fixed` | `still-red` | `rejected` | `escalated`.
  outcome TEXT NOT NULL,
  -- The gate's own words for the failure that remained, when one did.
  detail TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
-- The quota check. Also the guard: an attempt number is CLAIMED by inserting it,
-- so a concurrent round loses the insert instead of silently sharing the slot.
CREATE UNIQUE INDEX uniq_code_fix_attempts_seq
  ON code_fix_attempts (work_item_id, fingerprint, attempt_seq);
--> statement-breakpoint
-- "What has this item already tried?" — asked when the quota runs out and the
-- hand-off comment has to list every attempt in order.
CREATE INDEX idx_code_fix_attempts_item ON code_fix_attempts (work_item_id, fingerprint);
