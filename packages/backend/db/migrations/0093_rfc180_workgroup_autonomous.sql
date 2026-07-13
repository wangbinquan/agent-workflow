-- RFC-180「全自动」— add the workgroups.autonomous flag. When ON the group omits
-- the clarify ask-back invite, treats the completion gate as off (leader-done
-- finishes directly), and auto-nudges a leader-idle round instead of parking.
-- Purely additive, NOT NULL DEFAULT false → every existing row becomes
-- non-autonomous (byte-for-byte unchanged behavior at rest, zero regression).
-- Hand-written; registered in meta/_journal.json. See
-- design/RFC-180-workgroup-autonomous-mode/design.md §2.1.
ALTER TABLE `workgroups` ADD COLUMN `autonomous` integer DEFAULT false NOT NULL;
