ALTER TABLE `oidc_providers` ADD `email_claim` text;
--> statement-breakpoint

-- RFC-320: task commit identity is resolved from the owner when a task is
-- actually created. Historical durable launch envelopes must not keep replaying
-- the retired client-owned pair (existing task rows retain their frozen pair).
UPDATE `scheduled_tasks`
SET `launch_payload` = json_remove(`launch_payload`, '$.gitUserName', '$.gitUserEmail')
WHERE json_valid(`launch_payload`)
  AND (
    json_type(`launch_payload`, '$.gitUserName') IS NOT NULL
    OR json_type(`launch_payload`, '$.gitUserEmail') IS NOT NULL
  );
--> statement-breakpoint

UPDATE `webhook_triggers`
SET `launch_payload` = json_remove(`launch_payload`, '$.gitUserName', '$.gitUserEmail')
WHERE json_valid(`launch_payload`)
  AND (
    json_type(`launch_payload`, '$.gitUserName') IS NOT NULL
    OR json_type(`launch_payload`, '$.gitUserEmail') IS NOT NULL
  );
