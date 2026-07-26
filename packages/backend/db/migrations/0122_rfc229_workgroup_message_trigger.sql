-- RFC-229 — persist the direct message that triggered a member message-turn.
-- Historical and non-message-triggered rows remain NULL; no heuristic backfill.
ALTER TABLE `workgroup_messages`
ADD COLUMN `trigger_message_id` text
REFERENCES `workgroup_messages`(`id`) ON DELETE SET NULL;
