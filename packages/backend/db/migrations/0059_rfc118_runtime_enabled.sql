-- RFC-118 — runtime enable/disable toggle (additive, hand-written; registered in
-- meta/_journal.json). `runtimes.enabled` lets an admin disable a runtime
-- (including the built-in opencode / claude-code) so it drops out of the agent /
-- default-runtime pickers while STAYING in the list — RFC-118 is a reversible
-- DISABLE, not deletion. Default 1 (enabled) backfills every existing row → zero
-- behavior change. The effective-default runtime (`config.defaultRuntime ?? opencode`)
-- cannot be disabled (service guard, D3). `resolveRuntimeByName` IGNORES this flag
-- (D4) so an in-flight agent that already pins a now-disabled runtime keeps
-- dispatching; disabling only removes it from new selections.
ALTER TABLE `runtimes` ADD COLUMN `enabled` integer DEFAULT 1 NOT NULL;
