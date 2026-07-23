-- RFC-223 (PR-2) — carry the workflow / workgroup / scheduled agent+workgroup
-- references from NAMES to canonical IDS.
--
-- Pure structural + data migration. Under the pre-flip global-uniqueness
-- invariant (a name maps to exactly one row per resource kind) every backfill
-- is deterministic. Fresh installs run this against empty tables → a no-op.
--
--   1. workgroup_members gains an `agent_id` column, backfilled from agent_name
--      (a member whose name resolves to no agent — a soft reference to an agent
--      that does not exist — stays NULL and is caught by launch readiness).
--   2. scheduled_tasks agent / workgroup payloads gain `$.agentId` / `$.workgroupId`
--      (only when the name resolves; a dangling target keeps name-only and is
--      handled by the fire-time fallback).
--   3. every agent-single workflow node gains `$.agentId` (again only when the
--      name resolves; a dangling node stays name-only for the scheduler fallback).

-- 1. workgroup_members.agent_id ---------------------------------------------
ALTER TABLE workgroup_members ADD COLUMN agent_id text;
--> statement-breakpoint
UPDATE workgroup_members
SET agent_id = (SELECT a.id FROM agents a WHERE a.name = workgroup_members.agent_name)
WHERE member_type = 'agent' AND agent_name IS NOT NULL;
--> statement-breakpoint

-- 2a. scheduled agent payloads → $.agentId ----------------------------------
UPDATE scheduled_tasks
SET launch_payload = json_set(
  launch_payload,
  '$.agentId',
  (SELECT a.id FROM agents a WHERE a.name = json_extract(launch_payload, '$.agentName'))
)
WHERE launch_kind = 'agent'
  AND json_valid(launch_payload)
  AND json_extract(launch_payload, '$.agentName') IS NOT NULL
  AND (SELECT a.id FROM agents a WHERE a.name = json_extract(launch_payload, '$.agentName')) IS NOT NULL;
--> statement-breakpoint

-- 2b. scheduled workgroup payloads → $.workgroupId --------------------------
UPDATE scheduled_tasks
SET launch_payload = json_set(
  launch_payload,
  '$.workgroupId',
  (SELECT w.id FROM workgroups w WHERE w.name = json_extract(launch_payload, '$.workgroupName'))
)
WHERE launch_kind = 'workgroup'
  AND json_valid(launch_payload)
  AND json_extract(launch_payload, '$.workgroupName') IS NOT NULL
  AND (SELECT w.id FROM workgroups w WHERE w.name = json_extract(launch_payload, '$.workgroupName')) IS NOT NULL;
--> statement-breakpoint

-- 3. workflow definition nodes → node.$.agentId -----------------------------
-- Rebuild the nodes array in place, stamping agentId onto every agent-single
-- node whose agentName resolves (json() re-parses each element so it nests as
-- an object, not a quoted string; ORDER BY node.key preserves node order — the
-- scheduler + edges key off node id, but stable order keeps diffs/hashes sane).
UPDATE workflows
SET definition = json_set(
  definition,
  '$.nodes',
  json((
    SELECT json_group_array(
      json(
        CASE
          WHEN json_extract(node.value, '$.kind') = 'agent-single'
               AND (SELECT a.id FROM agents a WHERE a.name = json_extract(node.value, '$.agentName')) IS NOT NULL
          THEN json_set(
            node.value,
            '$.agentId',
            (SELECT a.id FROM agents a WHERE a.name = json_extract(node.value, '$.agentName'))
          )
          ELSE node.value
        END
      )
      ORDER BY node.key
    )
    FROM json_each(workflows.definition, '$.nodes') AS node
  ))
)
WHERE json_valid(definition) AND json_array_length(definition, '$.nodes') > 0;
