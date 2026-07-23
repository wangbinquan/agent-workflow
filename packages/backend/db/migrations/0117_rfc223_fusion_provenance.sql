-- RFC-223 PR-4 — immutable fusion/memory provenance.
--
-- Historical identity may NEVER be guessed by joining the mutable display
-- name to the current skills row: rename + delete/recreate makes that an ABA
-- bind to a different tenant's skill. A committed source='fusion'
-- skill_versions row is a trustworthy oracle because the version row and
-- memory fuse were written in the same transaction. It is accepted only when
-- every row for that fusion agrees on exactly one skill_id. Every other
-- historical row is quarantined with a deliberately non-resolving sentinel.
ALTER TABLE `fusions` ADD COLUMN `skill_id` text;
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `fused_into_skill_id` text;
--> statement-breakpoint

UPDATE `fusions`
SET `skill_id` = (
  SELECT MIN(`sv`.`skill_id`)
  FROM `skill_versions` AS `sv`
  WHERE `sv`.`fusion_id` = `fusions`.`id`
    AND `sv`.`source` = 'fusion'
)
WHERE (
  SELECT COUNT(DISTINCT `sv`.`skill_id`)
  FROM `skill_versions` AS `sv`
  WHERE `sv`.`fusion_id` = `fusions`.`id`
    AND `sv`.`source` = 'fusion'
) = 1;
--> statement-breakpoint

UPDATE `fusions`
SET `skill_id` = '__rfc223_fusion_skill_quarantined__'
WHERE `skill_id` IS NULL;
--> statement-breakpoint

-- A fused memory carries both the fusion id and the version at which its
-- knowledge entered the skill. Require that exact version oracle and require
-- it to agree with the already-resolved fusion identity.
UPDATE `memories`
SET `fused_into_skill_id` = (
  SELECT MIN(`sv`.`skill_id`)
  FROM `skill_versions` AS `sv`
  INNER JOIN `fusions` AS `f` ON `f`.`id` = `memories`.`fused_fusion_id`
  WHERE `sv`.`fusion_id` = `memories`.`fused_fusion_id`
    AND `sv`.`version_index` = `memories`.`fused_into_skill_version`
    AND `sv`.`source` = 'fusion'
    AND `sv`.`skill_id` = `f`.`skill_id`
)
WHERE `status` = 'fused'
  AND (
    SELECT COUNT(DISTINCT `sv`.`skill_id`)
    FROM `skill_versions` AS `sv`
    INNER JOIN `fusions` AS `f` ON `f`.`id` = `memories`.`fused_fusion_id`
    WHERE `sv`.`fusion_id` = `memories`.`fused_fusion_id`
      AND `sv`.`version_index` = `memories`.`fused_into_skill_version`
      AND `sv`.`source` = 'fusion'
      AND `sv`.`skill_id` = `f`.`skill_id`
  ) = 1;
--> statement-breakpoint

UPDATE `memories`
SET `fused_into_skill_id` = '__rfc223_fusion_skill_quarantined__'
WHERE `status` = 'fused'
  AND `fused_into_skill_id` IS NULL;
--> statement-breakpoint

-- Rebuild fusions so the going-forward canonical identity is physically
-- NOT NULL, not merely a TypeScript promise. Historical quarantine is a real,
-- non-null identity value that resolves to no skill.
CREATE TABLE `__new_fusions` (
  `id` text PRIMARY KEY NOT NULL,
  `skill_id` text NOT NULL,
  `skill_name` text NOT NULL,
  `base_skill_version` integer NOT NULL,
  `precondition_token` text,
  `memory_ids_json` text NOT NULL,
  `intent` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'running' NOT NULL,
  `iteration` integer DEFAULT 1 NOT NULL,
  `current_task_id` text,
  `proposed_worktree_path` text,
  `proposed_diff` text,
  `incorporated_memory_ids_json` text,
  `skipped_json` text,
  `changelog` text,
  `applied_skill_version` integer,
  `owner_user_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `decided_by_user_id` text,
  `decided_at` integer,
  `decision_reason` text,
  `error` text,
  CHECK (`status` IN ('running','awaiting_approval','applying','done','rejected','canceled','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_fusions` (
  `id`,`skill_id`,`skill_name`,`base_skill_version`,`precondition_token`,
  `memory_ids_json`,`intent`,`status`,`iteration`,`current_task_id`,
  `proposed_worktree_path`,`proposed_diff`,`incorporated_memory_ids_json`,
  `skipped_json`,`changelog`,`applied_skill_version`,`owner_user_id`,
  `created_at`,`decided_by_user_id`,`decided_at`,`decision_reason`,`error`
)
SELECT
  `id`,`skill_id`,`skill_name`,`base_skill_version`,`precondition_token`,
  `memory_ids_json`,`intent`,`status`,`iteration`,`current_task_id`,
  `proposed_worktree_path`,`proposed_diff`,`incorporated_memory_ids_json`,
  `skipped_json`,`changelog`,`applied_skill_version`,`owner_user_id`,
  `created_at`,`decided_by_user_id`,`decided_at`,`decision_reason`,`error`
FROM `fusions`;
--> statement-breakpoint
DROP TABLE `fusions`;
--> statement-breakpoint
ALTER TABLE `__new_fusions` RENAME TO `fusions`;
--> statement-breakpoint
CREATE INDEX `idx_fusions_skill` ON `fusions` (`skill_id`);
--> statement-breakpoint
CREATE INDEX `idx_fusions_status` ON `fusions` (`status`);
--> statement-breakpoint

-- Rebuild memories to make the provenance invariant symmetric: fused rows
-- require both immutable id and display name; every other status requires both
-- to be NULL. This prevents a future writer from manufacturing half-provenance.
-- Rename the old table first, then create the final name directly. This keeps
-- the self-FKs correct in both daemon mode (foreign_keys=OFF during migrations)
-- and direct migrator/test mode (foreign_keys=ON); relying on SQLite to rewrite
-- a __new_memories self-reference during the final rename is mode-dependent.
ALTER TABLE `memories` RENAME TO `__old_memories`;
--> statement-breakpoint
CREATE TABLE `memories` (
  `id` text PRIMARY KEY NOT NULL,
  `scope_type` text NOT NULL,
  `scope_id` text,
  `title` text NOT NULL,
  `body_md` text NOT NULL,
  `tags` text DEFAULT '[]' NOT NULL,
  `status` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_event_id` text,
  `source_task_id` text,
  `distill_job_id` text,
  `distill_action` text,
  `supersedes_id` text,
  `superseded_by_id` text,
  `approved_by_user_id` text,
  `approved_at` integer,
  `created_at` integer NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `fused_into_skill` text,
  `fused_into_skill_id` text,
  `fused_into_skill_version` integer,
  `fused_at` integer,
  `fused_by_user_id` text,
  `fused_fusion_id` text,
  CHECK (`scope_type` IN ('agent','workflow','repo','global')),
  CHECK (`status` IN ('candidate','approved','archived','superseded','rejected','fused')),
  CHECK (`source_kind` IN ('clarify','review','feedback','manual')),
  CHECK (`distill_action` IS NULL OR `distill_action` IN ('new','update_of','duplicate_of','conflict_with')),
  CHECK (
    (`scope_type` = 'global' AND `scope_id` IS NULL) OR
    (`scope_type` != 'global' AND `scope_id` IS NOT NULL)
  ),
  CHECK ((`status` = 'fused') = (`fused_into_skill` IS NOT NULL)),
  CHECK ((`status` = 'fused') = (`fused_into_skill_id` IS NOT NULL)),
  FOREIGN KEY (`supersedes_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`superseded_by_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `memories` (
  `id`,`scope_type`,`scope_id`,`title`,`body_md`,`tags`,`status`,`source_kind`,
  `source_event_id`,`source_task_id`,`distill_job_id`,`distill_action`,
  `supersedes_id`,`superseded_by_id`,`approved_by_user_id`,`approved_at`,
  `created_at`,`version`,`fused_into_skill`,`fused_into_skill_id`,
  `fused_into_skill_version`,`fused_at`,`fused_by_user_id`,`fused_fusion_id`
)
SELECT
  `id`,`scope_type`,`scope_id`,`title`,`body_md`,`tags`,`status`,`source_kind`,
  `source_event_id`,`source_task_id`,`distill_job_id`,`distill_action`,
  `supersedes_id`,`superseded_by_id`,`approved_by_user_id`,`approved_at`,
  `created_at`,`version`,`fused_into_skill`,`fused_into_skill_id`,
  `fused_into_skill_version`,`fused_at`,`fused_by_user_id`,`fused_fusion_id`
FROM `__old_memories`;
--> statement-breakpoint
DROP TABLE `__old_memories`;
--> statement-breakpoint
CREATE INDEX `idx_memories_scope_status` ON `memories` (`scope_type`,`scope_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_memories_status_created` ON `memories` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_memories_supersedes` ON `memories` (`supersedes_id`);
--> statement-breakpoint
CREATE INDEX `idx_memories_source` ON `memories` (`source_kind`,`source_event_id`);
--> statement-breakpoint
CREATE INDEX `idx_memories_fused_skill_id`
  ON `memories` (`fused_into_skill_id`, `fused_into_skill_version`);
--> statement-breakpoint

-- Stable framework agent/workflow ids. A fixed-id row with the reserved name
-- is canonical even when its repairable builtin/owner/visibility fields
-- drifted. A different-name occupant is a hard collision. Away from the fixed
-- id, only builtin=1 is trustworthy enough to identify the legacy framework
-- row; an ordinary same-name user row is never adopted.
CREATE TEMP TABLE `__rfc223_builtin_id_guard` (
  `n` integer CHECK (`n` = 0)
);
--> statement-breakpoint
INSERT INTO `__rfc223_builtin_id_guard`
SELECT COUNT(*)
FROM `agents`
WHERE `id` = '00000000000000000000000001'
  AND `name` != 'aw-skill-merger';
--> statement-breakpoint
INSERT INTO `__rfc223_builtin_id_guard`
SELECT COUNT(*)
FROM `workflows`
WHERE `id` = '00000000000000000000000002'
  AND `name` != 'aw-skill-fusion';
--> statement-breakpoint
INSERT INTO `__rfc223_builtin_id_guard`
SELECT MAX(COUNT(*) - 1, 0)
FROM `agents`
WHERE (`id` = '00000000000000000000000001' AND `name` = 'aw-skill-merger')
   OR (`builtin` = 1 AND `name` = 'aw-skill-merger');
--> statement-breakpoint
INSERT INTO `__rfc223_builtin_id_guard`
SELECT MAX(COUNT(*) - 1, 0)
FROM `workflows`
WHERE (`id` = '00000000000000000000000002' AND `name` = 'aw-skill-fusion')
   OR (`builtin` = 1 AND `name` = 'aw-skill-fusion');
--> statement-breakpoint
DROP TABLE `__rfc223_builtin_id_guard`;
--> statement-breakpoint

CREATE TEMP TABLE `__rfc223_builtin_agent_map` (
  `old_id` text PRIMARY KEY NOT NULL,
  `new_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__rfc223_builtin_agent_map` (`old_id`, `new_id`)
SELECT `id`, '00000000000000000000000001'
FROM `agents`
WHERE `builtin` = 1
  AND `name` = 'aw-skill-merger'
  AND `id` != '00000000000000000000000001'
LIMIT 1;
--> statement-breakpoint
CREATE TEMP TABLE `__rfc223_builtin_workflow_map` (
  `old_id` text PRIMARY KEY NOT NULL,
  `new_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__rfc223_builtin_workflow_map` (`old_id`, `new_id`)
SELECT `id`, '00000000000000000000000002'
FROM `workflows`
WHERE `builtin` = 1
  AND `name` = 'aw-skill-fusion'
  AND `id` != '00000000000000000000000002'
LIMIT 1;
--> statement-breakpoint

-- tasks.workflow_id is a real NO ACTION FK. Materialise the canonical workflow
-- first, retarget every reference, then delete the legacy row.
INSERT INTO `workflows` (
  `id`,`name`,`description`,`definition`,`version`,`schema_version`,
  `created_at`,`updated_at`,`owner_user_id`,`visibility`,`builtin`,`acl_revision`
)
SELECT
  `m`.`new_id`,`w`.`name`,`w`.`description`,`w`.`definition`,`w`.`version`,
  `w`.`schema_version`,`w`.`created_at`,`w`.`updated_at`,`w`.`owner_user_id`,
  `w`.`visibility`,0,`w`.`acl_revision`
FROM `workflows` AS `w`
INNER JOIN `__rfc223_builtin_workflow_map` AS `m` ON `m`.`old_id` = `w`.`id`;
--> statement-breakpoint

-- resource_grants has a composite PK. Insert canonical grants first and then
-- delete legacy grants so an existing canonical duplicate is merged safely.
INSERT OR IGNORE INTO `resource_grants`
  (`resource_type`,`resource_id`,`user_id`,`added_by`,`added_at`)
SELECT
  `g`.`resource_type`,`m`.`new_id`,`g`.`user_id`,`g`.`added_by`,`g`.`added_at`
FROM `resource_grants` AS `g`
INNER JOIN `__rfc223_builtin_agent_map` AS `m` ON `m`.`old_id` = `g`.`resource_id`
WHERE `g`.`resource_type` = 'agent';
--> statement-breakpoint
DELETE FROM `resource_grants`
WHERE `resource_type` = 'agent'
  AND `resource_id` IN (SELECT `old_id` FROM `__rfc223_builtin_agent_map`);
--> statement-breakpoint
INSERT OR IGNORE INTO `resource_grants`
  (`resource_type`,`resource_id`,`user_id`,`added_by`,`added_at`)
SELECT
  `g`.`resource_type`,`m`.`new_id`,`g`.`user_id`,`g`.`added_by`,`g`.`added_at`
FROM `resource_grants` AS `g`
INNER JOIN `__rfc223_builtin_workflow_map` AS `m`
  ON `m`.`old_id` = `g`.`resource_id`
WHERE `g`.`resource_type` = 'workflow';
--> statement-breakpoint
DELETE FROM `resource_grants`
WHERE `resource_type` = 'workflow'
  AND `resource_id` IN (SELECT `old_id` FROM `__rfc223_builtin_workflow_map`);
--> statement-breakpoint
UPDATE `workgroup_members`
SET `agent_id` = (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
WHERE `agent_id` = (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1);
--> statement-breakpoint
UPDATE `tasks`
SET `source_agent_id` = (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
WHERE `source_agent_id` = (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1);
--> statement-breakpoint
UPDATE `tasks`
SET `workflow_id` = (SELECT `new_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1)
WHERE `workflow_id` = (SELECT `old_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1);
--> statement-breakpoint
UPDATE `node_runs`
SET `agent_override_id` = (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
WHERE `agent_override_id` = (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1);
--> statement-breakpoint
UPDATE `memories`
SET `scope_id` = (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
WHERE `scope_type` = 'agent'
  AND `scope_id` = (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1);
--> statement-breakpoint
UPDATE `memories`
SET `scope_id` = (SELECT `new_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1)
WHERE `scope_type` = 'workflow'
  AND `scope_id` = (SELECT `old_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1);
--> statement-breakpoint

UPDATE `agents`
SET `depends_on` = json((
  SELECT json_group_array(`rewritten`)
  FROM (
    SELECT `rewritten`, MIN(`original_key`) AS `first_key`
    FROM (
      SELECT
        dep.key AS `original_key`,
        CASE
          WHEN dep.value = (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
          THEN (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
          ELSE dep.value
        END AS `rewritten`
      FROM json_each(`agents`.`depends_on`) AS dep
    )
    GROUP BY `rewritten`
    ORDER BY `first_key`
  )
))
WHERE json_valid(`depends_on`)
  AND EXISTS (
    SELECT 1 FROM json_each(`agents`.`depends_on`) AS dep
    WHERE dep.value = (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
  );
--> statement-breakpoint
UPDATE `workflows`
SET
  `definition` = json_set(
    `definition`,
    '$.nodes',
    json((
      SELECT json_group_array(
        json(
          CASE
            WHEN json_extract(node.value, '$.agentId') =
                 (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
            THEN json_set(
              node.value,
              '$.agentId',
              (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
            )
            ELSE node.value
          END
        )
        ORDER BY node.key
      )
      FROM json_each(`workflows`.`definition`, '$.nodes') AS node
    ))
  ),
  `version` = `version` + 1
WHERE json_valid(`definition`)
  AND EXISTS (
    SELECT 1
    FROM json_each(`workflows`.`definition`, '$.nodes') AS node
    WHERE json_extract(node.value, '$.agentId') =
          (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
  );
--> statement-breakpoint
UPDATE `tasks`
SET `workflow_snapshot` = json_set(
  `workflow_snapshot`,
  '$.nodes',
  json((
    SELECT json_group_array(
      json(
        CASE
          WHEN json_extract(node.value, '$.agentId') =
               (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
          THEN json_set(
            node.value,
            '$.agentId',
            (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
          )
          ELSE node.value
        END
      )
      ORDER BY node.key
    )
    FROM json_each(`tasks`.`workflow_snapshot`, '$.nodes') AS node
  ))
)
WHERE json_valid(`workflow_snapshot`)
  AND EXISTS (
    SELECT 1
    FROM json_each(`tasks`.`workflow_snapshot`, '$.nodes') AS node
    WHERE json_extract(node.value, '$.agentId') =
          (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
  );
--> statement-breakpoint
UPDATE `tasks`
SET `workgroup_config_json` = json_set(
  `workgroup_config_json`,
  '$.members',
  json((
    SELECT json_group_array(
      json(
        CASE
          WHEN json_extract(member.value, '$.agentId') =
               (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
          THEN json_set(
            member.value,
            '$.agentId',
            (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
          )
          ELSE member.value
        END
      )
      ORDER BY member.key
    )
    FROM json_each(`tasks`.`workgroup_config_json`, '$.members') AS member
  ))
)
WHERE `workgroup_config_json` IS NOT NULL
  AND json_valid(`workgroup_config_json`)
  AND EXISTS (
    SELECT 1
    FROM json_each(`tasks`.`workgroup_config_json`, '$.members') AS member
    WHERE json_extract(member.value, '$.agentId') =
          (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
  );
--> statement-breakpoint
UPDATE `scheduled_tasks`
SET `launch_payload` = json_set(
  `launch_payload`,
  '$.agentId',
  (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
)
WHERE `launch_kind` = 'agent'
  AND json_valid(`launch_payload`)
  AND json_extract(`launch_payload`, '$.agentId') =
      (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1);
--> statement-breakpoint
UPDATE `scheduled_tasks`
SET `launch_payload` = json_set(
  `launch_payload`,
  '$.workflowId',
  (SELECT `new_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1)
)
WHERE json_valid(`launch_payload`)
  AND json_extract(`launch_payload`, '$.workflowId') =
      (SELECT `old_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1);
--> statement-breakpoint
UPDATE `memory_distill_jobs`
SET `scope_resolved_json` = json_set(
  `scope_resolved_json`,
  '$.agentIds',
  json((
    SELECT json_group_array(`rewritten`)
    FROM (
      SELECT `rewritten`, MIN(`original_key`) AS `first_key`
      FROM (
        SELECT
          aid.key AS `original_key`,
          CASE
            WHEN aid.value =
                 (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
            THEN (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
            ELSE aid.value
          END AS `rewritten`
        FROM json_each(`memory_distill_jobs`.`scope_resolved_json`, '$.agentIds') AS aid
      )
      GROUP BY `rewritten`
      ORDER BY `first_key`
    )
  ))
)
WHERE json_valid(`scope_resolved_json`)
  AND json_type(`scope_resolved_json`, '$.agentIds') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(`memory_distill_jobs`.`scope_resolved_json`, '$.agentIds') AS aid
    WHERE aid.value = (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
  );
--> statement-breakpoint
UPDATE `memory_distill_jobs`
SET `scope_resolved_json` = json_set(
  `scope_resolved_json`,
  '$.workflowId',
  (SELECT `new_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1)
)
WHERE json_valid(`scope_resolved_json`)
  AND json_extract(`scope_resolved_json`, '$.workflowId') =
      (SELECT `old_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1);
--> statement-breakpoint
UPDATE `workgroup_task_state`
SET `dw_state_json` = json_set(
  `dw_state_json`,
  '$.generatedDef.nodes',
  json((
    SELECT json_group_array(
      json(
        CASE
          WHEN json_extract(node.value, '$.agentId') =
               (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
          THEN json_set(
            node.value,
            '$.agentId',
            (SELECT `new_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
          )
          ELSE node.value
        END
      )
      ORDER BY node.key
    )
    FROM json_each(`workgroup_task_state`.`dw_state_json`, '$.generatedDef.nodes') AS node
  ))
)
WHERE `dw_state_json` IS NOT NULL
  AND json_valid(`dw_state_json`)
  AND EXISTS (
    SELECT 1
    FROM json_each(`workgroup_task_state`.`dw_state_json`, '$.generatedDef.nodes') AS node
    WHERE json_extract(node.value, '$.agentId') =
          (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
  );
--> statement-breakpoint

UPDATE `agents`
SET
  `id` = '00000000000000000000000001',
  `owner_user_id` = '__system__',
  `visibility` = 'public',
  `builtin` = 1
WHERE `id` = (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1);
--> statement-breakpoint
DELETE FROM `workflows`
WHERE `id` = (SELECT `old_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1);
--> statement-breakpoint
UPDATE `workflows`
SET
  `owner_user_id` = '__system__',
  `visibility` = 'public',
  `builtin` = 1
WHERE `id` = '00000000000000000000000002'
  AND `name` = 'aw-skill-fusion';
--> statement-breakpoint
UPDATE `agents`
SET
  `owner_user_id` = '__system__',
  `visibility` = 'public',
  `builtin` = 1
WHERE `id` = '00000000000000000000000001'
  AND `name` = 'aw-skill-merger';
--> statement-breakpoint

-- Fail closed if any executable/reference-bearing surface still points to a
-- legacy id. Free text and immutable audit snapshots are intentionally out.
CREATE TEMP TABLE `__rfc223_builtin_ref_guard` (
  `n` integer CHECK (`n` = 0)
);
--> statement-breakpoint
INSERT INTO `__rfc223_builtin_ref_guard`
SELECT
  (SELECT COUNT(*) FROM `resource_grants`
   WHERE (`resource_type` = 'agent' AND `resource_id` IN
          (SELECT `old_id` FROM `__rfc223_builtin_agent_map`))
      OR (`resource_type` = 'workflow' AND `resource_id` IN
          (SELECT `old_id` FROM `__rfc223_builtin_workflow_map`)))
  + (SELECT COUNT(*) FROM `workgroup_members`
     WHERE `agent_id` IN (SELECT `old_id` FROM `__rfc223_builtin_agent_map`))
  + (SELECT COUNT(*) FROM `tasks`
     WHERE `source_agent_id` IN (SELECT `old_id` FROM `__rfc223_builtin_agent_map`)
        OR `workflow_id` IN (SELECT `old_id` FROM `__rfc223_builtin_workflow_map`))
  + (SELECT COUNT(*) FROM `node_runs`
     WHERE `agent_override_id` IN (SELECT `old_id` FROM `__rfc223_builtin_agent_map`))
  + (SELECT COUNT(*) FROM `memories`
     WHERE (`scope_type` = 'agent' AND `scope_id` IN
            (SELECT `old_id` FROM `__rfc223_builtin_agent_map`))
        OR (`scope_type` = 'workflow' AND `scope_id` IN
            (SELECT `old_id` FROM `__rfc223_builtin_workflow_map`)));
--> statement-breakpoint
INSERT INTO `__rfc223_builtin_ref_guard`
SELECT
  (SELECT COUNT(*) FROM `agents`
   WHERE (
     json_valid(`depends_on`) AND EXISTS (
       SELECT 1 FROM json_each(`agents`.`depends_on`) AS dep
       WHERE dep.value IN (SELECT `old_id` FROM `__rfc223_builtin_agent_map`)
     )
   ) OR (
     NOT json_valid(`depends_on`)
     AND EXISTS (SELECT 1 FROM `__rfc223_builtin_agent_map`)
     AND instr(
       `depends_on`,
       (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
     ) > 0
   ))
  + (SELECT COUNT(*) FROM `workflows`
     WHERE (
       json_valid(`definition`) AND EXISTS (
         SELECT 1 FROM json_each(`workflows`.`definition`, '$.nodes') AS node
         WHERE json_extract(node.value, '$.agentId') IN
               (SELECT `old_id` FROM `__rfc223_builtin_agent_map`)
       )
     ) OR (
       NOT json_valid(`definition`)
       AND EXISTS (SELECT 1 FROM `__rfc223_builtin_agent_map`)
       AND instr(
         `definition`,
         (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
       ) > 0
     ))
  + (SELECT COUNT(*) FROM `tasks`
     WHERE (
       json_valid(`workflow_snapshot`) AND EXISTS (
         SELECT 1 FROM json_each(`tasks`.`workflow_snapshot`, '$.nodes') AS node
         WHERE json_extract(node.value, '$.agentId') IN
               (SELECT `old_id` FROM `__rfc223_builtin_agent_map`)
       )
     ) OR (
       NOT json_valid(`workflow_snapshot`)
       AND EXISTS (SELECT 1 FROM `__rfc223_builtin_agent_map`)
       AND instr(
         `workflow_snapshot`,
         (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
       ) > 0
     ) OR (
       `workgroup_config_json` IS NOT NULL AND json_valid(`workgroup_config_json`)
       AND EXISTS (
         SELECT 1 FROM json_each(`tasks`.`workgroup_config_json`, '$.members') AS member
         WHERE json_extract(member.value, '$.agentId') IN
               (SELECT `old_id` FROM `__rfc223_builtin_agent_map`)
       )
     ) OR (
       `workgroup_config_json` IS NOT NULL AND NOT json_valid(`workgroup_config_json`)
       AND EXISTS (SELECT 1 FROM `__rfc223_builtin_agent_map`)
       AND instr(
         `workgroup_config_json`,
         (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
       ) > 0
     ))
  + (SELECT COUNT(*) FROM `scheduled_tasks`
     WHERE (
       json_valid(`launch_payload`) AND (
         json_extract(`launch_payload`, '$.agentId') IN
           (SELECT `old_id` FROM `__rfc223_builtin_agent_map`)
         OR json_extract(`launch_payload`, '$.workflowId') IN
           (SELECT `old_id` FROM `__rfc223_builtin_workflow_map`)
       )
     ) OR (
       NOT json_valid(`launch_payload`) AND (
         (
           EXISTS (SELECT 1 FROM `__rfc223_builtin_agent_map`) AND instr(
           `launch_payload`,
           (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
           ) > 0
         )
         OR (
           EXISTS (SELECT 1 FROM `__rfc223_builtin_workflow_map`) AND instr(
           `launch_payload`,
           (SELECT `old_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1)
           ) > 0
         )
       )
     ))
  + (SELECT COUNT(*) FROM `memory_distill_jobs`
     WHERE (
       json_valid(`scope_resolved_json`) AND (
         EXISTS (
           SELECT 1
           FROM json_each(`memory_distill_jobs`.`scope_resolved_json`, '$.agentIds') AS aid
           WHERE aid.value IN (SELECT `old_id` FROM `__rfc223_builtin_agent_map`)
         )
         OR json_extract(`scope_resolved_json`, '$.workflowId') IN
           (SELECT `old_id` FROM `__rfc223_builtin_workflow_map`)
       )
     ) OR (
       NOT json_valid(`scope_resolved_json`) AND (
         (
           EXISTS (SELECT 1 FROM `__rfc223_builtin_agent_map`) AND instr(
           `scope_resolved_json`,
           (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
           ) > 0
         )
         OR (
           EXISTS (SELECT 1 FROM `__rfc223_builtin_workflow_map`) AND instr(
           `scope_resolved_json`,
           (SELECT `old_id` FROM `__rfc223_builtin_workflow_map` LIMIT 1)
           ) > 0
         )
       )
     ))
  + (SELECT COUNT(*) FROM `workgroup_task_state`
     WHERE `dw_state_json` IS NOT NULL AND (
       (
         json_valid(`dw_state_json`) AND EXISTS (
           SELECT 1
           FROM json_each(
             `workgroup_task_state`.`dw_state_json`,
             '$.generatedDef.nodes'
           ) AS node
           WHERE json_extract(node.value, '$.agentId') IN
                 (SELECT `old_id` FROM `__rfc223_builtin_agent_map`)
         )
       ) OR (
         NOT json_valid(`dw_state_json`)
         AND EXISTS (SELECT 1 FROM `__rfc223_builtin_agent_map`)
         AND instr(
           `dw_state_json`,
           (SELECT `old_id` FROM `__rfc223_builtin_agent_map` LIMIT 1)
         ) > 0
       )
     ));
--> statement-breakpoint
DROP TABLE `__rfc223_builtin_ref_guard`;
--> statement-breakpoint
DROP TABLE `__rfc223_builtin_agent_map`;
--> statement-breakpoint
DROP TABLE `__rfc223_builtin_workflow_map`;
