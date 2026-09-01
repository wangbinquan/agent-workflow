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
          input.executionFor(actor),
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
          input.executionFor(actor),
        )
      },
    }),
  })
}
