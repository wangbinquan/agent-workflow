// RFC-349 — PostgreSQL source-termination atom. Fence/status, open-node
// cancellation, intent terminalization, owner revocation and committed events
// are one provider transaction per target. Runtime stop remains post-commit.

import {
  CANCELABLE_TASK_STATUSES,
  allowedFromStatusesForEvent,
  type TaskStatus,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'

import { nodeRuns, taskExecutionOwners, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { ConflictError } from '@/util/errors'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
  TaskSourceTerminationReceipt,
} from '../application/applySourceTerminationEffect'
import { sourceTerminationCapabilityMatches } from '../application/sourceTerminationCapability'
import { taskExecutionModule } from '../composition'
import type { InMemoryTaskRuntimeRegistry } from './inMemoryTaskRuntimeRegistry'
import {
  sourceTerminationTargetDisposition,
  taskStopProjection,
  type TaskStopCause,
} from '../domain/sourceTermination'
import type { OwnershipToken } from '../domain/ownership'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import { terminalizePostgresqlTaskExecutionIntentsTx } from './postgresqlTaskExecutionIntentTerminalPersistence'
import {
  appendPostgresqlTaskLifecycleTransitionTx,
  appendPostgresqlTaskNodeStatusesTx,
  withPostgresqlSerializableTaskExecution,
  type PostgresqlTaskExecutionTransaction,
} from './postgresqlTaskLifecycleTransaction'

const CANCELABLE: readonly TaskStatus[] = CANCELABLE_TASK_STATUSES
const CANCELABLE_NODE_STATUSES = [...allowedFromStatusesForEvent({ kind: 'mark-canceled' })]

type AppliedTarget = Readonly<{
  receipt: TaskSourceTerminationReceipt
  stopToken: OwnershipToken | null
  stopCause: TaskStopCause | null
  ownerWithoutLocalToken: boolean
  eventRefs: readonly TaskExecutionPostCommitEventRef[]
}>

function fenceFor(input: TaskSourceTerminationEffectInput): 'closed' | 'merged' | null {
  if (input.kind === 'fence-closed') return 'closed'
  if (input.kind === 'fence-merged') return 'merged'
  return null
}

function terminalCause(
  input: TaskSourceTerminationEffectInput,
  parentTaskId: string | null,
): TaskStopCause | null {
  const terminal = fenceFor(input)
  if (terminal === null) return null
  return parentTaskId === null
    ? {
        kind: 'webhook-terminal',
        terminal,
        deliveryId: input.deliveryId,
        streamRevision: input.streamRevision,
      }
    : {
        kind: 'parent-cascade',
        parentTaskId,
        rootCause: {
          terminal,
          deliveryId: input.deliveryId,
          streamRevision: input.streamRevision,
        },
      }
}

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
              const eventRef = await appendPostgresqlTaskNodeStatusesTx(tx, {
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
              lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
            })
            .where(
              and(
                eq(tasks.id, taskId),
                eq(tasks.status, priorStatus),
                eq(tasks.lifecycleEventRevision, row.lifecycleEventRevision),
                inArray(tasks.status, CANCELABLE),
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
          const eventRef = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
            taskId,
            lifecycleRevision: updated.lifecycleEventRevision,
            previousStatus: priorStatus,
            status: 'canceled',
            errorSummary: projection.summary,
            nodeChanges,
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
            const eventRef = await appendPostgresqlTaskNodeStatusesTx(tx, {
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
        await terminalizePostgresqlTaskExecutionIntentsTx(tx, {
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
      const receipts = new Map<string, TaskSourceTerminationReceipt>()
      const processed = new Set<string>()
      for (;;) {
        const rows = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.sourceTerminationBinding, input.binding),
              lt(tasks.sourceTerminationLaunchRev, input.streamRevision),
            ),
          )
          .orderBy(asc(tasks.invocationDepth), asc(tasks.id))
        const pending = rows.filter((row) => !processed.has(row.id))
        if (pending.length === 0) break
        for (const row of pending) {
          processed.add(row.id)
          const applied = await applyOne(db, runtimeRegistry, row.id, input)
          if (applied === null) continue
          await publishCommittedEventsAfterCommit(applied.eventRefs)
          let receipt = applied.receipt
          if (applied.stopToken !== null && applied.stopCause !== null) {
            const stopped = await runtimeRegistry.awaitStopped(
              runtimeRegistry.requestStop(applied.stopToken, applied.stopCause),
            )
            receipt =
              stopped.kind === 'released'
                ? { ...receipt, releaseOutcome: 'released' }
                : { ...receipt, releaseOutcome: 'unreaped', errorCode: stopped.code }
          } else if (applied.ownerWithoutLocalToken) {
            receipt = {
              ...receipt,
              releaseOutcome: 'unreaped',
              errorCode: 'task-execution-recovery-required',
            }
          } else if (input.kind !== 'clear-closed') {
            receipt = { ...receipt, releaseOutcome: 'no-active-owner' }
          }
          receipts.set(row.id, receipt)
        }
      }
      return [...receipts.values()]
    },
  }
}
