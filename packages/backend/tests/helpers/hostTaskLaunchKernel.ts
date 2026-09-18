// RFC-359 AC-1（plan §5hi）—— 测试侧的「宿主任务启动内核」装配，和生产同形。
//
// 生产两个 SQLite 组合根（`cli/start.ts` 的 `composeSqliteProviderSession`、
// `server.ts` 的 `composeFallbackDevelopmentAutomation`）都用
// 启动内核 + `createTaskDriveCoordinator` 驱动数字员工的宿主任务；PG 侧用的是
// 同一个内核（`providerRuntime.ts` 的 `routeLaunch.workflow`）。测试要证的是
// 这条链在 SQLite 上真的跑得动，所以这里复刻生产的装配，而不是另造一份桩。
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  TaskDriveCompletionMode,
  TaskDriveCoordinator,
} from '@/modules/task-execution/application/drive/taskDriveTypes'
import {
  composeHostTaskLaunchKernel,
  type HostTaskLaunchKernelDependencies,
} from '@/modules/task-execution/composition/hostTaskLaunch'
import type { RootTaskLaunchKernel } from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import { createTaskDriveCoordinator, type TaskDriveCoordinatorDependencies } from '@/services/task'

export function createTestHostTaskLaunchKernel(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly gitCommitIdentity: HostTaskLaunchKernelDependencies['gitCommitIdentity']
  readonly coordinatorDeps: TaskDriveCoordinatorDependencies
  readonly persistence: Pick<TaskExecutionPersistence, 'runtimeLifecycle'>
  readonly completionMode: TaskDriveCompletionMode
}): RootTaskLaunchKernel {
  const drive = createTaskDriveCoordinator({
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
  // 走的是生产那一个装配入口（两个 SQLite 组合根用的也是它），
  // 所以「测试装出来的内核」与「生产装出来的内核」按构造就是同一台。
  return composeHostTaskLaunchKernel({
    db: input.db,
    appHome: input.appHome,
    gitCommitIdentity: input.gitCommitIdentity,
    coordinator,
  })
}
