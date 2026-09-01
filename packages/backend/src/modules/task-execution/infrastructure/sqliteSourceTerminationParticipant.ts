// RFC-303 — canonical task-owned source-termination application service.
import { CANCELABLE_TASK_STATUSES } from '@agent-workflow/shared'
import type { TaskStatus } from '@agent-workflow/shared'
import { and, asc, eq, lt } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskExecutionOwners, tasks } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import {
  sourceTerminationTargetDisposition,
  taskStopProjection,
  type TaskStopCause,
} from '@/modules/task-execution/domain/sourceTermination'
import { sourceTerminationCapabilityMatches } from '@/modules/task-execution/application/sourceTerminationCapability'
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
  TaskSourceTerminationReceipt,
} from '@/modules/task-execution/application/applySourceTerminationEffect'
import { finalizeCanceledTaskWithoutDriver } from '@/services/task'
import { cancelOpenNodeRunsTx, setTaskStatus } from '@/services/lifecycle'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { ConflictError } from '@/util/errors'
import { taskExecutionModule } from '@/modules/task-execution/composition'
import { terminalizeTaskExecutionIntentsTx } from './sqliteTerminalizeExecutionIntent'
import type { RuntimeStopTicket } from '@/modules/task-execution/infrastructure/inMemoryTaskRuntimeRegistry'
import type { OwnershipToken } from '@/modules/task-execution/domain/ownership'
import { appendTaskNodeStatusesCommittedEventTx } from './taskLifecycleEventParticipant'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { CommittedEventRef } from '@/platform/events/committed/types'

// RFC-317 T51（LC-06）—— 从转移表派生，不再手抄。
const CANCELABLE: readonly TaskStatus[] = CANCELABLE_TASK_STATUSES

type AppliedTarget = {
  receipt: TaskSourceTerminationReceipt
  stopTicket: RuntimeStopTicket | null
  ownerWithoutLocalToken: boolean
  statusChanged: boolean
  canceledNodeRuns: Array<{ id: string; nodeId: string }>
}

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

async function applyOne(
  db: DbClient,
  taskId: string,
  input: TaskSourceTerminationEffectInput,
): Promise<AppliedTarget | null> {
  return withTaskReviewMutationLock(taskId, async () => {
    const row = db
      .select({
        status: tasks.status,
        parentTaskId: tasks.parentTaskId,
        launchRevision: tasks.sourceTerminationLaunchRev,
        fence: tasks.sourceTerminationFence,
        effectRevision: tasks.sourceTerminationEffectRev,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
      .all()[0]
    if (
      row === undefined ||
      row.launchRevision === null ||
      row.launchRevision >= input.streamRevision
    ) {
      return null
    }

    const priorStatus = row.status
    if ((row.effectRevision ?? -1) >= input.streamRevision) {
      const repeatedCause = terminalCause(input, row.parentTaskId)
      let canceledNodeRuns: Array<{ id: string; nodeId: string }> = []
      let nodeEventRef: CommittedEventRef | null = null
      if (repeatedCause !== null) {
        dbTxSync(db, (tx) => {
          const now = Date.now()
          canceledNodeRuns = cancelOpenNodeRunsTx({
            tx,
            taskId,
            finishedAt: now,
            errorMessage: taskStopProjection(repeatedCause).code,
          })
          if (canceledNodeRuns.length > 0) {
            nodeEventRef = appendTaskNodeStatusesCommittedEventTx(tx, {
              taskId,
              reason: 'source-termination',
              nodeChanges: canceledNodeRuns.map((run) => ({
                nodeRunId: run.id,
                nodeId: run.nodeId,
                status: 'canceled',
                cause: taskStopProjection(repeatedCause).code,
              })),
              occurredAt: now,
              identity: {
                operationRef: `source-termination-reconcile:${input.deliveryId}:${input.streamRevision}:${taskId}:${canceledNodeRuns.map((run) => run.id).join(',')}`,
              },
            })
          }
        })
        await publishCommittedEventsAfterCommit(nodeEventRef === null ? [] : [nodeEventRef])
      }
      const owner = taskExecutionModule.ownership.read(db, taskId)
      const token =
        owner?.state === 'claimed' ? taskExecutionModule.runtimeRegistry.tokenForOwner(owner) : null
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
        stopTicket:
          token !== null && repeatedCause !== null
            ? taskExecutionModule.runtimeRegistry.requestStop(token, repeatedCause)
            : null,
        ownerWithoutLocalToken: owner?.state === 'claimed' && token === null,
        statusChanged: false,
        canceledNodeRuns,
      }
    }

    if (input.kind === 'clear-closed') {
      const nextFence = row.fence === 'closed' ? null : row.fence
      db.update(tasks)
        .set({
          sourceTerminationFence: nextFence,
          sourceTerminationEffectRev: input.streamRevision,
        })
        .where(
          and(eq(tasks.id, taskId), lt(tasks.sourceTerminationEffectRev, input.streamRevision)),
        )
        .run()
      // NULL effect revisions do not satisfy SQL `<`; old task rows are handled
      // by the unconditional, coordinator-protected fallback.
      if (row.effectRevision === null) {
        db.update(tasks)
          .set({
            sourceTerminationFence: nextFence,
            sourceTerminationEffectRev: input.streamRevision,
          })
          .where(eq(tasks.id, taskId))
          .run()
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
        stopTicket: null,
        ownerWithoutLocalToken: false,
        statusChanged: false,
        canceledNodeRuns: [],
      }
    }

    const requestedFence = input.kind === 'fence-merged' ? 'merged' : 'closed'
    const nextFence = row.fence === 'merged' || requestedFence === 'merged' ? 'merged' : 'closed'
    const disposition = sourceTerminationTargetDisposition(priorStatus)
    const cause = terminalCause(input, row.parentTaskId)!
    const projection = taskStopProjection(cause)
    let statusChanged = false
    let exactToken: OwnershipToken | null = null
    let ownerWithoutLocalToken = false
    let canceledNodeRuns: Array<{ id: string; nodeId: string }> = []
    if (disposition === 'cancel') {
      try {
        const now = Date.now()
        let candidateToken: OwnershipToken | null = null
        let candidateMissing = false
        await setTaskStatus({
          db,
          taskId,
          to: 'canceled',
          allowedFrom: CANCELABLE,
          extra: {
            finishedAt: now,
            errorSummary: projection.summary,
            errorMessage: `${projection.code}: delivery=${input.deliveryId} revision=${input.streamRevision}`,
            sourceTerminationFence: nextFence,
            sourceTerminationEffectRev: input.streamRevision,
          },
          onTransitionTx: (tx, _transition, collector) => {
            canceledNodeRuns = cancelOpenNodeRunsTx({
              tx,
              taskId,
              finishedAt: now,
              errorMessage: projection.code,
            })
            collector.addNodeChanges(
              canceledNodeRuns.map((run) => ({
                nodeRunId: run.id,
                nodeId: run.nodeId,
                status: 'canceled',
                cause: projection.code,
              })),
            )
            const owner = tx
              .select()
              .from(taskExecutionOwners)
              .where(eq(taskExecutionOwners.taskId, taskId))
              .get()
            if (owner?.state === 'claimed') {
              candidateToken = taskExecutionModule.runtimeRegistry.tokenForOwner(owner)
              candidateMissing = candidateToken === null
              taskExecutionModule.ownership.revokeExactTx({
                tx,
                owner,
                expectedRevision: owner.revision,
                now,
                recoveryCode: 'terminal-control-source',
              })
            }
            terminalizeTaskExecutionIntentsTx({
              tx,
              taskId,
              state: 'canceled',
              failureCode: projection.code,
              now,
            })
          },
          sourceTerminationEffectRef: `source-termination:${input.deliveryId}:${input.streamRevision}`,
          committedEventIdentity: {
            operationRef: `source-termination:${input.deliveryId}:${input.streamRevision}:${taskId}`,
          },
          reason: `source-termination-${input.kind}`,
        })
        exactToken = candidateToken
        ownerWithoutLocalToken = candidateMissing
        statusChanged = true
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
        const winner = db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
          .all()[0]
        if (winner !== undefined && CANCELABLE.includes(winner.status)) throw error
        let nodeEventRef: CommittedEventRef | null = null
        dbTxSync(db, (tx) => {
          const now = Date.now()
          tx.update(tasks)
            .set({
              sourceTerminationFence: nextFence,
              sourceTerminationEffectRev: input.streamRevision,
            })
            .where(eq(tasks.id, taskId))
            .run()
          const owner = tx
            .select()
            .from(taskExecutionOwners)
            .where(eq(taskExecutionOwners.taskId, taskId))
            .get()
          if (owner?.state === 'claimed') {
            exactToken = taskExecutionModule.runtimeRegistry.tokenForOwner(owner)
            ownerWithoutLocalToken = exactToken === null
            taskExecutionModule.ownership.revokeExactTx({
              tx,
              owner,
              expectedRevision: owner.revision,
              now: Date.now(),
              recoveryCode: 'terminal-control-source-race-winner',
            })
          }
          terminalizeTaskExecutionIntentsTx({
            tx,
            taskId,
            state: 'canceled',
            failureCode: projection.code,
            now,
          })
          canceledNodeRuns = cancelOpenNodeRunsTx({
            tx,
            taskId,
            finishedAt: now,
            errorMessage: projection.code,
          })
          if (canceledNodeRuns.length > 0) {
            nodeEventRef = appendTaskNodeStatusesCommittedEventTx(tx, {
              taskId,
              reason: 'source-termination',
              nodeChanges: canceledNodeRuns.map((run) => ({
                nodeRunId: run.id,
                nodeId: run.nodeId,
                status: 'canceled',
                cause: projection.code,
              })),
              occurredAt: now,
              identity: {
                operationRef: `source-termination:${input.deliveryId}:${input.streamRevision}:${taskId}`,
              },
            })
          }
        })
        await publishCommittedEventsAfterCommit(nodeEventRef === null ? [] : [nodeEventRef])
      }
    } else {
      let nodeEventRef: CommittedEventRef | null = null
      dbTxSync(db, (tx) => {
        const now = Date.now()
        tx.update(tasks)
          .set({
            sourceTerminationFence: nextFence,
            sourceTerminationEffectRev: input.streamRevision,
          })
          .where(eq(tasks.id, taskId))
          .run()
        const owner = tx
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, taskId))
          .get()
        if (owner?.state === 'claimed') {
          exactToken = taskExecutionModule.runtimeRegistry.tokenForOwner(owner)
          ownerWithoutLocalToken = exactToken === null
          taskExecutionModule.ownership.revokeExactTx({
            tx,
            owner,
            expectedRevision: owner.revision,
            now,
            recoveryCode: 'terminal-control-source-terminal',
          })
        }
        terminalizeTaskExecutionIntentsTx({
          tx,
          taskId,
          state: 'canceled',
          failureCode: projection.code,
          now,
        })
        canceledNodeRuns = cancelOpenNodeRunsTx({
          tx,
          taskId,
          finishedAt: now,
          errorMessage: projection.code,
        })
        if (canceledNodeRuns.length > 0) {
          nodeEventRef = appendTaskNodeStatusesCommittedEventTx(tx, {
            taskId,
            reason: 'source-termination',
            nodeChanges: canceledNodeRuns.map((run) => ({
              nodeRunId: run.id,
              nodeId: run.nodeId,
              status: 'canceled',
              cause: projection.code,
            })),
            occurredAt: now,
            identity: {
              operationRef: `source-termination:${input.deliveryId}:${input.streamRevision}:${taskId}`,
            },
          })
        }
      })
      await publishCommittedEventsAfterCommit(nodeEventRef === null ? [] : [nodeEventRef])
    }

    const stopTicket =
      exactToken === null
        ? null
        : taskExecutionModule.runtimeRegistry.requestStop(exactToken, cause)

    return {
      receipt: {
        taskId,
        priorStatus,
        fenceOutcome: nextFence === 'merged' ? 'fenced-merged' : 'fenced-closed',
        cancelOutcome: disposition === 'cancel' ? 'canceled' : 'already-terminal',
        releaseOutcome: 'pending',
        errorCode: null,
      },
      stopTicket,
      ownerWithoutLocalToken,
      statusChanged,
      canceledNodeRuns,
    }
  })
}

export function createTaskSourceTerminationParticipant(
  db: DbClient,
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
          const applied = await applyOne(db, row.id, input)
          if (applied === null) continue
          let receipt = applied.receipt
          if (applied.stopTicket !== null) {
            const stopped = await taskExecutionModule.runtimeRegistry.awaitStopped(
              applied.stopTicket,
            )
            receipt =
              stopped.kind === 'released'
                ? { ...receipt, releaseOutcome: 'released' }
                : {
                    ...receipt,
                    releaseOutcome: 'unreaped',
                    errorCode: stopped.code,
                  }
          } else if (applied.ownerWithoutLocalToken) {
            receipt = {
              ...receipt,
              releaseOutcome: 'unreaped',
              errorCode: 'task-execution-recovery-required',
            }
          } else if (input.kind !== 'clear-closed') {
            await finalizeCanceledTaskWithoutDriver(db, row.id)
            receipt = { ...receipt, releaseOutcome: 'no-active-owner' }
          }
          receipts.set(row.id, receipt)
        }
      }
      return [...receipts.values()]
    },
  }
}
