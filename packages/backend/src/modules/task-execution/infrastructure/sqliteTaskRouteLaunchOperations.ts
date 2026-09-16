import type { DbClient } from '@/db/client'
import type {
  AgentRouteTaskLaunchOperations,
  WorkgroupRouteTaskLaunchOperations,
} from '../public/commands'
import {
  createAgentRouteLaunch,
  createWorkgroupRouteLaunch,
  type AgentRouteLaunchDependencies,
  type WorkgroupRouteLaunchDependencies,
} from './postgresqlTaskRouteLaunchOperations'
import {
  createPostgresqlTaskRouteWorkspaceParticipant,
  type PostgresqlTaskRouteWorkspaceDependencies,
} from './postgresqlTaskRouteWorkspaceParticipant'
import { resolveUploadLimits } from '@/services/launchMultipart'
import { assertCanReplaySourceTask } from '@/services/taskCollab'
import { ensureWorkgroupHostWorkflow } from '@/modules/resource-catalog/infrastructure/legacy/workgroup/launch'

export interface SqliteTaskRouteLaunchDependencies
  extends
    Omit<AgentRouteLaunchDependencies, 'db' | 'workspace'>,
    Omit<WorkgroupRouteLaunchDependencies, 'db' | 'workspace' | 'workgroup'> {
  readonly db: DbClient
  /**
   * 工作组资源面。`ensureHostWorkflow`（懒种内置宿主锚行）由**模块自己**补上——
   * 组合根不许 import `resource-catalog/infrastructure/`（`rfc310-architecture-lock` 的源码锁），
   * 而 PG daemon 那一侧是把同一段 insert 内联在自己文件里的。让模块提供它，两个根都干净。
   */
  readonly workgroup: Omit<WorkgroupRouteLaunchDependencies['workgroup'], 'ensureHostWorkflow'>
  /**
   * 与 PostgreSQL 那一支同形（`providerRuntime.ts` 的 `routeWorkspace`）：装配方交
   * **物化输入**，参与者由模块自己造。组合根因此不必深挖 `infrastructure/`
   * ——RFC-331 的分层判据会逐条抓出那种 deep import（本刀实撞过一次）。
   */
  readonly routeWorkspace: Omit<PostgresqlTaskRouteWorkspaceDependencies, 'db'>
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
  const launchWorkgroup = createWorkgroupRouteLaunch({
    ...withWorkspace,
    workgroup: {
      ...input.workgroup,
      ensureHostWorkflow: () => ensureWorkgroupHostWorkflow(input.db),
    },
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
