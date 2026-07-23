-- RFC-223 (PR-3a) — frozen-snapshot agent references from NAME to canonical ID,
-- with R4-1 backfill-safety (design §4.2).
--
-- Global name uniqueness proves only the CURRENT single candidate; it does NOT
-- prove HISTORICAL identity — an old task snapshot froze its agent by NAME, and
-- that name may have been rename+recreate (ABA) reassigned to a DIFFERENT
-- tenant's agent since launch. So we NEVER re-resolve a frozen name by the
-- current table:
--
--   1. node_runs gains `agent_override_id` (sibling of `agent_override_name`).
--      NOT backfilled — legacy rows keep name-only; the sole consumer (room
--      attribution) falls back to the name. Going-forward mints stamp the id.
--   2. single-agent task snapshots: stamp each agent-single node's `agentId`
--      from the TRUSTED launch-time id `tasks.source_agent_id` (RFC-175). When
--      that is NULL (pre-0091 launches — 0091 set it NULL and forbade a name
--      backfill for this very ABA reason) the identity is unrecoverable → the
--      QUARANTINE sentinel (`__rfc223_snapshot_quarantined__`), which resolves to
--      no agent so resume/retry fails closed instead of binding by name.
--   3. workflow / dynamic task snapshots have NO trusted per-node launch-time id
--      → every name-only agent-single node is QUARANTINED (sentinel). Snapshots
--      already carrying `agentId` (launched after PR-2 stamped the definition)
--      are left untouched.
--   4. workgroup task configs: every agent member with no frozen `agentId`
--      (pre-RFC-223 launch) is QUARANTINED (sentinel); the engine resolves
--      members by id and so refuses to re-bind by the mutable display name.
--
-- Scope: only resumable tasks (status NOT IN done/failed) — terminal tasks never
-- re-dispatch, so their name-only snapshots carry no ABA execution risk and are
-- left as-is (their display / distill consumers keep the deterministic name
-- fallback). Fresh installs run this against empty tables → a no-op.

-- 1. node_runs.agent_override_id -------------------------------------------
ALTER TABLE node_runs ADD COLUMN agent_override_id text;
--> statement-breakpoint

-- 2. single-agent task snapshots → node.$.agentId (trusted source_agent_id,
--    else the quarantine sentinel) ------------------------------------------
UPDATE tasks
SET workflow_snapshot = json_set(
  workflow_snapshot,
  '$.nodes',
  json((
    SELECT json_group_array(
      json(
        CASE
          WHEN json_extract(node.value, '$.kind') = 'agent-single'
               AND json_extract(node.value, '$.agentId') IS NULL
          THEN json_set(
            node.value,
            '$.agentId',
            COALESCE(tasks.source_agent_id, '__rfc223_snapshot_quarantined__')
          )
          ELSE node.value
        END
      )
      ORDER BY node.key
    )
    FROM json_each(tasks.workflow_snapshot, '$.nodes') AS node
  ))
)
WHERE source_agent_name IS NOT NULL
  AND status NOT IN ('done', 'failed')
  AND json_valid(workflow_snapshot)
  AND json_array_length(workflow_snapshot, '$.nodes') > 0;
--> statement-breakpoint

-- 3. workflow / dynamic task snapshots → quarantine every name-only agent node
--    (no trusted launch-time id exists for these) ---------------------------
UPDATE tasks
SET workflow_snapshot = json_set(
  workflow_snapshot,
  '$.nodes',
  json((
    SELECT json_group_array(
      json(
        CASE
          WHEN json_extract(node.value, '$.kind') = 'agent-single'
               AND json_extract(node.value, '$.agentId') IS NULL
          THEN json_set(node.value, '$.agentId', '__rfc223_snapshot_quarantined__')
          ELSE node.value
        END
      )
      ORDER BY node.key
    )
    FROM json_each(tasks.workflow_snapshot, '$.nodes') AS node
  ))
)
WHERE source_agent_name IS NULL
  AND workgroup_id IS NULL
  AND status NOT IN ('done', 'failed')
  AND json_valid(workflow_snapshot)
  AND json_array_length(workflow_snapshot, '$.nodes') > 0;
--> statement-breakpoint

-- 4. workgroup task configs → quarantine every agent member with no frozen id -
UPDATE tasks
SET workgroup_config_json = json_set(
  workgroup_config_json,
  '$.members',
  json((
    SELECT json_group_array(
      json(
        CASE
          WHEN json_extract(m.value, '$.memberType') = 'agent'
               AND json_extract(m.value, '$.agentId') IS NULL
          THEN json_set(m.value, '$.agentId', '__rfc223_snapshot_quarantined__')
          ELSE m.value
        END
      )
      ORDER BY m.key
    )
    FROM json_each(tasks.workgroup_config_json, '$.members') AS m
  ))
)
WHERE workgroup_id IS NOT NULL
  AND status NOT IN ('done', 'failed')
  AND json_valid(workgroup_config_json)
  AND json_array_length(workgroup_config_json, '$.members') > 0;
