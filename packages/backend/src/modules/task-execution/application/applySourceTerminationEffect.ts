// RFC-303 — canonical task-owned source-termination application service.
import { CANCELABLE_TASK_STATUSES } from '@agent-workflow/shared'
import type { TaskStatus } from '@agent-workflow/shared'
import { and, asc, eq, lt } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
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
} from '@/modules/task-execution/public/participants'
import {
  awaitTaskDriverStopped,
  emitTaskStatus,
  finalizeCanceledTaskWithoutDriver,
  getTask,
  requestTaskDriverStop,
} from '@/services/task'
import { setTaskStatus } from '@/services/lifecycle'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { ConflictError } from '@/util/errors'

// RFC-317 T51（LC-06）—— 从转移表派生，不再手抄。
const CANCELABLE: readonly TaskStatus[] = CANCELABLE_TASK_STATUSES

type AppliedTarget = {
  receipt: TaskSourceTerminationReceipt
  stopCause: TaskStopCause | null
  statusChanged: boolean
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
        stopCause: terminalCause(input, row.parentTaskId),
        statusChanged: false,
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
        stopCause: null,
        statusChanged: false,
      }
    }

    const requestedFence = input.kind === 'fence-merged' ? 'merged' : 'closed'
    const nextFence = row.fence === 'merged' || requestedFence === 'merged' ? 'merged' : 'closed'
    const disposition = sourceTerminationTargetDisposition(priorStatus)
    const cause = terminalCause(input, row.parentTaskId)!
    const projection = taskStopProjection(cause)
    let statusChanged = false
    if (disposition === 'cancel') {
      try {
        await setTaskStatus({
          db,
          taskId,
          to: 'canceled',
          allowedFrom: CANCELABLE,
          extra: {
            finishedAt: Date.now(),
            errorSummary: projection.summary,
            errorMessage: `${projection.code}: delivery=${input.deliveryId} revision=${input.streamRevision}`,
            sourceTerminationFence: nextFence,
            sourceTerminationEffectRev: input.streamRevision,
          },
          reason: `source-termination-${input.kind}`,
        })
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
        db.update(tasks)
          .set({
            sourceTerminationFence: nextFence,
            sourceTerminationEffectRev: input.streamRevision,
          })
          .where(eq(tasks.id, taskId))
          .run()
      }
    } else {
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
        fenceOutcome: nextFence === 'merged' ? 'fenced-merged' : 'fenced-closed',
        cancelOutcome: disposition === 'cancel' ? 'canceled' : 'already-terminal',
        releaseOutcome: 'pending',
        errorCode: null,
      },
      stopCause: cause,
      statusChanged,
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
          if (applied.statusChanged) {
            const task = await getTask(db, row.id)
            if (task !== null) emitTaskStatus(task)
          }
          if (applied.stopCause !== null) {
            const ticket = requestTaskDriverStop(row.id, applied.stopCause)
            if (ticket === 'no-active-owner') {
              await finalizeCanceledTaskWithoutDriver(db, row.id)
              receipt = { ...receipt, releaseOutcome: 'no-active-owner' }
            } else {
              const stopped = await awaitTaskDriverStopped(ticket)
              receipt =
                stopped.kind === 'released'
                  ? { ...receipt, releaseOutcome: 'released' }
                  : {
                      ...receipt,
                      releaseOutcome: 'unreaped',
                      errorCode: stopped.code,
                    }
            }
          }
          receipts.set(row.id, receipt)
        }
      }
      return [...receipts.values()]
    },
  }
}
