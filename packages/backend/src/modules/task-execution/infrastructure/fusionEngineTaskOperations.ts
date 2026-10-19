import type {
  FusionEngineTaskLaunch,
  FusionEngineTaskOperations,
} from '@/modules/knowledge-evolution/public/participants'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import type { DbClient } from '@/db/client'
import { composeTaskCancellation } from '../composition/taskCancellation'
import { getTask, startTask, type StartTaskDeps } from '@/services/task'
import type { SchedulerDriverPort } from '../application/ports/taskExecutionTopology'
import { launchInFusionWorkspace, releaseFusionWorkspace } from './fusionWorkspaceLaunch'

export function createSqliteFusionEngineTaskOperations(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly schedulerDriver: SchedulerDriverPort
  /** RFC-370 §10 V20: the selected engine workspace (standalone: under the app home). */
  readonly workspaces: FusionWorkspaceEffects
  readonly startDeps?: Omit<StartTaskDeps, 'db' | 'appHome' | 'schedulerDriver'>
}): FusionEngineTaskOperations {
  async function loadTask(taskId: string) {
    const task = await getTask(input.db, taskId)
    return task === null
      ? null
      : {
          status: task.status,
          errorSummary: task.errorSummary ?? null,
          worktreePath: task.worktreePath,
          baseCommit: task.baseCommit ?? null,
        }
  }
  return Object.freeze({
    async launch(command: FusionEngineTaskLaunch) {
      await launchInFusionWorkspace({
        workspaces: input.workspaces,
        request: {
          fusionId: command.fusionId,
          iteration: command.iteration,
          taskId: command.taskId,
          base: command.seed.base,
          overlay: command.seed.overlay,
        },
        admitted: async () => (await getTask(input.db, command.taskId)) !== null,
        launch: async (workspace) => {
          await startTask(
            {
              workflowId: command.workflowId,
              name: command.name,
              inputs: { ...command.inputs },
              ...(command.collaboratorUserIds === undefined
                ? {}
                : { collaboratorUserIds: [...command.collaboratorUserIds] }),
            },
            {
              ...(input.startDeps ?? {}),
              db: input.db,
              appHome: input.appHome,
              schedulerDriver: input.schedulerDriver,
              actorUserId: command.ownerUserId,
              launchProvenance: { kind: 'fusion', initiator: command.initiator },
              preCreatedWorktree: {
                taskId: command.taskId,
                worktreePath: workspace.worktreePath,
                branch: 'fusion',
                baseCommit: workspace.baseCommit,
                cleanup: { kind: 'owned-root', path: workspace.worktreePath },
              },
              internalSource: {
                kind: 'local-path',
                repoPath: workspace.worktreePath,
                baseBranch: 'fusion',
              },
              platformInputPaths: [...command.platformInputPaths],
              ...(command.binaryOverride === undefined
                ? {}
                : { binaryOverride: [...command.binaryOverride] }),
              ...(command.configPath === undefined ? {} : { configPath: command.configPath }),
              ...(command.awaitScheduler === undefined
                ? {}
                : { awaitScheduler: command.awaitScheduler }),
              ...(command.defaultPerNodeTimeoutMs === undefined
                ? {}
                : { defaultPerNodeTimeoutMs: command.defaultPerNodeTimeoutMs }),
              ...(command.defaultNodeRetries === undefined
                ? {}
                : { defaultNodeRetries: command.defaultNodeRetries }),
              ...(command.sessionRestartBudget === undefined
                ? {}
                : { sessionRestartBudget: command.sessionRestartBudget }),
              ...(command.defaultRuntime === undefined
                ? {}
                : { defaultRuntime: command.defaultRuntime }),
              ...(input.startDeps?.launchConfiguration === undefined
                ? {}
                : {
                    launchConfigurationOverrides: {
                      ...(command.defaultPerNodeTimeoutMs === undefined
                        ? {}
                        : { defaultPerNodeTimeoutMs: command.defaultPerNodeTimeoutMs }),
                      ...(command.defaultNodeRetries === undefined
                        ? {}
                        : { defaultNodeRetries: command.defaultNodeRetries }),
                      ...(command.sessionRestartBudget === undefined
                        ? {}
                        : { sessionRestartBudget: command.sessionRestartBudget }),
                      ...(command.defaultRuntime === undefined
                        ? {}
                        : { defaultRuntime: command.defaultRuntime }),
                    },
                  }),
            },
          )
        },
      })
    },
    load: loadTask,
    async collect(taskId: string) {
      const task = await loadTask(taskId)
      if (task === null) return null
      if (task.baseCommit === null) throw new Error('fusion engine task has no baseline commit')
      return await input.workspaces.collect({
        taskId,
        worktreePath: task.worktreePath,
        baseCommit: task.baseCommit,
      })
    },
    async release(taskId: string) {
      const task = await loadTask(taskId)
      await releaseFusionWorkspace(
        input.workspaces,
        task === null ? null : { taskId, worktreePath: task.worktreePath },
      )
    },
    async cancel(taskId: string) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const task = await getTask(input.db, taskId)
        if (
          task === null ||
          task.status === 'done' ||
          task.status === 'failed' ||
          task.status === 'canceled' ||
          task.status === 'interrupted'
        ) {
          return
        }
        await composeTaskCancellation(input.db)
          .cancel(taskId)
          .catch(() => undefined)
      }
    },
  } satisfies FusionEngineTaskOperations)
}
