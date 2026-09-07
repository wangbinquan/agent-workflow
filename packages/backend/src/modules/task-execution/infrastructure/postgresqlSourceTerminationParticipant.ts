// RFC-349 — PostgreSQL source-termination atom. Fence/status, open-node
// cancellation, intent terminalization, owner revocation and committed events
// are one provider transaction per target. Runtime stop remains post-commit.

import {
  CANCELABLE_TASK_STATUSES,
  allowedFromStatusesForEvent,
  type TaskStatus,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import { nodeRuns, taskExecutionOwners, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { ConflictError } from '@/util/errors'
import { resolveTerminalWorkspacePruneDecision } from '@/services/lifecycle'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
  TaskSourceTerminationReceipt,
} from '../application/applySourceTerminationEffect'
import { sourceTerminationCapabilityMatches } from '../application/sourceTerminationCapability'
import { executeSourceTermination, terminalCause } from '../application/sourceTerminationExecution'
import { listSourceTerminationTargets } from './sourceTerminationTargets'
import { taskExecutionModule } from '../composition'
import type { InMemoryTaskRuntimeRegistry } from './inMemoryTaskRuntimeRegistry'
import {
  sourceTerminationTargetDisposition,
  taskStopProjection,
  type TaskStopCause,
} from '../domain/sourceTermination'
import type { OwnershipToken } from '../domain/ownership'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import { terminalizeTaskExecutionIntentsInTx } from './taskExecutionIntentTerminalPersistence'
import {
  withPostgresqlSerializableTaskExecution,
  type PostgresqlTaskExecutionTransaction,
} from './postgresqlTaskLifecycleTransaction'
import {
  appendTaskLifecycleTransitionCommittedEvent,
  appendTaskNodeStatusesCommittedEvent,
} from './taskLifecycleCommittedEvents'

const CANCELABLE: readonly TaskStatus[] = CANCELABLE_TASK_STATUSES
const CANCELABLE_NODE_STATUSES = [...allowedFromStatusesForEvent({ kind: 'mark-canceled' })]

type AppliedTarget = Readonly<{
  receipt: TaskSourceTerminationReceipt
  stopToken: OwnershipToken | null
  stopCause: TaskStopCause | null
  ownerWithoutLocalToken: boolean
  eventRefs: readonly TaskExecutionPostCommitEventRef[]
}>

async function cancelOpenNodeRuns(
  tx: PostgresqlTaskExecutionTransaction,
  input: { taskId: string; now: number; cause: string },
) {
  const rows = await tx
    .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId, status: nodeRuns.status })
    .from(nodeRuns)
    .where(
      and(eq(nodeRuns.taskId, input.taskId), inArray(nodeRuns.status, CANCELABLE_NODE_STATUSES)),
    )
  for (const row of rows) {
    const changed = await tx
      .update(nodeRuns)
      .set({
        status: 'canceled',
        finishedAt: input.now,
        errorMessage: input.cause,
      })
      .where(and(eq(nodeRuns.id, row.id), eq(nodeRuns.status, row.status)))
      .returning({ id: nodeRuns.id })
    if (changed[0] === undefined) {
      throw new ConflictError(
        'concurrent-node-run-transition',
        `node_run ${row.id} changed during source termination`,
      )
    }
  }
  return rows.map((row) => ({
    nodeRunId: row.id,
    nodeId: row.nodeId,
    status: 'canceled' as const,
    cause: input.cause,
  }))
}

async function revokeClaimedOwner(
  tx: PostgresqlTaskExecutionTransaction,
  taskId: string,
  runtimeRegistry: InMemoryTaskRuntimeRegistry,
  now: number,
  recoveryCode: string,
): Promise<Readonly<{ token: OwnershipToken | null; ownerWithoutLocalToken: boolean }>> {
  const owners = await tx
    .select()
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, taskId))
    .limit(1)
  const owner = owners[0]
  if (owner === undefined || owner.state !== 'claimed') {
    return { token: null, ownerWithoutLocalToken: false }
  }
  const token = runtimeRegistry.tokenForOwner(owner)
  const changed = await tx
    .update(taskExecutionOwners)
    .set({
      state: 'revoked',
      revision: owner.revision + 1,
      recoveryCode,
      updatedAt: now,
    })
    .where(
      and(
        eq(taskExecutionOwners.taskId, owner.taskId),
        eq(taskExecutionOwners.ownerId, owner.ownerId),
        eq(taskExecutionOwners.daemonGeneration, owner.daemonGeneration),
        eq(taskExecutionOwners.epoch, owner.epoch),
        eq(taskExecutionOwners.revision, owner.revision),
        eq(taskExecutionOwners.state, 'claimed'),
      ),
    )
    .returning({ taskId: taskExecutionOwners.taskId })
  if (changed[0] === undefined) {
    throw new ConflictError(
      'task-execution-stale-owner',
      `task '${taskId}' source-termination owner revoke lost`,
    )
  }
  return { token, ownerWithoutLocalToken: token === null }
}

async function applyOne(
  db: PostgresqlDatabaseClient,
  runtimeRegistry: InMemoryTaskRuntimeRegistry,
  taskId: string,
  input: TaskSourceTerminationEffectInput,
): Promise<AppliedTarget | null> {
  return await withTaskReviewMutationLock(
    taskId,
    async () =>
      await withPostgresqlSerializableTaskExecution(db, async (tx) => {
        const rows = await tx
          .select({
            status: tasks.status,
            parentTaskId: tasks.parentTaskId,
            launchRevision: tasks.sourceTerminationLaunchRev,
            fence: tasks.sourceTerminationFence,
            effectRevision: tasks.sourceTerminationEffectRev,
            lifecycleEventRevision: tasks.lifecycleEventRevision,
            errorSummary: tasks.errorSummary,
            spaceKind: tasks.spaceKind,
            workspacePruningAt: tasks.workspacePruningAt,
            workspacePruneCause: tasks.workspacePruneCause,
            workspacePrunedAt: tasks.workspacePrunedAt,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
        const row = rows[0]
        if (
          row === undefined ||
          row.launchRevision === null ||
          row.launchRevision >= input.streamRevision
        ) {
          return null
        }
        const priorStatus = row.status as TaskStatus
        const cause = terminalCause(input, row.parentTaskId)
        const eventRefs: TaskExecutionPostCommitEventRef[] = []

        if ((row.effectRevision ?? -1) >= input.streamRevision) {
          let ownerWithoutLocalToken = false
          let stopToken: OwnershipToken | null = null
          if (cause !== null) {
            const now = Date.now()
            const projection = taskStopProjection(cause)
            const nodeChanges = await cancelOpenNodeRuns(tx, {
              taskId,
              now,
              cause: projection.code,
            })
            if (nodeChanges.length > 0) {
              const eventRef = await appendTaskNodeStatusesCommittedEvent(tx, {
                taskId,
                nodeChanges,
                occurredAt: now,
                identity: {
                  operationRef: `source-termination-reconcile:${input.deliveryId}:${input.streamRevision}:${taskId}:${nodeChanges.map((change) => change.nodeRunId).join(',')}`,
                },
              })
              if (eventRef !== null) eventRefs.push(eventRef)
            }
            const ownerRows = await tx
              .select()
              .from(taskExecutionOwners)
              .where(eq(taskExecutionOwners.taskId, taskId))
              .limit(1)
            const owner = ownerRows[0]
            const token = owner?.state === 'claimed' ? runtimeRegistry.tokenForOwner(owner) : null
            ownerWithoutLocalToken = owner?.state === 'claimed' && token === null
            stopToken = token
          }
          return {
            receipt: {
              taskId,
              priorStatus,
              fenceOutcome: 'unchanged',
              cancelOutcome:
                input.kind === 'clear-closed'
                  ? 'not-applicable'
                  : sourceTerminationTargetDisposition(priorStatus) === 'cancel'
                    ? 'canceled'
                    : 'already-terminal',
              releaseOutcome: input.kind === 'clear-closed' ? 'not-required' : 'pending',
              errorCode: null,
            },
            stopToken,
            stopCause: cause,
            ownerWithoutLocalToken,
            eventRefs,
          }
        }

        if (input.kind === 'clear-closed') {
          const nextFence = row.fence === 'closed' ? null : row.fence
          const changed = await tx
            .update(tasks)
            .set({
              sourceTerminationFence: nextFence,
              sourceTerminationEffectRev: input.streamRevision,
            })
            .where(
              and(
                eq(tasks.id, taskId),
                eq(tasks.lifecycleEventRevision, row.lifecycleEventRevision),
              ),
            )
            .returning({ id: tasks.id })
          if (changed[0] === undefined) {
            throw new ConflictError(
              'concurrent-task-transition',
              `task ${taskId} changed during source fence clear`,
            )
          }
          return {
            receipt: {
              taskId,
              priorStatus,
              fenceOutcome: row.fence === 'closed' ? 'cleared-closed' : 'unchanged',
              cancelOutcome: 'not-applicable',
              releaseOutcome: 'not-required',
              errorCode: null,
            },
            stopToken: null,
            stopCause: null,
            ownerWithoutLocalToken: false,
            eventRefs,
          }
        }

        const requestedFence = input.kind === 'fence-merged' ? 'merged' : 'closed'
        const nextFence =
          row.fence === 'merged' || requestedFence === 'merged' ? 'merged' : 'closed'
        const disposition = sourceTerminationTargetDisposition(priorStatus)
        const projection = taskStopProjection(cause!)
        const now = Date.now()
        const nodeChanges = await cancelOpenNodeRuns(tx, {
          taskId,
          now,
          cause: projection.code,
        })
        let statusChanged = false
        if (disposition === 'cancel') {
          // RFC-300 —— 终态转移同时**认领**任务自有工作区的回收。SQLite 侧这一步由
          // `setTaskStatus` 内核代劳；这里是手写的终态 CAS，所以必须自己调同一份中立策略，
          // 否则 webhook 来源任务的工作树在 PostgreSQL 上永远不会被回收（RFC-359 W8 对拍照出）。
          // 决策与三列墓碑条件的配对沿用 `taskRuntimeLifecyclePersistence` 的形状。
          const prune = await resolveTerminalWorkspacePruneDecision(
            {
              taskId,
              spaceKind: row.spaceKind,
              workspacePruningAt: row.workspacePruningAt,
              workspacePruneCause: row.workspacePruneCause,
              workspacePrunedAt: row.workspacePrunedAt,
            },
            'canceled',
          )
          const changed = await tx
            .update(tasks)
            .set({
              status: 'canceled',
              ...(priorStatus === 'running'
                ? {
                    runningMs: sql`${tasks.runningMs} + (${now} - COALESCE(${tasks.runningSince}, ${now}))`,
                    runningSince: null,
                  }
                : {}),
              finishedAt: now,
              errorSummary: projection.summary,
              errorMessage: `${projection.code}: delivery=${input.deliveryId} revision=${input.streamRevision}`,
              sourceTerminationFence: nextFence,
              sourceTerminationEffectRev: input.streamRevision,
              ...(prune.prune ? { workspacePruningAt: now, workspacePruneCause: prune.cause } : {}),
              lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
            })
            .where(
              and(
                eq(tasks.id, taskId),
                eq(tasks.status, priorStatus),
                eq(tasks.lifecycleEventRevision, row.lifecycleEventRevision),
                inArray(tasks.status, CANCELABLE),
                ...(prune.prune
                  ? [
                      isNull(tasks.workspacePruningAt),
                      isNull(tasks.workspacePruneCause),
                      isNull(tasks.workspacePrunedAt),
                    ]
                  : []),
              ),
            )
            .returning({ lifecycleEventRevision: tasks.lifecycleEventRevision })
          const updated = changed[0]
          if (updated === undefined) {
            throw new ConflictError(
              'concurrent-task-transition',
              `task ${taskId} changed during source termination`,
            )
          }
          statusChanged = true
          const eventRef = await appendTaskLifecycleTransitionCommittedEvent(tx, {
            taskId,
            lifecycleRevision: updated.lifecycleEventRevision,
            previousStatus: priorStatus,
            status: 'canceled',
            errorSummary: projection.summary,
            nodeChanges,
            // 认领必须同时进事件：`task-workspace-prune-nudge` 消费者只认这个字段，
            // 没有它就没有人去把工作树真正删掉（两个 bootstrap 都是这么接的）。
            workspacePruneClaim: prune.prune
              ? { claimedAt: new Date(now).toISOString(), cause: prune.cause }
              : null,
            sourceTerminationEffectRef: `source-termination:${input.deliveryId}:${input.streamRevision}`,
            occurredAt: now,
            identity: {
              operationRef: `source-termination:${input.deliveryId}:${input.streamRevision}:${taskId}`,
            },
          })
          if (eventRef !== null) eventRefs.push(eventRef)
        } else {
          const changed = await tx
            .update(tasks)
            .set({
              sourceTerminationFence: nextFence,
              sourceTerminationEffectRev: input.streamRevision,
            })
            .where(
              and(
                eq(tasks.id, taskId),
                eq(tasks.lifecycleEventRevision, row.lifecycleEventRevision),
              ),
            )
            .returning({ id: tasks.id })
          if (changed[0] === undefined) {
            throw new ConflictError(
              'concurrent-task-transition',
              `task ${taskId} changed during terminal source fencing`,
            )
          }
          if (nodeChanges.length > 0) {
            const eventRef = await appendTaskNodeStatusesCommittedEvent(tx, {
              taskId,
              nodeChanges,
              occurredAt: now,
              identity: {
                operationRef: `source-termination:${input.deliveryId}:${input.streamRevision}:${taskId}`,
              },
            })
            if (eventRef !== null) eventRefs.push(eventRef)
          }
        }

        const owner = await revokeClaimedOwner(
          tx,
          taskId,
          runtimeRegistry,
          now,
          statusChanged ? 'terminal-control-source' : 'terminal-control-source-terminal',
        )
        await terminalizeTaskExecutionIntentsInTx(tx, {
          taskId,
          state: 'canceled',
          failureCode: projection.code,
          now,
        })
        return {
          receipt: {
            taskId,
            priorStatus,
            fenceOutcome: nextFence === 'merged' ? 'fenced-merged' : 'fenced-closed',
            cancelOutcome: disposition === 'cancel' ? 'canceled' : 'already-terminal',
            releaseOutcome: 'pending',
            errorCode: null,
          },
          stopToken: owner.token,
          stopCause: cause,
          ownerWithoutLocalToken: owner.ownerWithoutLocalToken,
          eventRefs,
        }
      }),
  )
}

export function createPostgresqlTaskSourceTerminationParticipant(
  db: PostgresqlDatabaseClient,
  runtimeRegistry: InMemoryTaskRuntimeRegistry = taskExecutionModule.runtimeRegistry,
): TaskSourceTerminationParticipant {
  return {
    async apply(
      capability: SourceTerminationEffectCapability,
      input: TaskSourceTerminationEffectInput,
    ) {
      if (!sourceTerminationCapabilityMatches(capability, input)) {
        throw new ConflictError(
          'source-termination-capability-invalid',
          'source termination capability does not match the claimed durable effect',
        )
      }
      return await executeSourceTermination(
        input,
        () => listSourceTerminationTargets(db, input),
        (taskId) => applyOne(db, runtimeRegistry, taskId, input),
        async (applied) => {
          await publishCommittedEventsAfterCommit(applied.eventRefs)
          return applied.stopToken !== null && applied.stopCause !== null
            ? await runtimeRegistry.awaitStopped(
                runtimeRegistry.requestStop(applied.stopToken, applied.stopCause),
              )
            : null
        },
      )
    },
  }
}
