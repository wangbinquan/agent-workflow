// RFC-359 W1-T3（F-H2-2）—— 数字员工 action 执行器的两个 provider 装配面。
//
// 中立实现在 `actionExecutionRunners.ts`；这里只提供它注入的两件 provider 私有能力——
// 「在借用工作区上启动宿主任务」与「取消宿主任务」——以及各自的读模型 / agent 查询。

import { WorkflowDefinitionSchema, type StartTask } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { cancelTask, startTask, type StartTaskDeps } from '@/services/task'
import { DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID } from '../domain/digitalEmployeeHost'
import { createTaskExecutionReadModels } from '../infrastructure/taskExecutionReadModels'
import type {
  PostgresqlRootTaskLaunchKernel,
  PostgresqlTaskRoutePreparedWorkspace,
  PostgresqlTaskRouteWorkspaceParticipant,
} from '../infrastructure/postgresqlTaskRouteLaunchOperations'
import type { TaskExecutionReadModels } from '../public/types'
import type { ActionExecutionEnvironment, ActionHostTaskLaunch } from './actionExecutionRunners'

/**
 * 借用工作区的 PostgreSQL 租约：目录属于调用方（development-automation / 数字员工），任务只借用它，
 * 回滚只释放租约，物理清理仍由物化它的一方负责。
 */
export function borrowedPostgresqlWorkspace(input: {
  readonly workspacePath: string
  readonly baselineSha: string
}): PostgresqlTaskRouteWorkspaceParticipant {
  return Object.freeze({
    async prepare(
      request: Parameters<PostgresqlTaskRouteWorkspaceParticipant['prepare']>[0],
    ): Promise<PostgresqlTaskRoutePreparedWorkspace> {
      let state: 'open' | 'committed' | 'rolled-back' = 'open'
      return Object.freeze({
        taskId: request.taskId,
        kind: 'single',
        spaceKind: 'local',
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

export interface SqliteActionExecutionEnvironmentDependencies {
  readonly db: DbClient
  /** 生产 = cli 的 buildStartTaskDeps 产物；测试注入 binaryOverride/awaitScheduler。 */
  readonly startDeps: StartTaskDeps
  /** agent 资源查询，由 bootstrap 注入（与 PostgreSQL 侧同形，本模块不 import resource-catalog 内部）。 */
  readonly agents: ActionExecutionEnvironment['agents']
  /** attempt 终态通知（DA 侧据此记 wake hint）；daemon 内 watcher 轮询驱动。 */
  readonly onTerminal?: (executionRef: string) => void
  /** watcher 轮询间隔（测试提速用）。 */
  readonly terminalPollMs?: number
}

export function createSqliteActionExecutionEnvironment(
  deps: SqliteActionExecutionEnvironmentDependencies,
): ActionExecutionEnvironment {
  const readModels = createTaskExecutionReadModels(deps.db)
  return Object.freeze({
    db: deps.db,
    agents: deps.agents,
    outcomes: readModels.executionOutcome,
    statusProjection: readModels.statusProjection,
    async launchHostTask(input: ActionHostTaskLaunch) {
      const startInput: StartTask = {
        workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
        name: input.name,
        inputs: { ...input.inputs },
        ...(input.wallTimeMs === null ? {} : { maxDurationMs: input.wallTimeMs }),
      }
      const task = await startTask(startInput, {
        ...deps.startDeps,
        catalogVisibility: 'internal',
        digitalEmployeeLaunch: {
          actionRunId: input.actionRunId,
          snapshotJson: JSON.stringify(input.snapshot),
        },
        internalSource: {
          kind: 'local-path',
          repoPath: input.workspacePath,
          baseBranch: input.baselineSha,
        },
        platformInputPaths: input.platformInputPaths,
        preCreatedWorktree: {
          taskId: input.taskId,
          worktreePath: input.workspacePath,
          branch: '',
          baseCommit: input.baselineSha,
          cleanup: { kind: 'borrowed' },
        },
        ...(deps.startDeps.launchProvenance === undefined && deps.startDeps.callLaunch === undefined
          ? { launchProvenance: { kind: 'direct-json' as const, initiator: 'api' as const } }
          : {}),
      })
      return task.id
    },
    async cancelHostTask(executionRef: string) {
      await cancelTask(deps.db, executionRef)
    },
    ...(deps.onTerminal === undefined ? {} : { onTerminal: deps.onTerminal }),
    ...(deps.terminalPollMs === undefined ? {} : { terminalPollMs: deps.terminalPollMs }),
  })
}

export interface PostgresqlActionExecutionEnvironmentDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly actor: Actor
  readonly resourceAuthorityFor: (
    actor: Actor,
  ) => Parameters<PostgresqlRootTaskLaunchKernel['launch']>[0]['resourceAuthority']
  readonly launch: PostgresqlRootTaskLaunchKernel
  readonly cancelTask: (taskId: string) => Promise<unknown>
  readonly readModels: Pick<TaskExecutionReadModels, 'executionOutcome' | 'statusProjection'>
  readonly agents: ActionExecutionEnvironment['agents']
  readonly onTerminal?: (executionRef: string) => void
  readonly terminalPollMs?: number
}

export function createPostgresqlActionExecutionEnvironment(
  deps: PostgresqlActionExecutionEnvironmentDependencies,
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
      const launched = await deps.launch.launch({
        actor: deps.actor,
        resourceAuthority: deps.resourceAuthorityFor(deps.actor),
        invoker: { type: 'user', launchKind: 'direct-json' },
        task,
        subject: {
          workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
          workflowName: '__digital_employee_host__',
          workflowVersion: 1,
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
