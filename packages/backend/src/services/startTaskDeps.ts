// RFC-159 — assemble StartTaskDeps from LIVE config, per-call.
//
// Extracted from routes/tasks.ts so the scheduled-task scheduler builds deps the
// SAME way the HTTP launch does — reading config on every fire/request (not frozen
// at daemon boot), so scheduled launches don't drift from manual ones after a config
// edit (design.md finding 4). `db` is a required dep (not derivable from configPath),
// so it is an explicit parameter (design.md R2-e).
import { loadConfig } from '@/config'
import type { SecretBox } from '@/auth/secretBox'
import type { LegacySqliteTaskDatabase } from '@/modules/task-execution/infrastructure/legacySqliteTaskDatabase'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import type { StartTaskDeps } from '@/services/task'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import { composeSqliteRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { createSqliteRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations'

/**
 * RFC-048 — subagent live-capture cadence from live config (moved verbatim from
 * routes/tasks.ts so route + scheduler share one resolution). Missing config or a
 * read error → undefined (runner falls back to its compile-time defaults).
 */
export function resolveSubagentLiveCapture(
  configPath: string,
): { pollMs: number; consecutiveFailureLimit: number } | undefined {
  try {
    const cfg = loadConfig(configPath)
    return cfg.subagentLiveCapture
  } catch {
    return undefined
  }
}

/**
 * Build the common StartTaskDeps for a launch. Byte-equivalent to the inline object
 * the JSON launch used (routes/tasks.ts:249-256). Callers with extra deps
 * (multipart's `preCreatedWorktree` / `preResolvedSource`) spread them on top.
 */
export function buildStartTaskDeps(
  db: LegacySqliteTaskDatabase,
  schedulerDriver: SchedulerDriverPort,
  configPath: string,
  actorUserId: string,
  /** RFC-204: needed to unseal a cached repo for a reuse-by-id launch. */
  secretBox?: SecretBox,
  /** RFC-347: daemon/bootstrap-owned identity query; omitted only by legacy tests. */
  identityAccess?: StartTaskDeps['identityAccess'],
): StartTaskDeps {
  const subagentLiveCapture = resolveSubagentLiveCapture(configPath)
  return {
    db,
    schedulerDriver,
    repositoryWorkspace: composeSqliteRepositoryWorkspaceStore(db),
    runtimeSessionLeases: createSqliteRuntimeSessionLeaseOperations(db),
    actorUserId,
    ...(identityAccess === undefined ? {} : { identityAccess }),
    ...(secretBox !== undefined ? { secretBox } : {}),
    // RFC-282 C1-2: the scheduler resolves config.opencodePath itself.
    configPath,
    ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
    // RFC-103 T2: commit&push + maxConcurrentNodes + per-node timeout floor.
    ...resolveLaunchRuntimeConfig(configPath),
  }
}
