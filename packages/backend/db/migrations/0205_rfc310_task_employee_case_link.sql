-- RFC-310: TaskEngine executions launched by the digital employee OS need a
-- stable business-level backlink after direct navigation or page reload.
-- Keep the Case id on the task row: task detail must not join across bounded
-- contexts, and the pre-existing digital_employee_round_id is also used by
-- legacy Development Automation action runs that have no OS Case.

ALTER TABLE `tasks` ADD `digital_employee_case_id` text;--> statement-breakpoint
UPDATE `tasks`
SET `digital_employee_case_id` = (
  SELECT `employee_reaction_rounds`.`case_id`
  FROM `employee_reaction_rounds`
  WHERE `employee_reaction_rounds`.`id` = `tasks`.`digital_employee_round_id`
)
WHERE `tasks`.`digital_employee_round_id` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `employee_reaction_rounds`
    WHERE `employee_reaction_rounds`.`id` = `tasks`.`digital_employee_round_id`
  );
