ALTER TABLE `event_type_catalog` ADD `catalog_visibility` text DEFAULT 'public' NOT NULL;
--> statement-breakpoint
UPDATE `event_type_catalog`
SET `catalog_visibility` = 'internal'
WHERE `revision` = 1
  AND `event_type_id` IN (
    'development.work-received',
    'development.review-updated',
    'development.pipeline-updated',
    'development.conflict-updated',
    'development.lifecycle-updated',
    'development.employee-result',
    'development.approval-updated'
  );
--> statement-breakpoint
UPDATE `event_subscriptions`
SET
  `event_type_id` = CASE `event_type_id`
    WHEN 'development.pipeline-updated' THEN 'development.pipeline-check-due'
    ELSE `event_type_id`
  END,
  `event_type_revision` = CASE `event_type_id`
    WHEN 'development.pipeline-updated' THEN 1
    ELSE 2
  END,
  `source_id` = 'code-host.activity',
  `source_revision` = 1
WHERE `source_id` = 'development.code-host-state'
  AND `event_type_id` IN (
    'development.review-updated',
    'development.pipeline-updated',
    'development.conflict-updated',
    'development.lifecycle-updated'
  );
--> statement-breakpoint
UPDATE `employee_attention_bindings`
SET
  `event_type_id` = CASE `event_type_id`
    WHEN 'development.pipeline-updated' THEN 'development.pipeline-check-due'
    ELSE `event_type_id`
  END,
  `event_type_revision` = CASE `event_type_id`
    WHEN 'development.pipeline-updated' THEN 1
    ELSE 2
  END
WHERE `event_type_id` IN (
  'development.review-updated',
  'development.pipeline-updated',
  'development.conflict-updated',
  'development.lifecycle-updated'
);
--> statement-breakpoint
UPDATE `observer_activations`
SET
  `subscriber_count` = `subscriber_count` + COALESCE((
    SELECT `legacy`.`subscriber_count`
    FROM `observer_activations` AS `legacy`
    WHERE `legacy`.`source_id` = 'development.code-host-state'
      AND `legacy`.`source_revision` = 1
  ), 0),
  `state` = 'active',
  `next_scan_at` = 0,
  `updated_at` = MAX(`updated_at`, COALESCE((
    SELECT `legacy`.`updated_at`
    FROM `observer_activations` AS `legacy`
    WHERE `legacy`.`source_id` = 'development.code-host-state'
      AND `legacy`.`source_revision` = 1
  ), `updated_at`))
WHERE `source_id` = 'code-host.activity'
  AND `source_revision` = 1
  AND EXISTS (
    SELECT 1 FROM `observer_activations` AS `legacy`
    WHERE `legacy`.`source_id` = 'development.code-host-state'
      AND `legacy`.`source_revision` = 1
  );
--> statement-breakpoint
DELETE FROM `observer_activations`
WHERE `source_id` = 'development.code-host-state'
  AND `source_revision` = 1
  AND EXISTS (
    SELECT 1 FROM `observer_activations` AS `current`
    WHERE `current`.`source_id` = 'code-host.activity'
      AND `current`.`source_revision` = 1
  );
--> statement-breakpoint
UPDATE `observer_activations`
SET `source_id` = 'code-host.activity', `source_revision` = 1, `next_scan_at` = 0
WHERE `source_id` = 'development.code-host-state'
  AND `source_revision` = 1;
--> statement-breakpoint
CREATE INDEX `idx_event_type_catalog_visibility` ON `event_type_catalog` (`catalog_visibility`,`event_type_id`,`revision`);
