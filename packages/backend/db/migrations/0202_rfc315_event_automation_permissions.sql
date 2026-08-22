-- RFC-315 — unify Webhook and Event Center automation-rule permissions.
--
-- Account grants retain their original provenance when the target permission does
-- not already exist. If both old and new ids are present, the existing canonical
-- row wins and the legacy row is removed. Role-baseline rows are then removed so
-- the RFC-305 additional-grant store stays free of redundant authority.
INSERT OR IGNORE INTO `user_permission_grants` (
  `user_id`, `permission`, `granted_by_user_id`, `granted_at`
)
SELECT
  `user_id`,
  CASE `permission`
    WHEN 'webhook-triggers:read' THEN 'event-automation-rules:read'
    WHEN 'webhook-triggers:create' THEN 'event-automation-rules:create'
    WHEN 'webhook-triggers:update' THEN 'event-automation-rules:update'
    WHEN 'webhook-triggers:delete' THEN 'event-automation-rules:delete'
    WHEN 'webhook-triggers:override-owner' THEN 'event-automation-rules:override-owner'
  END,
  `granted_by_user_id`,
  `granted_at`
FROM `user_permission_grants`
WHERE `permission` IN (
  'webhook-triggers:read',
  'webhook-triggers:create',
  'webhook-triggers:update',
  'webhook-triggers:delete',
  'webhook-triggers:override-owner'
);--> statement-breakpoint

DELETE FROM `user_permission_grants`
WHERE `permission` IN (
  'webhook-triggers:read',
  'webhook-triggers:create',
  'webhook-triggers:update',
  'webhook-triggers:delete',
  'webhook-triggers:override-owner'
);--> statement-breakpoint

DELETE FROM `user_permission_grants`
WHERE EXISTS (
  SELECT 1
  FROM `users`
  WHERE `users`.`id` = `user_permission_grants`.`user_id`
    AND (
      (`user_permission_grants`.`permission` = 'event-automation-rules:read'
        AND `users`.`role` IN ('admin', 'manager', 'user'))
      OR (`user_permission_grants`.`permission` IN (
          'event-automation-rules:create',
          'event-automation-rules:update',
          'event-automation-rules:delete'
        ) AND `users`.`role` IN ('admin', 'manager'))
      OR (`user_permission_grants`.`permission` = 'event-automation-rules:override-owner'
        AND `users`.`role` = 'admin')
    )
);--> statement-breakpoint

-- PAT rows are hash-only credentials, so they cannot be reissued during upgrade.
-- Rewrite every structurally valid string[] matrix in place, including revoked
-- and expired rows, and preserve first-occurrence order while deduplicating.
-- Invalid JSON or arrays containing non-string elements remain byte-for-byte
-- unchanged and continue to fail closed in the existing scope parser.
UPDATE `user_pats` AS `pat`
SET `scopes_json` = (
  SELECT COALESCE(json_group_array(`mapped`.`permission`), '[]')
  FROM (
    SELECT
      CASE `scope`.`value`
        WHEN 'webhook-triggers:read' THEN 'event-automation-rules:read'
        WHEN 'webhook-triggers:create' THEN 'event-automation-rules:create'
        WHEN 'webhook-triggers:update' THEN 'event-automation-rules:update'
        WHEN 'webhook-triggers:delete' THEN 'event-automation-rules:delete'
        WHEN 'webhook-triggers:override-owner' THEN 'event-automation-rules:override-owner'
        ELSE `scope`.`value`
      END AS `permission`,
      MIN(CAST(`scope`.`key` AS INTEGER)) AS `first_position`
    FROM json_each(`pat`.`scopes_json`) AS `scope`
    GROUP BY
      CASE `scope`.`value`
        WHEN 'webhook-triggers:read' THEN 'event-automation-rules:read'
        WHEN 'webhook-triggers:create' THEN 'event-automation-rules:create'
        WHEN 'webhook-triggers:update' THEN 'event-automation-rules:update'
        WHEN 'webhook-triggers:delete' THEN 'event-automation-rules:delete'
        WHEN 'webhook-triggers:override-owner' THEN 'event-automation-rules:override-owner'
        ELSE `scope`.`value`
      END
    ORDER BY `first_position`
  ) AS `mapped`
)
WHERE json_valid(`pat`.`scopes_json`)
  AND json_type(`pat`.`scopes_json`) = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(`pat`.`scopes_json`) AS `invalid_scope`
    WHERE `invalid_scope`.`type` <> 'text'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(`pat`.`scopes_json`) AS `legacy_scope`
    WHERE `legacy_scope`.`value` IN (
      'webhook-triggers:read',
      'webhook-triggers:create',
      'webhook-triggers:update',
      'webhook-triggers:delete',
      'webhook-triggers:override-owner'
    )
  );
