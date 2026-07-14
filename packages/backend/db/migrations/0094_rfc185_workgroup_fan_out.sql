-- RFC-185 D4 (user acceptance revision) — add the workgroups.fan_out flag.
-- When ON the leader protocol block invites same-member FAN-OUT (multiple
-- wg_assignments entries for one member = concurrent instances). OFF (the
-- default) keeps the original fixed one-entity-per-agent protocol byte-for-
-- byte — fan-out is a NEW opt-in capability, never a behavior change to
-- existing groups. Purely additive, NOT NULL DEFAULT false → every existing
-- row stays non-fan-out (zero regression at rest). Hand-written; registered
-- in meta/_journal.json. See design/RFC-185-workgroup-leader-fanout/design.md §D4.
ALTER TABLE `workgroups` ADD COLUMN `fan_out` integer DEFAULT false NOT NULL;
