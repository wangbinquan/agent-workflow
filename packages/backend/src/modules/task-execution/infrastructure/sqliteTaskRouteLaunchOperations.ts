import type { DbClient } from '@/db/client'
import type {
  AgentRouteTaskLaunchOperations,
  WorkgroupRouteTaskLaunchOperations,
} from '../public/commands'
import { startExecution, type StartExecutionDeps } from '@/services/execution/executor'
import { resolveUploadLimits } from '@/services/launchMultipart'
import { assertCanReplaySourceTask } from '@/services/taskCollab'

export interface SqliteTaskRouteLaunchDependencies {
  readonly db: DbClient
  readonly configPath: string
  readonly execution: StartExecutionDeps
}

export function createSqliteTaskRouteLaunchOperations(
  input: SqliteTaskRouteLaunchDependencies,
): Readonly<{
  agent: AgentRouteTaskLaunchOperations
  workgroup: WorkgroupRouteTaskLaunchOperations
}> {
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
      async launch(
        actor: Parameters<AgentRouteTaskLaunchOperations['launch']>[0],
        command: Parameters<AgentRouteTaskLaunchOperations['launch']>[1],
      ) {
        return await startExecution(
          input.db,
          actor,
          {
            kind: 'agent',
            refId: command.agentId,
            invoker: {
              type: 'user',
              launchKind: command.uploads === undefined ? 'direct-json' : 'direct-multipart',
            },
            payload: command.payload,
            ...(command.uploads === undefined
              ? {}
              : {
                  uploads: {
                    parts: command.uploads.parts.map((part) => ({ ...part })),
                    limits: { ...command.uploads.limits },
                  },
                }),
          },
          input.execution,
        )
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
          input.execution,
        )
      },
    }),
  })
}
