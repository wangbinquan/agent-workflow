-- RFC-223 (PR-3a impl-gate, C1 + C2) — extend the R4-1 frozen-snapshot backfill
-- to the two populations migration 0113 wrongly excluded. 0113 must NOT be
-- re-edited (already applied + pushed; drizzle never replays an applied
-- migration), so this follow-up migration closes the gaps.
--
-- C1 (fail-open) — TERMINAL tasks were left name-only. 0113 scoped every backfill
-- to `status NOT IN (done, failed)` on the premise that terminal tasks never
-- re-dispatch. That premise is false: a `failed` task can `resume` (task.ts) and
-- a `done`/`failed` task can `retry` (task.ts), and neither terminal state blocks
-- the agent rename/delete guard — so an ABA rename+recreate can slip a DIFFERENT
-- tenant's agent under the frozen NAME, and a retried node with no agentId would
-- resolve by that stale name (scheduler getAgent-by-name path). We therefore apply
-- 0113's exact per-population logic to terminal tasks too:
--   * single-agent  → node.$.agentId = COALESCE(source_agent_id, quarantine)
--   * workflow/dynamic (non-workgroup) → quarantine every name-only agent node
--   * workgroup members → quarantine every agent member with no frozen id
--
-- C2 (fail-open) — historical DYNAMIC / workgroup `workflow_snapshot` DAGs were
-- never quarantined. 0113's workflow-snapshot quarantine (statement 3) required
-- `workgroup_id IS NULL`, so a workgroup task's generated DAG (name-only
-- agent-single nodes produced by the dynamic runner before PR-3b stamped
-- agentId) escaped quarantine entirely — for EVERY status. PR-3b fixes the
-- going-forward runtime (resolvePool binds by the frozen id); this migration
-- quarantines the historical name-only nodes so a legacy generated DAG fails
-- closed instead of re-binding by the mutable name.
--
-- Fresh installs run this against empty tables → a no-op. The CASE guards only
-- touch agent-single nodes / agent members whose `agentId` is still NULL, so a
-- node/member already carrying an id (0113-stamped or PR-2/PR-3b going-forward)
-- is left untouched — idempotent alongside 0113.

-- C1.1 single-agent TERMINAL task snapshots → node.$.agentId (trusted
--      source_agent_id, else the quarantine sentinel). Mirrors 0113 statement 2,
--      status flipped to the terminal set. -----------------------------------
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
  AND status IN ('done', 'failed')
  AND json_valid(workflow_snapshot)
  AND json_array_length(workflow_snapshot, '$.nodes') > 0;
--> statement-breakpoint

-- C1.2 workflow / dynamic (non-workgroup) TERMINAL task snapshots → quarantine
--      every name-only agent node. Mirrors 0113 statement 3, terminal set. ----
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
  AND status IN ('done', 'failed')
  AND json_valid(workflow_snapshot)
  AND json_array_length(workflow_snapshot, '$.nodes') > 0;
--> statement-breakpoint

-- C2  workgroup task `workflow_snapshot` DAGs → quarantine every name-only agent
--     node, for ALL statuses (0113 never touched workgroup snapshots at all: its
--     statement 3 required workgroup_id IS NULL, its statement 4 only rewrote
--     workgroup_config_json.members). Covers both the C2 resumable gap and the
--     C1 terminal workgroup gap in one pass. --------------------------------
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
WHERE workgroup_id IS NOT NULL
  AND json_valid(workflow_snapshot)
  AND json_array_length(workflow_snapshot, '$.nodes') > 0;
--> statement-breakpoint

-- C1.3 workgroup TERMINAL task configs → quarantine every agent member with no
--      frozen id. Mirrors 0113 statement 4, terminal set. -------------------
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
  AND status IN ('done', 'failed')
  AND json_valid(workgroup_config_json)
  AND json_array_length(workgroup_config_json, '$.members') > 0;
