ALTER TABLE `tasks` ADD `catalog_visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
WITH RECURSIVE `internal_task_tree`(`id`) AS (
  SELECT `id`
  FROM `tasks`
  WHERE `digital_employee_round_id` IS NOT NULL
  UNION
  SELECT `child`.`id`
  FROM `tasks` AS `child`
  JOIN `internal_task_tree` AS `parent`
    ON `child`.`parent_task_id` = `parent`.`id`
)
UPDATE `tasks`
SET `catalog_visibility` = 'internal'
WHERE `id` IN (SELECT `id` FROM `internal_task_tree`);
