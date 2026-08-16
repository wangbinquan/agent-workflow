-- RFC-304 T64 — where a copied template came from.
--
-- Copying is how teams start (T57), so within a quarter there are dozens of
-- templates descended from a handful of originals. Then the original gets a fix
-- — a classifier pattern that was wrong — and nobody downstream finds out.
--
-- The three columns are exactly what distinguishes the four states, and none of
-- them can be reconstructed after the fact, which is why they are written at
-- COPY time rather than derived later:
--
--   upstream_id       without it there is no link at all, and an upstream fix
--                     never reaches the copies;
--   upstream_version  without it "has upstream moved" is unanswerable;
--   base_digest       without it a merge is two-way — "upstream says A, local
--                     says B" cannot tell "upstream changed it" from "local
--                     changed it", so it guesses, and is wrong half the time on
--                     exactly the fields somebody cared enough to edit.
--
-- Nullable throughout: a template nobody copied has no origin, and that is a
-- normal state rather than missing data.

ALTER TABLE capability_frameworks ADD COLUMN upstream_id TEXT;
--> statement-breakpoint
ALTER TABLE capability_frameworks ADD COLUMN upstream_version INTEGER;
--> statement-breakpoint
ALTER TABLE capability_frameworks ADD COLUMN base_digest TEXT;
--> statement-breakpoint
ALTER TABLE capability_bindings ADD COLUMN upstream_id TEXT;
--> statement-breakpoint
ALTER TABLE capability_bindings ADD COLUMN upstream_version INTEGER;
--> statement-breakpoint
ALTER TABLE capability_bindings ADD COLUMN base_digest TEXT;
--> statement-breakpoint
-- "What was copied from this template?" — the question asked when publishing a
-- fix, to learn who is affected.
CREATE INDEX idx_capability_frameworks_upstream ON capability_frameworks (upstream_id);
--> statement-breakpoint
CREATE INDEX idx_capability_bindings_upstream ON capability_bindings (upstream_id);
