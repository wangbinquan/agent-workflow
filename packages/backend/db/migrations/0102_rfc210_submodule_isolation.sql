-- RFC-210: recursive submodule isolation.
--
-- cached_repos.last_auto_refresh_at — drives the periodic background refresh
-- loop's due-repo query (G7). NULL means "never auto-refreshed", which makes
-- every pre-existing row immediately eligible.
--
-- node_runs.iso_submodules_json / iso_submodules_repos_json — per-node submodule
-- topology captured at iso creation (base commit per submodule path, pool dir,
-- pending sub-resolves). Single/multi split mirrors the existing
-- iso_base_snapshot / iso_base_snapshot_repos_json pair: a multi-repo task has
-- one topology PER REPO, and folding them into one flat map would let two repos
-- that both contain e.g. `vendor` overwrite each other.
ALTER TABLE cached_repos ADD COLUMN last_auto_refresh_at INTEGER;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN iso_submodules_json TEXT;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN iso_submodules_repos_json TEXT;
