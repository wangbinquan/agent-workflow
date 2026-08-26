-- RFC-328: durable task-execution ownership, continuation intents, logical
-- effects and retained causal operation records.
--
-- The first five tables are task/effect-owned and cascade with their live
-- aggregate.  Maintenance claims/members and lineage operation records are
-- deliberately free of task FKs: recovery, cleanup and generation continuity
-- must remain possible after a hard delete.

ALTER TABLE `tasks` ADD COLUMN `execution_lineage_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `lineage_slot_path_json` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `continuation_slot_key` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `lineage_slot_path_json` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `operation_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `spawn_launch_nonce` text;
--> statement-breakpoint

-- Legacy roots use their already-stable root_task_id (or own id); child tasks
-- inherit that lineage.  The path is a bounded causal seed.  New production
-- writes persist the full immutable root→slot path in the task/node factories.
UPDATE `tasks`
SET `execution_lineage_id` = COALESCE(NULLIF(`root_task_id`, ''), `id`),
    `lineage_slot_path_json` = json_array(
      json_object(
        'stableNodeKey', CASE WHEN `parent_task_id` IS NULL THEN 'task-root' ELSE 'call-task' END,
        'frozenOccurrenceKey', CASE WHEN `parent_task_id` IS NULL THEN `id` ELSE COALESCE(`parent_node_run_id`, `id`) END,
        'workflowRevision', `workflow_version`
      )
    )
WHERE `execution_lineage_id` IS NULL OR `lineage_slot_path_json` IS NULL;
--> statement-breakpoint

UPDATE `node_runs`
SET `continuation_slot_key` = printf(
      '%s|%d|%s|%s',
      `node_id`,
      `iteration`,
      COALESCE(`shard_key`, ''),
      COALESCE(`rerun_cause`, 'legacy')
    ),
    `lineage_slot_path_json` = json_insert(
      COALESCE(
        (SELECT `t`.`lineage_slot_path_json` FROM `tasks` AS `t` WHERE `t`.`id` = `node_runs`.`task_id`),
        json_array()
      ),
      '$[#]',
      json_object(
        'stableNodeKey', `node_id`,
        'frozenOccurrenceKey', printf('%d|%s', `iteration`, COALESCE(`shard_key`, '')),
        'workflowRevision', (SELECT `t`.`workflow_version` FROM `tasks` AS `t` WHERE `t`.`id` = `node_runs`.`task_id`)
      )
    )
WHERE `continuation_slot_key` IS NULL OR `lineage_slot_path_json` IS NULL;
--> statement-breakpoint

-- Defense for direct SQL/test/task-migration writers that do not use the
-- production factories.  Both triggers execute inside the caller's INSERT
-- transaction; they add only internal causal metadata and do not touch wire
-- fields or lifecycle state.
CREATE TRIGGER `rfc328_tasks_lineage_after_insert`
AFTER INSERT ON `tasks`
WHEN NEW.`execution_lineage_id` IS NULL OR NEW.`lineage_slot_path_json` IS NULL
BEGIN
  UPDATE `tasks`
  SET `execution_lineage_id` = COALESCE(
        (SELECT `p`.`execution_lineage_id` FROM `tasks` AS `p` WHERE `p`.`id` = NEW.`parent_task_id`),
        NEW.`id`
      ),
      `lineage_slot_path_json` = CASE
        WHEN NEW.`parent_task_id` IS NULL THEN json_array(json_object(
          'stableNodeKey', 'task-root',
          'frozenOccurrenceKey', NEW.`id`,
          'workflowRevision', NEW.`workflow_version`
        ))
        ELSE json_insert(
          COALESCE(
            (SELECT `p`.`lineage_slot_path_json` FROM `tasks` AS `p` WHERE `p`.`id` = NEW.`parent_task_id`),
            json_array()
          ),
          '$[#]',
          json_object(
            'stableNodeKey', 'child-task',
            'frozenOccurrenceKey', COALESCE(
              (SELECT `r`.`continuation_slot_key` FROM `node_runs` AS `r` WHERE `r`.`id` = NEW.`parent_node_run_id`),
              NEW.`parent_node_run_id`,
              NEW.`id`
            ),
            'workflowRevision', NEW.`workflow_version`
          )
        )
      END
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint

CREATE TRIGGER `rfc328_node_runs_lineage_after_insert`
AFTER INSERT ON `node_runs`
WHEN NEW.`continuation_slot_key` IS NULL OR NEW.`lineage_slot_path_json` IS NULL
BEGIN
  UPDATE `node_runs`
  SET `continuation_slot_key` = COALESCE(
        NEW.`continuation_slot_key`,
        printf('%s|%d|%s', NEW.`node_id`, NEW.`iteration`, COALESCE(NEW.`shard_key`, ''))
      ),
      `lineage_slot_path_json` = COALESCE(
        NEW.`lineage_slot_path_json`,
        json_insert(
          COALESCE(
            (SELECT `t`.`lineage_slot_path_json` FROM `tasks` AS `t` WHERE `t`.`id` = NEW.`task_id`),
            json_array()
          ),
          '$[#]',
          json_object(
            'stableNodeKey', NEW.`node_id`,
            'frozenOccurrenceKey', printf('%d|%s', NEW.`iteration`, COALESCE(NEW.`shard_key`, '')),
            'workflowRevision', (SELECT `t`.`workflow_version` FROM `tasks` AS `t` WHERE `t`.`id` = NEW.`task_id`)
          )
        )
      )
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint

CREATE TABLE `task_execution_owners` (
  `task_id` text PRIMARY KEY NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `owner_id` text NOT NULL,
  `daemon_generation` text NOT NULL,
  `epoch` integer NOT NULL CHECK (`epoch` > 0),
  `state` text NOT NULL CHECK (`state` IN ('claimed','revoked','released','recovery-required')),
  `lease_until` integer NOT NULL,
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `last_heartbeat_at` integer NOT NULL,
  `recovery_code` text,
  `recovery_proof_digest` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_execution_owners_state_lease`
  ON `task_execution_owners` (`state`, `lease_until`);
--> statement-breakpoint

CREATE TABLE `task_execution_intents` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('launch','resume','retry-repository-preparation','retry-node','sync-workflow','gate-continuation','recovery')),
  `state` text NOT NULL CHECK (`state` IN ('pending','claimed','completed','canceled','failed')),
  `source` text NOT NULL CHECK (`source` IN ('rest','mcp','scheduler','auto','boot','internal')),
  `request_hash` text NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`payload_json`)),
  `execution_lineage_id` text NOT NULL,
  `continuation_slot_key` text NOT NULL,
  `slot_path_json` text NOT NULL CHECK (json_valid(`slot_path_json`)),
  `operation_generation` integer DEFAULT 0 NOT NULL CHECK (`operation_generation` >= 0),
  `replay_authorization_id` text,
  `authorization_scope_json` text CHECK (`authorization_scope_json` IS NULL OR json_valid(`authorization_scope_json`)),
  `expected_task_revision` integer NOT NULL,
  `claimed_epoch` integer CHECK (`claimed_epoch` IS NULL OR `claimed_epoch` > 0),
  `failure_code` text,
  `created_at` integer NOT NULL,
  `claimed_at` integer,
  `completed_at` integer,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_execution_intents_task_state`
  ON `task_execution_intents` (`task_id`, `state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_intents_active_task`
  ON `task_execution_intents` (`task_id`)
  WHERE `state` IN ('pending','claimed');
--> statement-breakpoint

CREATE TABLE `task_execution_effects` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `origin_intent_id` text NOT NULL REFERENCES `task_execution_intents`(`id`) ON DELETE CASCADE,
  `current_intent_id` text NOT NULL REFERENCES `task_execution_intents`(`id`) ON DELETE CASCADE,
  `operation_key` text NOT NULL,
  `execution_lineage_id` text NOT NULL,
  `operation_family_key` text NOT NULL,
  `operation_generation` integer NOT NULL CHECK (`operation_generation` >= 0),
  `kind` text NOT NULL CHECK (`kind` IN ('workspace-prepare','workspace-rollback','isolation-create','isolation-merge','repository','process','workspace-cleanup','code-host-mutation','outbound-mutation')),
  `request_hash` text NOT NULL,
  `slot_path_json` text NOT NULL CHECK (json_valid(`slot_path_json`)),
  `slot_path_digest` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('open','succeeded','failed','outcome-unknown')),
  `last_attempt_no` integer DEFAULT 0 NOT NULL CHECK (`last_attempt_no` >= 0),
  `receipt_json` text CHECK (`receipt_json` IS NULL OR json_valid(`receipt_json`)),
  `failure_code` text,
  `prepared_at` integer NOT NULL,
  `settled_at` integer,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_effects_task_operation_generation`
  ON `task_execution_effects` (`task_id`, `operation_key`, `operation_generation`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_effects_lineage_family_generation`
  ON `task_execution_effects` (`execution_lineage_id`, `operation_family_key`, `operation_generation`);
--> statement-breakpoint
CREATE INDEX `idx_task_execution_effects_task_state`
  ON `task_execution_effects` (`task_id`, `state`);
--> statement-breakpoint

CREATE TABLE `task_execution_effect_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `effect_id` text NOT NULL REFERENCES `task_execution_effects`(`id`) ON DELETE CASCADE,
  `attempt_no` integer NOT NULL CHECK (`attempt_no` > 0),
  `intent_id` text NOT NULL REFERENCES `task_execution_intents`(`id`) ON DELETE CASCADE,
  `epoch` integer NOT NULL CHECK (`epoch` > 0),
  `state` text NOT NULL CHECK (`state` IN ('prepared','acting','succeeded','failed-not-applied','retry-authorized','recovery-required','outcome-unknown')),
  `candidate_id` text NOT NULL,
  `request_hash` text NOT NULL,
  `recovery_class` text NOT NULL,
  `recovery_descriptor_json` text CHECK (`recovery_descriptor_json` IS NULL OR json_valid(`recovery_descriptor_json`)),
  `classifier_version` text NOT NULL,
  `transport_policy_version` text NOT NULL,
  `application_evidence` text CHECK (`application_evidence` IS NULL OR `application_evidence` IN ('applied','definitely-not-applied','ambiguous')),
  `retry_authority` text DEFAULT 'none' NOT NULL CHECK (`retry_authority` IN ('none','probe','convergent','transport-policy')),
  `receipt_json` text CHECK (`receipt_json` IS NULL OR json_valid(`receipt_json`)),
  `failure_code` text,
  `prepared_at` integer NOT NULL,
  `acting_at` integer,
  `settled_at` integer,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_attempts_effect_no`
  ON `task_execution_effect_attempts` (`effect_id`, `attempt_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_attempts_one_active`
  ON `task_execution_effect_attempts` (`effect_id`)
  WHERE `state` IN ('prepared','acting','recovery-required');
--> statement-breakpoint

CREATE TABLE `task_execution_effect_fences` (
  `effect_attempt_id` text NOT NULL REFERENCES `task_execution_effect_attempts`(`id`) ON DELETE CASCADE,
  `fence_key` text NOT NULL,
  `acquired_epoch` integer NOT NULL CHECK (`acquired_epoch` > 0),
  `acquired_at` integer NOT NULL,
  `released_at` integer,
  PRIMARY KEY (`effect_attempt_id`, `fence_key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_effect_fences_active_key`
  ON `task_execution_effect_fences` (`fence_key`)
  WHERE `released_at` IS NULL;
--> statement-breakpoint

CREATE TABLE `task_execution_maintenance_claims` (
  `id` text PRIMARY KEY NOT NULL,
  `root_task_id` text NOT NULL,
  `operation` text NOT NULL CHECK (`operation` IN ('archive','delete','retention','workspace-gc','repair-metadata')),
  `state` text NOT NULL CHECK (`state` IN ('claimed','io-complete','db-finalized','cleanup-pending','completed','recovery-required')),
  `member_set_digest` text NOT NULL,
  `expected_tree_digest` text NOT NULL,
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `cleanup_plan_json` text NOT NULL CHECK (json_valid(`cleanup_plan_json`)),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_task_execution_maintenance_state_updated`
  ON `task_execution_maintenance_claims` (`state`, `updated_at`);
--> statement-breakpoint

CREATE TABLE `task_execution_maintenance_members` (
  `claim_id` text NOT NULL REFERENCES `task_execution_maintenance_claims`(`id`) ON DELETE CASCADE,
  `task_id` text NOT NULL,
  `expected_task_revision` integer NOT NULL,
  `expected_owner_revision` integer,
  `expected_topology_revision` integer NOT NULL,
  `expected_ledger_digest` text NOT NULL,
  `released_at` integer,
  PRIMARY KEY (`claim_id`, `task_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_maintenance_members_active_task`
  ON `task_execution_maintenance_members` (`task_id`)
  WHERE `released_at` IS NULL;
--> statement-breakpoint

CREATE TABLE `task_execution_lineage_operation_records` (
  `id` text PRIMARY KEY NOT NULL,
  `record_kind` text NOT NULL CHECK (`record_kind` IN ('generation-watermark','replay-decision')),
  `execution_lineage_id` text NOT NULL,
  `operation_family_key` text NOT NULL,
  `operation_generation` integer,
  `highest_settled_generation` integer,
  `last_outcome` text,
  `request_hash` text NOT NULL,
  `slot_path_json` text NOT NULL CHECK (json_valid(`slot_path_json`)),
  `slot_path_digest` text NOT NULL,
  `root_anchor_task_id` text,
  `ancestor_anchor_task_id` text,
  `current_anchor_task_id` text,
  `source_task_id` text,
  `source_effect_id` text,
  `source_attempt_id` text,
  `provider_coordinate_json` text CHECK (`provider_coordinate_json` IS NULL OR json_valid(`provider_coordinate_json`)),
  `failure_code` text,
  `decision_state` text CHECK (`decision_state` IS NULL OR `decision_state` IN ('requires-actor','actor-replay-authorized','actor-replay-authorized-suspended','consumed')),
  `replay_authorization_id` text,
  `authorization_scope_json` text CHECK (`authorization_scope_json` IS NULL OR json_valid(`authorization_scope_json`)),
  `actor_user_id` text,
  `authorization_source` text,
  `bound_intent_id` text,
  `new_effect_id` text,
  `record_revision` integer NOT NULL CHECK (`record_revision` > 0),
  `compacted` integer DEFAULT 0 NOT NULL CHECK (`compacted` IN (0,1)),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (
    (`record_kind` = 'generation-watermark'
      AND `highest_settled_generation` IS NOT NULL
      AND `highest_settled_generation` >= 0
      AND `operation_generation` IS NULL
      AND `decision_state` IS NULL)
    OR
    (`record_kind` = 'replay-decision'
      AND `operation_generation` IS NOT NULL
      AND `operation_generation` >= 0
      AND `highest_settled_generation` IS NULL
      AND `decision_state` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_lineage_watermark`
  ON `task_execution_lineage_operation_records` (`execution_lineage_id`, `operation_family_key`)
  WHERE `record_kind` = 'generation-watermark';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_execution_lineage_decision`
  ON `task_execution_lineage_operation_records` (`execution_lineage_id`, `operation_family_key`, `operation_generation`)
  WHERE `record_kind` = 'replay-decision';
--> statement-breakpoint
CREATE INDEX `idx_task_execution_lineage_decision_state`
  ON `task_execution_lineage_operation_records` (`record_kind`, `decision_state`, `updated_at`);
