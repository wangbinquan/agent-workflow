-- RFC-022: agent-level declaration of other agents this one transitively
-- requires at runtime. Closure (BFS over depends_on) gets injected into the
-- same opencode subprocess via OPENCODE_CONFIG_CONTENT, and every closure
-- member's `skills` are unioned and staged under OPENCODE_CONFIG_DIR/skills/.
--
-- Backfills existing rows with an empty array; legacy agents keep their
-- single-agent behavior until an author opts in by listing dependents.
ALTER TABLE `agents` ADD `depends_on` text DEFAULT '[]' NOT NULL;
