// RFC-103 T2 + RFC-108 T4 — single source for launch-time runtime config.
//
// Resolves the settings that must be threaded into `StartTaskDeps` for EVERY
// scheduler-kicking entry point (JSON start / multipart start / resume / retry /
// repair-resume / parked clarify+review resume / fusion). Before this lived in
// routes/tasks.ts and only the task routes used it, so other production kicks
// (fusion, parked clarify/review resume) ran nodes with no commit&push, no
// concurrency cap, and — pre-RFC-108 — no hard-timeout floor (Codex impl gate
// P2). Hoisting it here lets all routes share one resolver.

import { createFileTaskLaunchConfigurationQueries } from '@/modules/task-execution/composition/launchConfiguration'
import {
  resolveTaskCommitPushFromReader,
  resolveTaskLaunchRuntimeFromReader,
} from '@/modules/task-execution/public/queries'

export function resolveCommitPushConfig(configPath: string) {
  return resolveTaskCommitPushFromReader(createFileTaskLaunchConfigurationQueries(configPath).read)
}

export function resolveLaunchRuntimeConfig(configPath: string) {
  return resolveTaskLaunchRuntimeFromReader(
    createFileTaskLaunchConfigurationQueries(configPath).read,
  )
}
