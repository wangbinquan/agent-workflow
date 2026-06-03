-- RFC-079 — Review node multi-document mode (PR-A).
--
-- When a review node's inputSource upstream port is a `list<path<md>>` (or
-- `list<markdown>`), the review runs in MULTI-DOCUMENT mode: each list item is
-- archived as its own `doc_versions` row so it gets the full review machinery
-- (selection-anchored inline comments via review_comments, commentsJson
-- freeze, versionIndex history, iterate feedback, reject rollback). Three new
-- nullable columns carry the per-document state:
--
--   * `item_index`  — 0-based position within the round. NULL on every
--     single-document row; that NULL is the system-wide "single-doc mode"
--     discriminator, so single-doc dispatch / decision / output paths stay
--     byte-for-byte unchanged. approve sorts the accepted subset by it.
--   * `selection`   — per-document curation choice
--     ('unselected' | 'accepted' | 'not_accepted'), orthogonal to the
--     round-level `decision`. At approve, 'accepted' members become the
--     downstream subset; `decision` flips to 'approved' on every member row.
--     No DB CHECK (cf. 0002 — enum lives in the drizzle/shared TS layer only).
--   * `item_path`   — worktree-relative path of the list member (stable id =
--     the line read from the upstream list port). Carried verbatim into the
--     `accepted` output so downstream nodes read the live file.
--
-- Pure ADD COLUMN (no table rebuild): single-document rows leave all three
-- NULL. The composite index speeds "all members of a round in item order".
--
-- See design/RFC-079-review-multi-document/design.md §1.
ALTER TABLE `doc_versions` ADD COLUMN `item_index` integer;--> statement-breakpoint
ALTER TABLE `doc_versions` ADD COLUMN `selection` text;--> statement-breakpoint
ALTER TABLE `doc_versions` ADD COLUMN `item_path` text;--> statement-breakpoint
CREATE INDEX `idx_doc_versions_review_item` ON `doc_versions` (`review_node_run_id`,`item_index`);
