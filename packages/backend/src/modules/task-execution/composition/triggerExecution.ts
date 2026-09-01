import {
  ScheduledAgentPayloadSchema,
  ScheduledWorkgroupPayloadSchema,
  StartTaskSchema,
} from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import type { WebhookTaskExecutionParticipant } from '@/modules/integration/application/ports/webhookExecution'
import type { TaskExecutionResourceAuthority } from '../application/ports/taskExecutionResourceSnapshots'
import type { Actor } from '@/auth/actor'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { startExecution, type StartExecutionDeps } from '@/services/execution/executor'
import type { StartExecutionRequest } from '@/services/execution/types'
import type { ExecutionInvoker, TaskCancellationCommand } from '../public/commands'
import type { PostgresqlTaskExecutionLaunchParticipant } from '../infrastructure/postgresqlTaskRouteLaunchOperations'

export type TaskExecutionTriggerParticipant = WebhookTaskExecutionParticipant<
  TaskExecutionResourceAuthority,
  ExecutionInvoker
>

export interface SqliteTaskExecutionTriggerDependencies {
  readonly db: DbClient
  readonly executionFor: (actor: Actor) => StartExecutionDeps
  readonly cancellation: TaskCancellationCommand
}

/** SQLite compatibility adapter over the same unified executor used by direct routes. */
export function createSqliteTaskExecutionTriggerParticipant(
  dependencies: SqliteTaskExecutionTriggerDependencies,
): TaskExecutionTriggerParticipant {
  return Object.freeze({
    async launch(input: Parameters<TaskExecutionTriggerParticipant['launch']>[0]) {
      await input.guard?.verifyCanCommit()
      const request: StartExecutionRequest = (() => {
        switch (input.target.kind) {
          case 'workflow':
            return {
              kind: input.target.kind,
              refId: input.target.refId,
              invoker: input.invoker,
              payload: input.target.payload,
            }
          case 'agent':
            return {
              kind: input.target.kind,
              refId: input.target.refId,
              invoker: input.invoker,
              payload: input.target.payload,
            }
          case 'workgroup':
            return {
              kind: input.target.kind,
              refId: input.target.refId,
              invoker: input.invoker,
              payload: input.target.payload,
            }
        }
      })()
      const task = await startExecution(dependencies.db, input.actor, request, {
        ...dependencies.executionFor(input.actor),
        launchResources: input.resources,
      })
      return { taskId: task.id }
    },
    async cancel(taskId: string) {
      await dependencies.cancellation.cancel({ taskId, cause: { kind: 'user' } })
    },
  })
}

export function createPostgresqlTaskExecutionTriggerParticipant(input: {
  readonly launches: PostgresqlTaskExecutionLaunchParticipant
  readonly cancellation: TaskCancellationCommand
}): TaskExecutionTriggerParticipant {
  return Object.freeze({
    async launch(request: Parameters<TaskExecutionTriggerParticipant['launch']>[0]) {
      const task = await input.launches.launch(request)
      return { taskId: task.id }
    },
    async cancel(taskId: string) {
      await input.cancellation.cancel({ taskId, cause: { kind: 'user' } })
    },
  })
}

/** ScheduledTask's launch closure over the selected provider participant. */
export function createBuildScheduleLaunch(
  participant: TaskExecutionTriggerParticipant,
): BuildScheduleLaunch {
  return (_ownerUserId: string, scheduledTaskId: string) =>
    async (kind, payload, actor, resources) => {
      const invoker = Object.freeze({ type: 'scheduled', scheduledTaskId } as const)
      if (kind === 'agent') {
        const parsed = ScheduledAgentPayloadSchema.parse(payload)
        const receipt = await participant.launch({
          actor,
          target: { kind, refId: parsed.agentId, payload: parsed },
          invoker,
          resources,
        })
        return { id: receipt.taskId }
      }
      if (kind === 'workgroup') {
        const parsed = ScheduledWorkgroupPayloadSchema.parse(payload)
        const receipt = await participant.launch({
          actor,
          target: { kind, refId: parsed.workgroupId, payload: parsed },
          invoker,
          resources,
        })
        return { id: receipt.taskId }
      }
      const parsed = StartTaskSchema.parse(payload)
      const receipt = await participant.launch({
        actor,
        target: { kind, refId: parsed.workflowId, payload: parsed },
        invoker,
        resources,
      })
      return { id: receipt.taskId }
    }
}
