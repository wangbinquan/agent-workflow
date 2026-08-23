-- RFC-310: a digital-employee Case owns a logical task name independently of
-- its employee identity, external subject and internal ReactionRound tasks.
-- The empty default keeps rolling upgrades compatible with an older writer;
-- the current admission path always writes a non-empty operator/derived name.

ALTER TABLE `employee_cases` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `employee_cases`
SET `name` = COALESCE(
  (
    SELECT NULLIF(SUBSTR(TRIM(JSON_EXTRACT(`employee_context_records`.`state_json`, '$.subjectRef')), 1, 255), '')
    FROM `employee_context_records`
    WHERE `employee_context_records`.`id` = `employee_cases`.`primary_context_id`
      AND JSON_VALID(`employee_context_records`.`state_json`)
      AND JSON_TYPE(`employee_context_records`.`state_json`, '$.subjectRef') = 'text'
  ),
  (
    SELECT NULLIF(SUBSTR(TRIM(JSON_EXTRACT(`employee_context_records`.`state_json`, '$.title')), 1, 255), '')
    FROM `employee_context_records`
    WHERE `employee_context_records`.`id` = `employee_cases`.`primary_context_id`
      AND JSON_VALID(`employee_context_records`.`state_json`)
      AND JSON_TYPE(`employee_context_records`.`state_json`, '$.title') = 'text'
  ),
  `id`
)
WHERE `name` = '';
