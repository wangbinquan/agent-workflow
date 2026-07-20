-- RFC-189 — split the leader_worker workgroup ROUND ordinal out of
-- node_runs.retry_index (which workgroup mints historically overloaded as
-- "prior-row count + attempt"; 前端误标事故 d1248df4). New nullable wg_round:
--   - lw leader host rows: 1-based round ordinal (window backfill below — the
--     exact countRoundsUsed derivation frozen at this migration: qualifying =
--     status != canceled AND cause NOT IN (wg-gate, wg-protocol-retry);
--     non-qualifying rows inherit the round they belong to).
--     RFC-209: that derivation now lives in services/workgroupRounds.ts
--     (deriveRoundsUsed) — same口径, plus an exclusion for killed clarify
--     continuations that a revive has already superseded.
--   - lw member host rows: the dispatching assignment's round (authoritative
--     join); message-turn rows (shard 'msg:%') keep the window number.
--   - free_collab rows: NULL — fc round budget is a row COUNT by design
--     (design.md §1 修订), not an ordinal; its accounting is untouched.
--   - __wg_clarify__ / non-workgroup rows: NULL.
-- Hand-written; registered in meta/_journal.json. Window functions + UPDATE
-- ... FROM require SQLite >= 3.33 (bun bundles far newer).
ALTER TABLE `node_runs` ADD COLUMN `wg_round` integer;
--> statement-breakpoint
UPDATE node_runs SET wg_round = sub.rnd
FROM (
  SELECT nr.id AS rid,
         SUM(CASE WHEN nr.status != 'canceled'
                   AND (nr.rerun_cause IS NULL
                        OR nr.rerun_cause NOT IN ('wg-gate','wg-protocol-retry'))
             THEN 1 ELSE 0 END)
           OVER (PARTITION BY nr.task_id, nr.node_id ORDER BY nr.id) AS rnd
  FROM node_runs nr
  JOIN tasks t ON t.id = nr.task_id
  WHERE nr.node_id IN ('__wg_leader__','__wg_member__')
    AND t.workgroup_id IS NOT NULL
    AND json_extract(t.workgroup_config_json, '$.mode') = 'leader_worker'
) AS sub
WHERE node_runs.id = sub.rid;
--> statement-breakpoint
UPDATE node_runs SET wg_round = (
  SELECT wa.round FROM workgroup_assignments wa WHERE wa.id = node_runs.shard_key
)
WHERE node_runs.node_id = '__wg_member__'
  AND node_runs.shard_key IS NOT NULL
  AND node_runs.shard_key NOT LIKE 'msg:%'
  AND EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = node_runs.task_id
      AND t.workgroup_id IS NOT NULL
      AND json_extract(t.workgroup_config_json, '$.mode') = 'leader_worker'
  )
  AND EXISTS (SELECT 1 FROM workgroup_assignments wa WHERE wa.id = node_runs.shard_key);
