import type {
  FusionEngineTaskLaunch,
  FusionEngineTaskOperations,
} from '@/modules/knowledge-evolution/public/participants'
import type { DbClient } from '@/db/client'
import { composeTaskCancellation } from '../composition/taskCancellation'
import { getTask, startTask, type StartTaskDeps } from '@/services/task'
import type { SchedulerDriverPort } from '../application/ports/taskExecutionTopology'
import { captureTaskDriveBinding, type TaskDriveBinding } from '../composition/taskDriveBinding'

export function createSqliteFusionEngineTaskOperations(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly schedulerDriver: SchedulerDriverPort
  readonly startDeps?: Omit<StartTaskDeps, 'db' | 'appHome' | 'schedulerDriver'>
  readonly driveBinding?: TaskDriveBinding
}): FusionEngineTaskOperations {
  const driveBinding = captureTaskDriveBinding(input.driveBinding ?? input.startDeps?.driveBinding)
  if (
    input.driveBinding !== undefined &&
    input.startDeps?.driveBinding !== undefined &&
    (input.driveBinding.executionModule !== input.startDeps.driveBinding.executionModule ||
      input.driveBinding.persistence !== input.startDeps.driveBinding.persistence ||
      input.driveBinding.driverLifecycle !== input.startDeps.driveBinding.driverLifecycle)
  )
    throw new Error('task-drive-binding-mismatch')
  return Object.freeze({
    async launch(command: FusionEngineTaskLaunch) {
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
          ...(driveBinding === undefined ? {} : { driveBinding }),
          db: input.db,
          appHome: input.appHome,
          schedulerDriver: input.schedulerDriver,
          actorUserId: command.ownerUserId,
          launchProvenance: { kind: 'fusion', initiator: command.initiator },
          preCreatedWorktree: {
            taskId: command.taskId,
            worktreePath: command.worktreePath,
            branch: 'fusion',
            baseCommit: command.baseCommit,
            cleanup: { kind: 'owned-root', path: command.worktreePath },
          },
          internalSource: {
            kind: 'local-path',
            repoPath: command.worktreePath,
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
    async load(taskId: string) {
      const task = await getTask(input.db, taskId)
      return task === null
        ? null
        : {
            status: task.status,
            errorSummary: task.errorSummary ?? null,
            worktreePath: task.worktreePath,
          }
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
        await (
          driveBinding === undefined
            ? composeTaskCancellation(input.db)
            : composeTaskCancellation(input.db, driveBinding)
        )
          .cancel(taskId)
          .catch(() => undefined)
      }
    },
  })
}
