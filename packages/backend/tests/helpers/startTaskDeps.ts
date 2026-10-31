import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
// RFC-395 II-pre：改接生产启动 / 读取路径，保留原断言意图。
// RFC-387: test-only legacy launch configuration fixture; production uses the daemon session bundle.
// RFC-159 — assemble TestTaskLaunchOptions from LIVE config, per-call.
//
// Extracted from routes/tasks.ts so the scheduled-task scheduler builds deps the
// SAME way the HTTP launch does — reading config on every fire/request (not frozen
// at daemon boot), so scheduled launches don't drift from manual ones after a config
// edit (design.md finding 4). `db` is a required dep (not derivable from configPath),
// so it is an explicit parameter (design.md R2-e).
import { createFileTaskLaunchConfigurationQueries } from '@/modules/task-execution/composition/launchConfiguration'
import { resolveTaskSubagentLiveCaptureFromReader } from '@/modules/task-execution/public/queries'
import type { SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { resolveLaunchRuntimeConfig } from './launchRuntimeConfig'
import type { TestTaskLaunchOptions } from './productionTaskLaunch'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import { composeSqliteRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/composition/taskExecutionPersistence'

/**
 * RFC-048 — subagent live-capture cadence from live config (moved verbatim from
 * routes/tasks.ts so route + scheduler share one resolution). Missing config or a
 * read error → undefined (runner falls back to its compile-time defaults).
 */
export function resolveSubagentLiveCapture(
  configPath: string,
): { pollMs: number; consecutiveFailureLimit: number } | undefined {
  return resolveTaskSubagentLiveCaptureFromReader(
    createFileTaskLaunchConfigurationQueries(configPath).read,
  )
}

/**
 * Build the common TestTaskLaunchOptions for a launch. Byte-equivalent to the inline object
 * the JSON launch used (routes/tasks.ts:249-256). Callers with extra deps
 * (multipart's `preCreatedWorktree` / `preResolvedSource`) spread them on top.
 */
export function buildStartTaskDeps(
  db: PersistenceDb,
  humanGateOpen: TestTaskLaunchOptions['humanGateOpen'],
  schedulerDriver: SchedulerDriverPort,
  configPath: string,
  actorUserId: string,
  /** RFC-204: needed to unseal a cached repo for a reuse-by-id launch. */
  secretBox?: SecretBox,
  /** RFC-347: daemon/bootstrap-owned identity query; omitted only by legacy tests. */
  identityAccess?: TestTaskLaunchOptions['identityAccess'],
  moduleMembers?: Pick<TestTaskLaunchOptions, 'repositoryWorkspace' | 'runtimeSessionLeases'>,
): TestTaskLaunchOptions {
  const subagentLiveCapture = resolveSubagentLiveCapture(configPath)
  return {
    humanGateOpen,
    db,
    schedulerDriver,
    repositoryWorkspace:
      moduleMembers?.repositoryWorkspace ??
      composeSqliteRepositoryWorkspaceStore(db, composeSourceControlTaskPorts(db)),
    runtimeSessionLeases:
      moduleMembers?.runtimeSessionLeases ?? createRuntimeSessionLeaseOperations(db),
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
