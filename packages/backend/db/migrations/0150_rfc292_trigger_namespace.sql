-- RFC-292 — canonical trigger namespace and webhook launch-template v2.

-- Existing rows are v1 (flat {{field}} syntax). CRUD/fire migrates the payload
-- transactionally before use; every new write stamps v2.
ALTER TABLE `webhook_triggers`
  ADD COLUMN `template_syntax_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

-- Backfill only structurally valid historical RFC-269 flat task contexts.
-- Corrupt/unknown-key rows remain byte-for-byte intact so the runtime decoder
-- can distinguish and report trigger-context-invalid rather than hiding damage.
UPDATE `tasks`
SET `trigger_context_json` = json_object(
  'trigger', json_object('webhook', json(`trigger_context_json`))
)
WHERE `trigger_context_json` IS NOT NULL
  AND json_valid(`trigger_context_json`) = 1
  AND json_type(`trigger_context_json`) = 'object'
  AND json_type(`trigger_context_json`, '$.event_type') = 'text'
  AND json_extract(`trigger_context_json`, '$.event_type') IN (
    'push', 'tag_push', 'mr_opened', 'mr_updated', 'mr_merged', 'mr_closed',
    'note', 'pipeline_failed', 'pipeline_succeeded'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(`tasks`.`trigger_context_json`) AS `ctx`
    WHERE `ctx`.`key` NOT IN (
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
    FROM json_each(`tasks`.`trigger_context_json`) AS `typed_ctx`
    WHERE `typed_ctx`.`type` != 'text'
  );
