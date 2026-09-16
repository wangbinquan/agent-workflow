import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { TaskExecutionResourceAuthority } from '../application/ports/taskExecutionResourceSnapshots'
import type {
  AgentRouteTaskLaunchOperations,
  WorkgroupRouteTaskLaunchOperations,
} from '../public/commands'
import {
  createAgentRouteLaunch,
  createPostgresqlTaskExecutionLaunchParticipant,
  createWorkgroupRouteLaunch,
  type AgentRouteLaunchDependencies,
  type PostgresqlTaskExecutionLaunchParticipant,
  type WorkgroupRouteLaunchDependencies,
} from './postgresqlTaskRouteLaunchOperations'
import {
  createPostgresqlTaskRouteWorkspaceParticipant,
  type PostgresqlTaskRouteWorkspaceDependencies,
} from './postgresqlTaskRouteWorkspaceParticipant'
import { resolveUploadLimits } from '@/services/launchMultipart'
import { assertCanReplaySourceTask } from '@/services/taskCollab'

export interface SqliteTaskRouteLaunchDependencies
  extends
    Omit<AgentRouteLaunchDependencies, 'db' | 'workspace'>,
    Omit<WorkgroupRouteLaunchDependencies, 'db' | 'workspace'> {
  readonly db: DbClient
  /**
   * 与 PostgreSQL 那一支同形（`providerRuntime.ts` 的 `routeWorkspace`）：装配方交
   * **物化输入**，参与者由模块自己造。组合根因此不必深挖 `infrastructure/`
   * ——RFC-331 的分层判据会逐条抓出那种 deep import（本刀实撞过一次）。
   */
  readonly routeWorkspace: Omit<PostgresqlTaskRouteWorkspaceDependencies, 'db'>
  /**
   * 路由面独有的那一格（见 `PostgresqlTaskRouteLaunchDependencies`）：把 admitted actor
   * 绑成资源目录鉴权句柄。臂与启动参与者都不读它——它们收的是请求上带来的 `resources`。
   */
  readonly resourceAuthorityFor: (actor: Actor) => TaskExecutionResourceAuthority
}

export function createSqliteTaskRouteLaunchOperations(
  input: SqliteTaskRouteLaunchDependencies,
): Readonly<{
  agent: AgentRouteTaskLaunchOperations
  workgroup: WorkgroupRouteTaskLaunchOperations
}> {
  const withWorkspace = {
    ...input,
    workspace: createPostgresqlTaskRouteWorkspaceParticipant({
      db: input.db,
      ...input.routeWorkspace,
    }),
  }
  const launchAgent = createAgentRouteLaunch(withWorkspace)
  const launchWorkgroup = createWorkgroupRouteLaunch(withWorkspace)
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
      // RFC-359 AC-1（plan §5hn 批次二 ③）：工作组启动也改走**与 PostgreSQL 同一份**编排
      // （`createWorkgroupRouteLaunch`，终端是根启动内核）。此前这里转
      // `startExecution` → `startWorkgroupTask`（470 行、直接读库）。
      // 等价性由 `rfc359-w5hn-workgroup-launch-provider-parity` 作证（拒绝清单，整行比对）。
      async launch(
        actor: Parameters<WorkgroupRouteTaskLaunchOperations['launch']>[0],
        command: Parameters<WorkgroupRouteTaskLaunchOperations['launch']>[1],
      ) {
        return await launchWorkgroup({
          actor,
          command,
          invoker: { type: 'user', launchKind: 'direct-json' },
          resources: input.resourceAuthorityFor(actor),
        })
      },
    }),
  })
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ①）—— SQLite 侧的**启动参与者**，与 PostgreSQL 共用同一份。
 *
 * 此前这一格是 `services/execution/executor.ts#startExecution`：**同一个三分支 switch**
 * （workflow / agent / workgroup）的第二份写法，只是终端不同——它转
 * `startTask` / `startAgentTask` / `startWorkgroupTask`。三条臂的共享实现在批次一 / 批次二 ③
 * 已经就位，这里只差把工作区参与者从 `routeWorkspace` 物化出来再交给同一个工厂。
 */
export function createSqliteTaskExecutionLaunchParticipant(
  input: SqliteTaskRouteLaunchDependencies,
): PostgresqlTaskExecutionLaunchParticipant {
  return createPostgresqlTaskExecutionLaunchParticipant({
    ...input,
    workspace: createPostgresqlTaskRouteWorkspaceParticipant({
      db: input.db,
      ...input.routeWorkspace,
    }),
  })
}
