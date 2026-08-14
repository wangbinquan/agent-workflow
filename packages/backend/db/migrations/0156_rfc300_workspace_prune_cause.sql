-- RFC-300 — disambiguate durable Webhook-terminal workspace cleanup claims
-- from RFC-165 age/merge GC and transient iso-container GC claims that share
-- workspace_pruning_at. Existing claims remain NULL and therefore cannot be
-- replayed by the Webhook-specific boot/ticker recovery path.
ALTER TABLE `tasks`
ADD COLUMN `workspace_prune_cause` text
  CHECK (
    `workspace_prune_cause` IS NULL
    OR (
      `workspace_prune_cause` = 'webhook-terminal'
      AND `workspace_pruning_at` IS NOT NULL
    )
  );
