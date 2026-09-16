import type { DbClient } from '@/db/client'
import type {
  AgentRouteTaskLaunchOperations,
  WorkgroupRouteTaskLaunchOperations,
} from '../public/commands'
import {
  createAgentRouteLaunch,
  type AgentRouteLaunchDependencies,
} from './postgresqlTaskRouteLaunchOperations'
import {
  createPostgresqlTaskRouteWorkspaceParticipant,
  type PostgresqlTaskRouteWorkspaceDependencies,
} from './postgresqlTaskRouteWorkspaceParticipant'
import { startExecution, type StartExecutionDeps } from '@/services/execution/executor'
import { resolveUploadLimits } from '@/services/launchMultipart'
import { assertCanReplaySourceTask } from '@/services/taskCollab'

export interface SqliteTaskRouteLaunchDependencies extends Omit<
  AgentRouteLaunchDependencies,
  'db' | 'workspace'
> {
  readonly db: DbClient
  /**
   * 与 PostgreSQL 那一支同形（`providerRuntime.ts` 的 `routeWorkspace`）：装配方交
   * **物化输入**，参与者由模块自己造。组合根因此不必深挖 `infrastructure/`
   * ——RFC-331 的分层判据会逐条抓出那种 deep import（本刀实撞过一次）。
   */
  readonly routeWorkspace: Omit<PostgresqlTaskRouteWorkspaceDependencies, 'db'>
  /**
   * Actor-scoped launch dependencies. A single frozen `StartExecutionDeps`
   * cannot serve this seam: `StartTaskDeps.actorUserId` is what `startTask`
   * writes into `tasks.owner_user_id` (and what RFC-320 reads for the creator's
   * Git identity), so a bootstrap-frozen `SYSTEM_USER_ID` silently made every
   * REST agent/workgroup launch ownerless — the launcher then failed their own
   * `GET /api/tasks/:id` (`task-not-found`) and could not add collaborators.
   * The bootstrap owns composition; only the actor id varies per request, the
   * same shape `trigger.executionFor` already uses.
   */
  readonly executionFor: (
    actor: Parameters<AgentRouteTaskLaunchOperations['launch']>[0],
  ) => StartExecutionDeps
}

export function createSqliteTaskRouteLaunchOperations(
  input: SqliteTaskRouteLaunchDependencies,
): Readonly<{
  agent: AgentRouteTaskLaunchOperations
  workgroup: WorkgroupRouteTaskLaunchOperations
}> {
  const launchAgent = createAgentRouteLaunch({
    ...input,
    workspace: createPostgresqlTaskRouteWorkspaceParticipant({
      db: input.db,
      ...input.routeWorkspace,
    }),
  })
  const assertReplayVisible = async (
    actor: Parameters<AgentRouteTaskLaunchOperations['assertReplayVisible']>[0],
    sourceTaskId: string,
  ): Promise<void> => {
    await assertCanReplaySourceTask(input.db, actor, sourceTaskId)
  }
  return Object.freeze({
    agent: Object.freeze({
      uploadLimits: () => resolveUploadLimits(input.configPath),
      assertReplayVisible,
      // RFC-359 AC-1（plan §5hn 批次一）：单代理启动改走**与 PostgreSQL 同一份**编排
      // （`createAgentRouteLaunch`，终端是根启动内核）。此前这里转
      // `startExecution` → `startAgentTask` → `startTask`，是同一件事的第二份写法。
      // 等价性由 `rfc359-w5hn-agent-launch-provider-parity` 的 26 条断言作证（含带上传那一支）。
      async launch(
        actor: Parameters<AgentRouteTaskLaunchOperations['launch']>[0],
        command: Parameters<AgentRouteTaskLaunchOperations['launch']>[1],
      ) {
        return await launchAgent({
          actor,
          command,
          invoker: {
            type: 'user',
            launchKind: command.uploads === undefined ? 'direct-json' : 'direct-multipart',
          },
          resources: input.resourceAuthorityFor(actor),
        })
      },
    }),
    workgroup: Object.freeze({
      assertReplayVisible,
      async launch(
        actor: Parameters<WorkgroupRouteTaskLaunchOperations['launch']>[0],
        command: Parameters<WorkgroupRouteTaskLaunchOperations['launch']>[1],
      ) {
        return await startExecution(
          input.db,
          actor,
          {
            kind: 'workgroup',
            refId: command.workgroupId,
            invoker: { type: 'user', launchKind: 'direct-json' },
            payload: command.payload,
          },
          input.executionFor(actor),
        )
      },
    }),
  })
}
