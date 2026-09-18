// RFC-359 AC-1（plan §5hi）—— 宿主任务启动内核的**组合入口**。
//
// 数字员工的动作执行（agent / script）在三个组合根上装配：PostgreSQL daemon
// （`cli/postgresqlDaemonApplication.ts`）、SQLite daemon（`cli/start.ts`）与
// 嵌入式回退（`server.ts` 的 `composeFallbackDevelopmentAutomation`）。三者用的是
// **同一个**启动内核——此前只有 PG 走内核、SQLite 走 `startTask` + `preCreatedWorktree`，
// 那是 AC-1 要消掉的同文件 provider 孪生之一。
//
// PG daemon 从自己的 provider runtime 取内核（`routeLaunch.workflow`，
// `composition/providerRuntime.ts`）；另外两个根没有 provider runtime 可取，所以这里给出
// 模块自己的装配入口——组合根因此不必深挖 `infrastructure/`（RFC-331 的分层判据）。
import type { SecretBox } from '@/auth/secretBox'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskDriveCoordinator } from '../application/drive/taskDriveTypes'
import {
  createRootTaskLaunchKernel,
  type RootTaskLaunchDependencies,
  type RootTaskLaunchKernel,
} from '../infrastructure/taskRouteLaunchOperations'
import { createTaskRouteWorkspaceParticipant } from '../infrastructure/taskRouteWorkspaceParticipant'

export interface HostTaskLaunchKernelDependencies {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  /**
   * 解封 `cached_repos.url_enc` 用（按 id 复用仓库的启动路）。生产两个组合根都有；
   * 只走 scratch / 借用工作区的测试装配可以不给——底层参与者本来就把它声明成可选。
   */
  readonly secretBox?: SecretBox
  readonly gitCommitIdentity: RootTaskLaunchDependencies['gitCommitIdentity']
  readonly coordinator: TaskDriveCoordinator
}

export function composeHostTaskLaunchKernel(
  input: HostTaskLaunchKernelDependencies,
): RootTaskLaunchKernel {
  return createRootTaskLaunchKernel({
    db: input.db,
    gitCommitIdentity: input.gitCommitIdentity,
    workspace: createTaskRouteWorkspaceParticipant({
      db: input.db,
      appHome: input.appHome,
      ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
    }),
    coordinator: input.coordinator,
  })
}
