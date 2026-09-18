// RFC-359 W1-T3（F-H2-2）—— 数字员工 action 执行器的两个 provider 装配面。
//
// 中立实现在 `actionExecutionRunners.ts`；这里提供它注入的两件能力——「在借用工作区上启动宿主任务」
// 与「取消宿主任务」——以及读模型 / agent 查询。
//
// RFC-359 AC-1（plan §5hi）：**两份合成一份**。此前 SQLite 那份走 `startTask` + `preCreatedWorktree`，
// PostgreSQL 那份走启动内核 + `borrowedPostgresqlWorkspace` 租约。合并取内核那半——
// 它在**两个引擎上都真跑过**（`rfc359-w5-kernel-launch-provider-parity`，plan §5hh），
// 而 `startTask` 那条按定义只服务 SQLite。

import { WorkflowDefinitionSchema, type StartTask } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID } from '../domain/digitalEmployeeHost'
import type {
  RootTaskLaunchKernel,
  TaskRoutePreparedWorkspace,
  TaskRouteWorkspaceParticipant,
} from '../infrastructure/taskRouteLaunchOperations'
import type { TaskExecutionReadModels } from '../public/types'
import type { ActionExecutionEnvironment, ActionHostTaskLaunch } from './actionExecutionRunners'

/**
 * 借用工作区的 PostgreSQL 租约：目录属于调用方（development-automation / 数字员工），任务只借用它，
 * 回滚只释放租约，物理清理仍由物化它的一方负责。
 */
export function borrowedPostgresqlWorkspace(input: {
  readonly workspacePath: string
  readonly baselineSha: string
}): TaskRouteWorkspaceParticipant {
  return Object.freeze({
    async prepare(
      request: Parameters<TaskRouteWorkspaceParticipant['prepare']>[0],
    ): Promise<TaskRoutePreparedWorkspace> {
      let state: 'open' | 'committed' | 'rolled-back' = 'open'
      return Object.freeze({
        taskId: request.taskId,
        kind: 'single',
        spaceKind: 'internal',
        repoPath: input.workspacePath,
        repoUrl: null,
        cachedRepoId: null,
        repoGroupId: null,
        repoGroupName: null,
        worktreePath: input.workspacePath,
        baseBranch: input.baselineSha,
        branch: '',
        baseCommit: input.baselineSha,
        earlyError: null,
        repositories: [],
        nodePaths: [],
        commit() {
          if (state !== 'open') throw new Error(`borrowed-workspace-already-${state}`)
          state = 'committed'
        },
        async rollback() {
          if (state !== 'open') throw new Error(`borrowed-workspace-already-${state}`)
          state = 'rolled-back'
          return { taskId: request.taskId, complete: true, failures: [] }
        },
      })
    },
  })
}

export interface ActionExecutionEnvironmentDependencies {
  readonly db: ProviderNeutralDatabase
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
}

export function createActionExecutionEnvironment(
  deps: ActionExecutionEnvironmentDependencies,
): ActionExecutionEnvironment {
  return Object.freeze({
    db: deps.db,
    agents: deps.agents,
    outcomes: deps.readModels.executionOutcome,
    statusProjection: deps.readModels.statusProjection,
    async launchHostTask(input: ActionHostTaskLaunch) {
      const task: StartTask = {
        workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
        name: input.name,
        inputs: { ...input.inputs },
        ...(input.wallTimeMs === null ? {} : { maxDurationMs: input.wallTimeMs }),
      }
      const actor = await deps.resolveActor()
      const launched = await deps.launch.launch({
        actor,
        resourceAuthority: deps.resourceAuthorityFor(actor),
        invoker: { type: 'user', launchKind: 'direct-json' },
        task,
        subject: {
          workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
          workflowName: '__digital_employee_host__',
          workflowVersion: 1,
          // 平台自有的合成宿主：写时冻结规范排版（plan §5hn）。
          builtin: true,
          workflowSnapshot: WorkflowDefinitionSchema.parse(input.snapshot),
        },
        internal: {
          catalogVisibility: 'internal',
          digitalEmployeeLaunch: { actionRunId: input.actionRunId },
          platformInputPaths: input.platformInputPaths,
          workspace: borrowedPostgresqlWorkspace({
            workspacePath: input.workspacePath,
            baselineSha: input.baselineSha,
          }),
        },
      })
      return launched.id
    },
    async cancelHostTask(executionRef: string) {
      await deps.cancelTask(executionRef)
    },
    ...(deps.onTerminal === undefined ? {} : { onTerminal: deps.onTerminal }),
    ...(deps.terminalPollMs === undefined ? {} : { terminalPollMs: deps.terminalPollMs }),
  })
}
