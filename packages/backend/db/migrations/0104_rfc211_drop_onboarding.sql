-- RFC-211 §12 reversal — remove the guided-onboarding "example sandbox".
--
-- The sandbox (build-it-for-me example resources + one-click cleanup) was
-- replaced by the hand-holding spotlight tour, which walks the user through the
-- real screens and builds their own REAL resources — no `example` concept. The
-- user decided (2026-07-21) to drop the distinction entirely, so this migration
-- removes every trace: the five `example` flags and the two bookkeeping tables.
--
-- SQLite ≥ 3.35 supports ALTER TABLE DROP COLUMN; the `example` columns carry no
-- index or constraint, so the drops are clean. Artifacts is dropped before runs
-- (FK direction). Hand-written; registered in meta/_journal.json.
ALTER TABLE `agents` DROP COLUMN `example`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `example`;
--> statement-breakpoint
ALTER TABLE `workflows` DROP COLUMN `example`;
--> statement-breakpoint
ALTER TABLE `workgroups` DROP COLUMN `example`;
--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `example`;
--> statement-breakpoint
DROP TABLE IF EXISTS `onboarding_artifacts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `onboarding_runs`;
