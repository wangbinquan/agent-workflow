-- RFC-310 T173-T176: tasks carry the delivery provenance of the event that
-- started them. Split out of 0194 as a forward migration because 0194 had
-- already been recorded in __drizzle_migrations when these columns were added.

ALTER TABLE `tasks` ADD `event_subscription_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `event_delivery_id` text;
--> statement-breakpoint
CREATE INDEX `idx_tasks_event_subscription` ON `tasks` (`event_subscription_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_event_delivery_unique` ON `tasks` (`event_delivery_id`) WHERE `event_delivery_id` IS NOT NULL;
--> statement-breakpoint

-- RFC-301 installed a closed SQLite CHECK before Event Center was a launch
-- source. SQLite cannot ALTER a CHECK in place, but it can drop and add this
-- unindexed column atomically. Preserve history and recreate the mixed-version
-- child-inheritance trigger while extending the literal set with `event`.
CREATE TABLE `__rfc310_task_launch_origins` (
	`task_id` text PRIMARY KEY NOT NULL,
	`launch_origin` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__rfc310_task_launch_origins` (`task_id`, `launch_origin`)
SELECT `id`, `launch_origin` FROM `tasks`;
--> statement-breakpoint
DROP TRIGGER `trg_tasks_launch_origin_inherit_child`;
--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `launch_origin`;
--> statement-breakpoint
ALTER TABLE `tasks`
ADD COLUMN `launch_origin` text DEFAULT 'manual' NOT NULL
  CHECK (`launch_origin` IN ('manual', 'scheduled', 'webhook', 'api', 'event'));
--> statement-breakpoint
UPDATE `tasks`
SET `launch_origin` = (
  SELECT `saved`.`launch_origin`
  FROM `__rfc310_task_launch_origins` AS `saved`
  WHERE `saved`.`task_id` = `tasks`.`id`
);
--> statement-breakpoint
DROP TABLE `__rfc310_task_launch_origins`;
--> statement-breakpoint
CREATE TRIGGER `trg_tasks_launch_origin_inherit_child`
AFTER INSERT ON `tasks`
WHEN NEW.`parent_task_id` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `tasks` AS `parent`
    WHERE `parent`.`id` = NEW.`parent_task_id`
      AND `parent`.`launch_origin` <> NEW.`launch_origin`
  )
BEGIN
  UPDATE `tasks`
  SET `launch_origin` = (
    SELECT `parent`.`launch_origin`
    FROM `tasks` AS `parent`
    WHERE `parent`.`id` = NEW.`parent_task_id`
  )
  WHERE `id` = NEW.`id`;
END;
