-- RFC-324: graded resource grants (read / write).
--
-- Until now a row in `resource_grants` meant exactly one thing: "this user can
-- see and use this resource". The write side was owner-only everywhere, so the
-- grant table needed no depth. RFC-324 adds the second depth — an edit grant —
-- and every existing row must keep meaning exactly what it meant before, so the
-- backfill default is 'read'. That is what makes this migration behaviour-free:
-- after it runs, every actor's view/edit/govern verdict is byte-for-byte the
-- verdict they got before it ran (locked by rfc324-access-policy-equivalence).
--
-- The CHECK is deliberate and NOT the same call as `resource_type`, which is
-- plain text with no CHECK (schema.ts:505-509 explains why: that set grows every
-- time a new ACL resource type lands, and a CHECK would turn each addition into
-- a table rebuild). `level` is a closed two-value domain that is not expected to
-- grow — the RFC deliberately chose two grades over three — so the database can
-- and should refuse a third value written by raw SQL.
ALTER TABLE `resource_grants` ADD COLUMN `level` text DEFAULT 'read' NOT NULL CHECK (`level` IN ('read', 'write'));
--> statement-breakpoint

-- Scheduled tasks join the same grants table (resource_type = 'scheduled_task')
-- but were never an ACL row, so they carry no OCC fence. Give them the same
-- monotonic acl_revision every ACL resource has (RFC-170 §8), so the new
-- GET/PUT /api/scheduled-tasks/:id/acl pair CAS-rejects a stale write exactly
-- like the other thirteen.
ALTER TABLE `scheduled_tasks` ADD COLUMN `acl_revision` integer DEFAULT 0 NOT NULL;
