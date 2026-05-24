-- RFC-061 PR-B T10 — DROP the 7 legacy execution-model tables.
--
-- After this migration, the daemon's only source of execution truth is
-- the events table + its 4 projections (logical_runs / attempts /
-- node_outputs / suspensions) introduced in 0033_rfc061_events_projections.
--
-- All legacy services (scheduler.ts, clarify.ts, crossClarify.ts,
-- clarifyRounds.ts, clarifyFallback.ts, review.ts, lifecycle.ts,
-- exitCondition.ts, wrapperProgress.ts, runner.ts) are deleted in the
-- same PR-B T10 commit; nothing in src/ references these tables anymore.
--
-- DROP order respects foreign-key dependencies (children first).
DROP TABLE IF EXISTS clarify_rounds;
DROP TABLE IF EXISTS clarify_sessions;
DROP TABLE IF EXISTS cross_clarify_sessions;
DROP TABLE IF EXISTS doc_versions;
DROP TABLE IF EXISTS node_run_outputs;
DROP TABLE IF EXISTS node_run_events;
DROP TABLE IF EXISTS node_runs;
