-- RFC-365 expand phase: Event Center owns durable automation origin and work intent.
CREATE TABLE `event_automation_work_intents` (
  `origin_ref` text PRIMARY KEY NOT NULL,
  `delivery_id` text NOT NULL REFERENCES `event_deliveries` (`id`),
  `subscription_id` text NOT NULL,
  `rule_id` text NOT NULL,
  `rule_revision` integer NOT NULL,
  `rule_digest` text NOT NULL,
  `owner_user_id` text NOT NULL,
  `port_id` text NOT NULL,
  `target_payload_json` text NOT NULL,
  `target_format_version` integer DEFAULT 1 NOT NULL,
  `target_digest` text NOT NULL,
  `resolved_target_ref` text NOT NULL,
  `receipt_ref` text,
  `status` text DEFAULT 'prepared' NOT NULL,
  `claim_owner` text NOT NULL,
  `claim_attempt` integer NOT NULL,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_automation_work_intents_delivery_unique` ON `event_automation_work_intents` (`delivery_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_automation_work_intents_origin_port_unique` ON `event_automation_work_intents` (`origin_ref`,`port_id`);
--> statement-breakpoint
CREATE INDEX `idx_event_automation_work_intents_status` ON `event_automation_work_intents` (`status`,`updated_at`);
