-- RFC-310: immutable, task-owned roster of platform input mounts.
--
-- Requirement and pipeline evidence live below `.agent-workflow/` and are
-- deliberately Git-ignored. Agent nodes run in isolated worktrees, so internal
-- launches freeze the exact mount roots here and the isolation layer force-adds
-- them to every full-state snapshot. NULL means the task owns no such inputs.
-- This column is not part of the public Task DTO or StartTask wire body.
ALTER TABLE `tasks` ADD `platform_input_paths_json` text;
