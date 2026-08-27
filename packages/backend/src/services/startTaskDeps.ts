// RFC-159 — assemble StartTaskDeps from LIVE config, per-call.
//
// Extracted from routes/tasks.ts so the scheduled-task scheduler builds deps the
// SAME way the HTTP launch does — reading config on every fire/request (not frozen
// at daemon boot), so scheduled launches don't drift from manual ones after a config
// edit (design.md finding 4). `db` is a required dep (not derivable from configPath),
// so it is an explicit parameter (design.md R2-e).
import { loadConfig } from '@/config'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { cancelTask, isTaskActive, resumeTask, type StartTaskDeps } from '@/services/task'
import { runTaskWithTopology, type RunTaskOptions } from '@/services/scheduler'
import { createTaskExecutionReadModels } from '@/modules/task-execution/public/queries'
import {
  createTaskStatusPublisher,
  type SchedulerDriverPort,
  type SchedulerRuntimeTopology,
} from '@/modules/task-execution/public/topology'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'

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
 * RFC-331 DEV-1 compatibility adapter. It is deliberately stateless and lives
 * in the existing launch composition seam; task.ts and scheduler.ts never
 * import it back.
 */
export function createLegacyTaskExecutionTopology(
  db: DbClient,
  repositoryPublicationTransport?: RepositoryPublicationTransport,
): SchedulerRuntimeTopology {
  const readModels = createTaskExecutionReadModels(db)
  const schedulerDriver: SchedulerDriverPort = {
    async kick(request) {
      await runTaskWithTopology(
        {
          ...request,
          db,
          ...(repositoryPublicationTransport === undefined
            ? {}
            : { repositoryPublicationTransport }),
        } as RunTaskOptions,
        topology,
      )
    },
    async cancelChild(input) {
      await cancelTask(db, input.taskId, { cascadeFromParent: input.cascadeFromParent })
    },
    async resumeChild(input) {
      await resumeTask(db, input.taskId, {
        db,
        schedulerDriver,
        ...(input.runtime.triggerContext === undefined
          ? {}
          : { triggerContext: input.runtime.triggerContext }),
        ...(input.runtime.actorUserId === undefined
          ? {}
          : { actorUserId: input.runtime.actorUserId }),
        ...input.runtime.runConfig,
      })
    },
    isTaskActive,
  }
  const topology: SchedulerRuntimeTopology = {
    schedulerDriver,
    taskStatusReadModel: readModels.statusProjection,
    taskStatusPublisher: createTaskStatusPublisher(),
  }
  return topology
}

/**
 * Build the common StartTaskDeps for a launch. Byte-equivalent to the inline object
 * the JSON launch used (routes/tasks.ts:249-256). Callers with extra deps
 * (multipart's `preCreatedWorktree` / `preResolvedSource`) spread them on top.
 */
export function buildStartTaskDeps(
  db: DbClient,
  configPath: string,
  actorUserId: string,
  /** RFC-204: needed to unseal a cached repo for a reuse-by-id launch. */
  secretBox?: SecretBox,
  /** RFC-321: bootstrap transport keeps provider API discovery ahead of URL-rule fallback. */
  repositoryPublicationTransport?: RepositoryPublicationTransport,
): StartTaskDeps {
  const subagentLiveCapture = resolveSubagentLiveCapture(configPath)
  const topology = createLegacyTaskExecutionTopology(db, repositoryPublicationTransport)
  return {
    db,
    schedulerDriver: topology.schedulerDriver,
    actorUserId,
    ...(secretBox !== undefined ? { secretBox } : {}),
    // RFC-282 C1-2: the scheduler resolves config.opencodePath itself.
    configPath,
    ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
    // RFC-103 T2: commit&push + maxConcurrentNodes + per-node timeout floor.
    ...resolveLaunchRuntimeConfig(configPath),
  }
}
