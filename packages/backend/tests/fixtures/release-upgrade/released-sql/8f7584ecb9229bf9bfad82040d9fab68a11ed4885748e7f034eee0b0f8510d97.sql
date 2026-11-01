-- RFC-223 (PR-1) — backfill agents' active reference columns from NAMES to IDS.
--
-- Pure data migration; the column TYPES are unchanged (all still `text` holding
-- JSON). Under the pre-flip global-uniqueness invariant (name is unique per
-- resource kind) each name maps to exactly one row, so the backfill is
-- deterministic. Fresh installs run this against an empty `agents` table → a
-- no-op. A dev upgrade rewrites every existing row's mcp / plugins / depends_on
-- arrays (name → id) and its skills array (name → typed AgentSkillRef).
--
-- Notes:
--  * json_each preserves array order via its integer `key`; ORDER BY je.key keeps
--    the reference order stable (injection determinism).
--  * mcp / plugins / depends_on use an INNER JOIN: a name that resolves to no row
--    (a dangling reference) is dropped — it was already invalid.
--  * skills uses a LEFT JOIN: a name that matches a managed skill row becomes a
--    {kind:'managed', skillId} ref; a name with NO row is a repo-local skill
--    (RFC-178) and becomes {kind:'project', name}.
--  * COALESCE(..., '[]') guards the empty-array case (json_group_array over zero
--    rows is NULL).

UPDATE agents SET mcp = COALESCE(
  (
    SELECT json_group_array(m.id ORDER BY je.key)
    FROM json_each(agents.mcp) je
    JOIN mcps m ON m.name = je.value
  ),
  '[]'
);
--> statement-breakpoint
UPDATE agents SET plugins = COALESCE(
  (
    SELECT json_group_array(p.id ORDER BY je.key)
    FROM json_each(agents.plugins) je
    JOIN plugins p ON p.name = je.value
  ),
  '[]'
);
--> statement-breakpoint
UPDATE agents SET depends_on = COALESCE(
  (
    SELECT json_group_array(a2.id ORDER BY je.key)
    FROM json_each(agents.depends_on) je
    JOIN agents a2 ON a2.name = je.value
  ),
  '[]'
);
--> statement-breakpoint
UPDATE agents SET skills = COALESCE(
  (
    SELECT json_group_array(
      CASE
        WHEN s.id IS NOT NULL THEN json_object('kind', 'managed', 'skillId', s.id)
        ELSE json_object('kind', 'project', 'name', je.value)
      END
      ORDER BY je.key
    )
    FROM json_each(agents.skills) je
    LEFT JOIN skills s ON s.name = je.value
  ),
  '[]'
);
