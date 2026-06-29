-- RFC-128 — per-question answer seal (落库方案 C). Hand-written; additive; registered
-- in meta/_journal.json. Two ALTER statements, separated by the breakpoint marker on
-- its own line below (REQUIRED — without it only the first ALTER applies; the marker
-- must never appear inside a comment, per the RFC-108 0052/0053 incident).
--
-- sealed_at: per (question x handler role) seal marker. NULL = the entry's answer has
-- not been sealed via the per-question path. The clarify round's answers_json stays the
-- answer-content SoT (merge-written per question); this column lets a question be sealed
-- + dispatched while the round stays awaiting_human (partial answer). A pre-RFC-128
-- 'answered' round needs NO backfill: the read-side derives "all questions sealed" from
-- clarify_rounds.status='answered' (golden-lock; existing rows keep behaving identically).
-- sealed_by is the audit-only setter id — it NEVER enters an agent prompt (RFC-099
-- prompt-isolation), same layer as confirmed_by / dispatched_by / staged_by.
ALTER TABLE `task_questions` ADD COLUMN `sealed_at` integer;
--> statement-breakpoint
ALTER TABLE `task_questions` ADD COLUMN `sealed_by` text;
