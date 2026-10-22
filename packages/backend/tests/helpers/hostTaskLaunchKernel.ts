// RFC-395 II-pre：改接生产启动 / 读取路径，保留原断言意图。
// RFC-359 AC-1（plan §5hi）—— 测试侧的「宿主任务启动内核」装配，和生产同形。
//
// RFC-382 后生产从会话模块组取得 routeLaunch.workflow；这份既有 fixture 保留
// 调用方指定的完成模式，仍驱动相同的根启动内核与工作区参与者。
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  TaskDriveCompletionMode,
  TaskDriveCoordinator,
} from '@/modules/task-execution/application/drive/taskDriveTypes'
import { createTaskRouteWorkspaceParticipant } from '@/modules/task-execution/infrastructure/taskRouteWorkspaceParticipant'
import {
  createRootTaskLaunchKernel,
  type RootTaskLaunchDependencies,
} from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import type { RootTaskLaunchKernel } from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import { createTestTaskDriveCoordinator } from './legacyTaskDrive'
import { type TaskDriveCoordinatorDependencies } from '@/services/task'

export function createTestHostTaskLaunchKernel(input: {
  readonly workspace?: RootTaskLaunchDependencies['workspace']
  readonly coordinator?: TaskDriveCoordinator
  readonly db: PersistenceDb
  readonly appHome: string
  readonly gitCommitIdentity: RootTaskLaunchDependencies['gitCommitIdentity']
  readonly coordinatorDeps: TaskDriveCoordinatorDependencies
  readonly persistence: Pick<TaskExecutionPersistence, 'runtimeLifecycle'>
  readonly completionMode: TaskDriveCompletionMode
}): RootTaskLaunchKernel {
  const drive = createTestTaskDriveCoordinator({
    deps: input.coordinatorDeps,
    appHome: input.appHome,
    engineFailureMessage: 'host task drive threw',
    failureReporter: {
      async report({ taskId, error, execution }) {
        const now = Date.now()
        await input.persistence.runtimeLifecycle.trySet({
          taskId,
          to: 'failed',
          allowedFrom: ['pending', 'running'],
          extra: {
            finishedAt: now,
            errorSummary: 'task drive failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          executionContext: execution,
          now,
          reason: 'task-drive',
        })
      },
    },
  })
  const coordinator: TaskDriveCoordinator = {
    submit: (request) => drive.submit({ ...request, completionMode: input.completionMode }),
  }
  // RFC-382: the session bundle supplies this primitive in production; this legacy
  // fixture retains its explicit completion mode without a test-only production wrapper.
  return createRootTaskLaunchKernel({
    db: input.db,
    gitCommitIdentity: input.gitCommitIdentity,
    coordinator: input.coordinator ?? coordinator,
    workspace:
      input.workspace ??
      createTaskRouteWorkspaceParticipant({
        db: input.db,
        appHome: input.appHome,
        sourceContexts: createIdentityAccessRuntime({ db: input.db }).taskPreparationContext,
        repositoryPreparation: composeRepositoryPreparation({
          db: input.db,
          appHome: input.appHome,
        }),
      }),
  })
}
