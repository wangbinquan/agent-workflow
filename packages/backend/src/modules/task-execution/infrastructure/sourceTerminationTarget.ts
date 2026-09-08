// RFC-359 W12: one per-target atom for both providers. Runtime publication,
// stopping and SQLite's no-driver finalization remain in their existing hosts.
import { CANCELABLE_TASK_STATUSES, allowedFromStatusesForEvent } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionOwners, tasks } from '@/db/schema'
import {
  ConcurrentTaskTransition,
  resolveTerminalWorkspacePruneDecision,
} from '@/services/lifecycle'
import { ConflictError } from '@/util/errors'
import type {
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationReceipt,
} from '../application/applySourceTerminationEffect'
import { terminalCause } from '../application/sourceTerminationExecution'
import type { OwnershipToken } from '../domain/ownership'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import {
  sourceTerminationTargetDisposition,
  taskStopProjection,
  type TaskStopCause,
} from '../domain/sourceTermination'
import type { TaskNodeChangeV1 } from '../domain/taskLifecycleCommittedEvent'
import type { InMemoryTaskRuntimeRegistry } from './inMemoryTaskRuntimeRegistry'
import { transitionNodeRunStatusTx } from './nodeRunLifecycleTransition'
import { withTaskExecutionSerializable, type TaskExecutionTransaction } from './ownedTaskExecution'
import { terminalizeTaskExecutionIntentsInTx } from './taskExecutionIntentTerminalPersistence'
import { appendTaskNodeStatusesCommittedEvent } from './taskLifecycleCommittedEvents'
import { revokeExactOwnerInTx } from './taskOwnershipPersistence'
import { writeTaskRuntimeLifecycleInTx } from './taskRuntimeLifecyclePersistence'

const CANCELABLE_NODE_STATUSES = [...allowedFromStatusesForEvent({ kind: 'mark-canceled' })]

type StopOwner = Readonly<{
  token: OwnershipToken | null
  ownerWithoutLocalToken: boolean
}>

export type AppliedSourceTerminationTarget = Readonly<{
  receipt: TaskSourceTerminationReceipt
  stopToken: OwnershipToken | null
  stopCause: TaskStopCause | null
  ownerWithoutLocalToken: boolean
  eventRefs: readonly TaskExecutionPostCommitEventRef[]
}>

async function readTarget(tx: TaskExecutionTransaction, taskId: string) {
  return (
    await tx
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
  )[0]
}

async function writeFence(
  tx: TaskExecutionTransaction,
  taskId: string,
  lifecycleRevision: number,
  fence: 'closed' | 'merged' | null,
  effectRevision: number,
): Promise<void> {
  const changed = await tx
    .update(tasks)
    .set({
      sourceTerminationFence: fence,
      sourceTerminationEffectRev: effectRevision,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.lifecycleEventRevision, lifecycleRevision)))
    .returning({ id: tasks.id })
  if (changed[0] === undefined) {
    throw new ConflictError(
      'concurrent-task-transition',
      `task ${taskId} changed during source fencing`,
    )
  }
}

async function cancelOpenNodeRuns(
  tx: TaskExecutionTransaction,
  taskId: string,
  now: number,
  cause: string,
): Promise<readonly TaskNodeChangeV1[]> {
  const rows = await tx
    .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), inArray(nodeRuns.status, CANCELABLE_NODE_STATUSES)))
  for (const row of rows) {
    await transitionNodeRunStatusTx({
      tx,
      nodeRunId: row.id,
      event: { kind: 'mark-canceled', reason: cause },
      extra: { finishedAt: now, errorMessage: cause },
    })
  }
  return rows.map((row) => ({ nodeRunId: row.id, nodeId: row.nodeId, status: 'canceled', cause }))
}

async function stopOwner(
  tx: TaskExecutionTransaction,
  taskId: string,
  runtimeRegistry: InMemoryTaskRuntimeRegistry,
  revoke?: Readonly<{ now: number; recoveryCode: string }>,
): Promise<StopOwner> {
  const owner = (
    await tx
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId))
      .limit(1)
  )[0]
  if (owner?.state !== 'claimed') return { token: null, ownerWithoutLocalToken: false }
  const token = runtimeRegistry.tokenForOwner(owner)
  if (revoke !== undefined) {
    await revokeExactOwnerInTx(tx, { owner, expectedRevision: owner.revision, ...revoke })
  }
  return { token, ownerWithoutLocalToken: token === null }
}

async function terminalizeCompanions(
  tx: TaskExecutionTransaction,
  taskId: string,
  runtimeRegistry: InMemoryTaskRuntimeRegistry,
  now: number,
  cause: string,
  recoveryCode: string,
) {
  const nodeChanges = await cancelOpenNodeRuns(tx, taskId, now, cause)
  const owner = await stopOwner(tx, taskId, runtimeRegistry, { now, recoveryCode })
  await terminalizeTaskExecutionIntentsInTx(tx, {
    taskId,
    state: 'canceled',
    failureCode: cause,
    now,
  })
  return { nodeChanges, owner }
}

export async function applySourceTerminationTarget(
  db: ProviderNeutralDatabase,
  runtimeRegistry: InMemoryTaskRuntimeRegistry,
  taskId: string,
  input: TaskSourceTerminationEffectInput,
): Promise<AppliedSourceTerminationTarget | null> {
  return await withTaskExecutionSerializable(db, async (tx) => {
    let row = await readTarget(tx, taskId)
    if (
      row === undefined ||
      row.launchRevision === null ||
      row.launchRevision >= input.streamRevision
    )
      return null
    const cause = terminalCause(input, row.parentTaskId)
    const eventRefs: TaskExecutionPostCommitEventRef[] = []
    const operationRef = `source-termination:${input.deliveryId}:${input.streamRevision}:${taskId}`

    if ((row.effectRevision ?? -1) >= input.streamRevision) {
      let owner: StopOwner = { token: null, ownerWithoutLocalToken: false }
      if (cause !== null) {
        const now = Date.now()
        const nodeChanges = await cancelOpenNodeRuns(
          tx,
          taskId,
          now,
          taskStopProjection(cause).code,
        )
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
        owner = await stopOwner(tx, taskId, runtimeRegistry)
      }
      // Reopen has no stop obligation, on first application or replay. A
      // still-running remote owner must not turn clear-closed into unreaped.
      return {
        receipt: {
          taskId,
          priorStatus: row.status,
          fenceOutcome: 'unchanged',
          cancelOutcome:
            cause === null
              ? 'not-applicable'
              : sourceTerminationTargetDisposition(row.status) === 'cancel'
                ? 'canceled'
                : 'already-terminal',
          releaseOutcome: cause === null ? 'not-required' : 'pending',
          errorCode: null,
        },
        stopToken: owner.token,
        stopCause: cause,
        ownerWithoutLocalToken: owner.ownerWithoutLocalToken,
        eventRefs,
      }
    }

    if (cause === null) {
      await writeFence(
        tx,
        taskId,
        row.lifecycleEventRevision,
        row.fence === 'closed' ? null : row.fence,
        input.streamRevision,
      )
      return {
        receipt: {
          taskId,
          priorStatus: row.status,
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

    let nextFence =
      row.fence === 'merged' || input.kind === 'fence-merged'
        ? ('merged' as const)
        : ('closed' as const)
    const projection = taskStopProjection(cause)
    const now = Date.now()
    let owner: StopOwner = { token: null, ownerWithoutLocalToken: false }
    let statusChanged = false
    let recoveryCode = 'terminal-control-source-terminal'
    if (sourceTerminationTargetDisposition(row.status) === 'cancel') {
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
      const changed = await writeTaskRuntimeLifecycleInTx(tx, {
        taskId,
        from: row.status,
        to: 'canceled',
        now,
        expectedLifecycleRevision: row.lifecycleEventRevision,
        workspacePruneDecision: prune,
        previousErrorSummary: row.errorSummary,
        extra: {
          finishedAt: now,
          errorSummary: projection.summary,
          errorMessage: `${projection.code}: delivery=${input.deliveryId} revision=${input.streamRevision}`,
          sourceTerminationFence: nextFence,
          sourceTerminationEffectRev: input.streamRevision,
        },
        onTransitionTx: async (transitionTx, _transition, collector) => {
          const completed = await terminalizeCompanions(
            transitionTx,
            taskId,
            runtimeRegistry,
            now,
            projection.code,
            'terminal-control-source',
          )
          owner = completed.owner
          collector.addNodeChanges(completed.nodeChanges)
        },
        sourceTerminationEffectRef: `source-termination:${input.deliveryId}:${input.streamRevision}`,
        committedEventIdentity: { operationRef },
      })
      if (changed !== null) {
        statusChanged = true
        if (changed.eventRef !== null) eventRefs.push(changed.eventRef)
      } else {
        // A task CAS miss has not run any companion. Reconcile a terminal
        // winner; all companion exceptions still escape and roll back the atom.
        const winner = await readTarget(tx, taskId)
        if (winner === undefined) return null
        if (sourceTerminationTargetDisposition(winner.status) === 'cancel') {
          throw new ConcurrentTaskTransition(
            taskId,
            CANCELABLE_TASK_STATUSES,
            `source-termination-${input.kind}`,
          )
        }
        row = winner
        nextFence = row.fence === 'merged' || nextFence === 'merged' ? 'merged' : 'closed'
        recoveryCode = 'terminal-control-source-race-winner'
      }
    }
    if (!statusChanged) {
      await writeFence(tx, taskId, row.lifecycleEventRevision, nextFence, input.streamRevision)
      const completed = await terminalizeCompanions(
        tx,
        taskId,
        runtimeRegistry,
        now,
        projection.code,
        recoveryCode,
      )
      owner = completed.owner
      if (completed.nodeChanges.length > 0) {
        const eventRef = await appendTaskNodeStatusesCommittedEvent(tx, {
          taskId,
          nodeChanges: completed.nodeChanges,
          occurredAt: now,
          identity: { operationRef },
        })
        if (eventRef !== null) eventRefs.push(eventRef)
      }
    }
    return {
      receipt: {
        taskId,
        priorStatus: row.status,
        fenceOutcome: nextFence === 'merged' ? 'fenced-merged' : 'fenced-closed',
        cancelOutcome:
          sourceTerminationTargetDisposition(row.status) === 'cancel'
            ? 'canceled'
            : 'already-terminal',
        releaseOutcome: 'pending',
        errorCode: null,
      },
      stopToken: owner.token,
      stopCause: cause,
      ownerWithoutLocalToken: owner.ownerWithoutLocalToken,
      eventRefs,
    }
  })
}
