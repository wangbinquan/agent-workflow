-- RFC-310: Webhook is an observation mechanism, not a second business-event
-- directory. Early Event Center builds persisted a public `code-host.webhook`
-- source beside the unified `code-host.activity` source. Keep those immutable
-- event revisions for historical records and frozen subscriptions, but remove
-- them from all new-authoring catalogs.

UPDATE `event_type_catalog`
SET `catalog_visibility` = 'compatibility'
WHERE `source_id` = 'code-host.webhook'
  AND `event_type_id` LIKE 'code-host.webhook.%';
