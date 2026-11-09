// RFC-359 W1-T3（F-H2-2）—— 数字员工 action 执行器的两个 provider 装配面。
//
// 中立实现在 `actionExecutionRunners.ts`；这里提供它注入的两件能力——「在借用工作区上启动宿主任务」
// 与「取消宿主任务」——以及读模型 / agent 查询。
//
// RFC-359 AC-1（plan §5hi）：**两份合成一份**。此前 SQLite 那份走 `startTask` + `preCreatedWorktree`，
// PostgreSQL 那份走启动内核 + `borrowedPostgresqlWorkspace` 租约。合并取内核那半——
// 它在**两个引擎上都真跑过**（`rfc359-w5-kernel-launch-provider-parity`，plan §5hh），
// 而 `startTask` 那条按定义只服务 SQLite。

import type { Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { RootTaskLaunchKernel } from '../infrastructure/taskRouteLaunchOperations'
import { launchActionHostTask } from '../infrastructure/hostTaskLaunch'
import type { TaskExecutionReadModels } from '../public/types'
import type {
  ActionExecutionEnvironment,
  ActionHostTaskLaunch,
} from '../application/ports/actionExecution'
// RFC-415: the deployment profile selects a workspace's entry check through this composition export.
export type { ActionWorkspaceEntries } from '../application/ports/actionExecution'
import { localActionWorkspaceEntries } from '../infrastructure/local/localActionWorkspaceEntries'

/** RFC-431: the standalone selection checks entries below a host action workspace. */
export { localActionWorkspaceEntries }
import { readTaskStatus } from '../infrastructure/taskExecutionTaskReads'
import { watchTaskTerminal } from '../infrastructure/executionWatch'
import { getExecutionOutcome } from '../infrastructure/executionOutcome'

export interface ActionExecutionEnvironmentDependencies {
  readonly db: PersistenceDb
  /**
   * **惰性**取 actor：只有 `launchHostTask` 用得到它，而 SQLite 侧的组合根
   * （`server.ts` 的 `composeFallbackDevelopmentAutomation`）是**同步**函数，
   * 取不到 `await admitDaemonIdentity(...)`。惰性是两侧都成立的那半。
   */
  readonly resolveActor: () => Promise<Actor>
  readonly resourceAuthorityFor: (
    actor: Actor,
  ) => Parameters<RootTaskLaunchKernel['launch']>[0]['resourceAuthority']
  readonly launch: RootTaskLaunchKernel
  readonly cancelTask: (taskId: string) => Promise<unknown>
  readonly readModels: Pick<TaskExecutionReadModels, 'executionOutcome' | 'statusProjection'>
  readonly agents: ActionExecutionEnvironment['agents']
  /**
   * 终态回调，同步 / 异步都可以：唯一的消费者 `watchTerminal` 用 `.then(() => notify(ref))`
   * 接它，两种都会被等到。**这里的 `void |` 不是 dev-gotchas 警告的那种放宽**——那条说的是
   * 「产出方的 Promise 被调用方合法丢掉」；此处调用方显式串进了 promise 链。
   */
  readonly onTerminal?: (executionRef: string) => void | Promise<void>
  readonly terminalPollMs?: number
  /** RFC-370 §10 V18: the selected workspace's entry checks (hosted volumes);
   * a standalone daemon checks its own filesystem. */
  readonly workspaceEntries?: ActionExecutionEnvironment['workspaceEntries']
}

export function createActionExecutionEnvironment(
  deps: ActionExecutionEnvironmentDependencies,
): ActionExecutionEnvironment {
  return Object.freeze({
    db: deps.db,
    agents: deps.agents,
    outcomes: deps.readModels.executionOutcome,
    statusProjection: deps.readModels.statusProjection,
    // RFC-419: the launch request mapping and the borrowed workspace are the infrastructure launch adapter.
    launchHostTask: (input: ActionHostTaskLaunch) => launchActionHostTask(deps, input),
    async cancelHostTask(executionRef: string) {
      await deps.cancelTask(executionRef)
    },
    ...(deps.onTerminal === undefined ? {} : { onTerminal: deps.onTerminal }),
    ...(deps.terminalPollMs === undefined ? {} : { terminalPollMs: deps.terminalPollMs }),
    // RFC-415: the runners read the task status and check workspace entries through these two ports; a standalone
    // daemon checks its own filesystem unless the deployment selected its workspace implementation's entries.
    workspaceEntries: deps.workspaceEntries ?? localActionWorkspaceEntries,
    taskStatus: (executionRef: string) => readTaskStatus(deps.db, executionRef),
    executionOutcome: (executionRef: string) =>
      getExecutionOutcome(deps.readModels.executionOutcome, executionRef),
    awaitTerminal: (executionRef: string, pollMs: number) =>
      watchTaskTerminal(deps.readModels.statusProjection, executionRef, { pollMs }),
  })
}
