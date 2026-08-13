-- RFC-301 — immutable task launch-tree origin.
--
-- New writers persist one of four task-execution-owned origins. The manual
-- default keeps old binaries INSERT-compatible during rolling deploys.
ALTER TABLE `tasks`
ADD COLUMN `launch_origin` text DEFAULT 'manual' NOT NULL
  CHECK (`launch_origin` IN ('manual', 'scheduled', 'webhook', 'api'));
--> statement-breakpoint

-- Historical local evidence. Webhook wins over schedule when a corrupt row
-- carries both. IDs are durable evidence; canonical context is accepted only
-- when it mirrors TriggerContextSchema exactly (closed objects, closed field
-- set, text leaves, and a closed event_type discriminator).
UPDATE `tasks`
SET `launch_origin` = CASE
  WHEN (
    NULLIF(trim(`webhook_trigger_id`), '') IS NOT NULL
    OR NULLIF(trim(`webhook_fire_id`), '') IS NOT NULL
    OR (
      `trigger_context_json` IS NOT NULL
      AND json_valid(`trigger_context_json`) = 1
      AND json_type(`trigger_context_json`) = 'object'
      AND json_type(`trigger_context_json`, '$.trigger') = 'object'
      AND json_type(`trigger_context_json`, '$.trigger.webhook') = 'object'
      AND json_type(`trigger_context_json`, '$.trigger.webhook.event_type') = 'text'
      AND json_extract(`trigger_context_json`, '$.trigger.webhook.event_type') IN (
        'push', 'tag_push', 'mr_opened', 'mr_updated', 'mr_merged', 'mr_closed',
        'note', 'pipeline_failed', 'pipeline_succeeded'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(`tasks`.`trigger_context_json`) AS `root_ctx`
        WHERE `root_ctx`.`key` != 'trigger'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(`tasks`.`trigger_context_json`, '$.trigger') AS `trigger_ctx`
        WHERE `trigger_ctx`.`key` != 'webhook'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(`tasks`.`trigger_context_json`, '$.trigger.webhook') AS `webhook_ctx`
        WHERE `webhook_ctx`.`key` NOT IN (
          'event_type', 'provider', 'repo_path', 'repo_http_url', 'repo_ssh_url',
          'branch', 'target_branch', 'default_branch', 'mr_iid', 'mr_id', 'mr_title',
          'mr_url', 'commit_sha', 'commit_before', 'comment_text', 'comment_author',
          'comment_id', 'comment_thread_id', 'comment_url', 'comment_position_json',
          'pipeline_status', 'pipeline_id', 'pipeline_url', 'api_base_url', 'project_id',
          'project_web_url', 'repo_owner', 'repo_name', 'author_id', 'event_json'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(`tasks`.`trigger_context_json`, '$.trigger.webhook') AS `typed_ctx`
        WHERE `typed_ctx`.`type` != 'text'
      )
    )
  ) THEN 'webhook'
  WHEN `scheduled_task_id` IS NOT NULL THEN 'scheduled'
  ELSE 'manual'
END;
--> statement-breakpoint

-- A task tree belongs to its root launch. Propagate the root candidate over
-- every reachable descendant. The path guard terminates malformed cycles;
-- dangling/cycle-only rows retain their best local candidate from above.
WITH RECURSIVE `rooted`(`id`, `root_origin`, `path`) AS (
  SELECT `id`, `launch_origin`, ',' || `id` || ','
  FROM `tasks`
  WHERE `parent_task_id` IS NULL

  UNION ALL

  SELECT `child`.`id`, `rooted`.`root_origin`, `rooted`.`path` || `child`.`id` || ','
  FROM `tasks` AS `child`
  JOIN `rooted` ON `child`.`parent_task_id` = `rooted`.`id`
  WHERE instr(`rooted`.`path`, ',' || `child`.`id` || ',') = 0
)
UPDATE `tasks`
SET `launch_origin` = (
  SELECT `rooted`.`root_origin`
  FROM `rooted`
  WHERE `rooted`.`id` = `tasks`.`id`
  LIMIT 1
)
WHERE `id` IN (SELECT `id` FROM `rooted`);
--> statement-breakpoint

-- Rolling-deploy/code-rollback fence: an old writer omits launch_origin and
-- receives the manual default. For children, immediately copy the exact
-- parent value inside that same INSERT transaction so a precise tree cannot
-- be split by a mixed-version child writer.
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
