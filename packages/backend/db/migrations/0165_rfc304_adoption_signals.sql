-- RFC-304 T30 — did anyone act on what the review said?
--
-- Two signals, deliberately in separate columns rather than one "adopted" flag,
-- because they answer different questions and can disagree:
--
--   resolved_at      a human marked the thread resolved. An explicit human
--                    judgement — including "not a problem, closing this".
--   code_changed_at  the code under the finding's anchor changed in a later
--                    round. Evidence the author acted, whether or not they ever
--                    touched the thread.
--
-- Collapsing them would make the most useful question unanswerable: a finding
-- with code_changed and no resolved is one the author quietly fixed; resolved
-- with no code_changed is one they disagreed with. A single flag reports both as
-- "adopted", which is true of one and false of the other.
ALTER TABLE `code_findings` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `code_findings` ADD `code_changed_at` integer;--> statement-breakpoint
-- The round that observed each signal, so a wrong reading can be traced back to
-- the round that made it rather than being an unattributable timestamp.
ALTER TABLE `code_findings` ADD `resolved_round_id` text;--> statement-breakpoint
ALTER TABLE `code_findings` ADD `code_changed_round_id` text;
