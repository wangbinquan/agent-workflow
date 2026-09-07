// RFC-303 — canonical task-owned source-termination application service.
//
// RFC-359 W10 —— 这里原来有三笔 bun:sqlite 专属的同步 `dbTxSync`（重放对账 / 终态 CAS 输给
// 别人后的补写 / 目标本就终态的直写），全部改走中立事务原语
// `databaseSessionFor(db).transaction(...)`，事务体里的四个参与者也各自换成两个引擎共用的
// 那一份：
//   · `cancelOpenNodeRunsTx` → 本文件的 `cancelOpenNodeRunsInTx`（同一张转移表、同一个
//     MR/PR 围栏判定，走中立的 `transitionNodeRunStatusTx`）；
//   · `appendTaskNodeStatusesCommittedEventTx` → `appendTaskNodeStatusesCommittedEvent`；
//   · `ownership.revokeExactTx` → `revokeExactOwnerInTx`；
//   · `terminalizeTaskExecutionIntentsTx` → `terminalizeTaskExecutionIntentsInTx`。
// 唯一留下的同步参与者是传给 `setTaskStatus` 的 `onTransitionTx` 回调——那笔事务的主体
// （`writeTaskStatusTx`）本身还是同步的，属另一刀（账本 `taskLifecycle.ts: 2` 那两笔）。
import { CANCELABLE_TASK_STATUSES, allowedFromStatusesForEvent } from '@agent-workflow/shared'
import type { TaskStatus } from '@agent-workflow/shared'
import { and, asc, eq, inArray, lt } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns, taskExecutionOwners, tasks } from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
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
import { terminalizeTaskExecutionIntentsInTx } from './taskExecutionIntentTerminalPersistence'
import { revokeExactOwnerInTx } from './taskOwnershipPersistence'
import { transitionNodeRunStatusTx as transitionNodeRunStatusInTransaction } from './nodeRunLifecycleTransition'
import type { RuntimeStopTicket } from '@/modules/task-execution/infrastructure/inMemoryTaskRuntimeRegistry'
import type { OwnershipToken } from '@/modules/task-execution/domain/ownership'
import { appendTaskNodeStatusesCommittedEvent } from './taskLifecycleCommittedEvents'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { CommittedEventRef } from '@/platform/events/committed/types'

// RFC-317 T51（LC-06）—— 从转移表派生，不再手抄。
const CANCELABLE: readonly TaskStatus[] = CANCELABLE_TASK_STATUSES
const CANCELABLE_NODE_RUN_STATUSES = allowedFromStatusesForEvent({ kind: 'mark-canceled' })

/**
 * RFC-359 W10 —— `cancelOpenNodeRunsTx` 的中立孪生：把任务下每一行还活着的 node_run 投影成
 * `canceled`，逐行走共享转移表（`transitionNodeRunStatusTx`）而不是一条 bulk UPDATE，于是
 * 终态覆写闸与 MR/PR 围栏判定与别处逐字同一份，并发改动会以
 * `ConcurrentNodeRunTransition` 让整笔回滚。调用方提交后才广播。
 */
async function cancelOpenNodeRunsInTx(
  tx: DatabaseTransaction,
  args: { readonly taskId: string; readonly finishedAt: number; readonly errorMessage: string },
): Promise<Array<{ id: string; nodeId: string }>> {
  const rows = await tx
    .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, args.taskId),
        inArray(nodeRuns.status, [...CANCELABLE_NODE_RUN_STATUSES]),
      ),
    )
  for (const row of rows) {
    await transitionNodeRunStatusInTransaction({
      tx,
      nodeRunId: row.id,
      event: { kind: 'mark-canceled', reason: args.errorMessage },
      extra: { finishedAt: args.finishedAt, errorMessage: args.errorMessage },
    })
  }
  return rows
}

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
    // RFC-359 W10 —— 事务**外**的这几条读/写原本也是 bun:sqlite 专属的同步面（`.all()[0]` /
    // 不 await 的 `.run()`）。它们不进同步事务面账本，但一样是「只有一个引擎跑得动」：PG 上
    // `.all()` 回的是 Promise（`[0]` 恒 undefined），`.run()` 回一个没人等的 Promise（语句静默
    // 不落）。补齐 await 之后 `applyOne` 除了还钉着的 `setTaskStatus` 取消分支以外都两个引擎共用。
    const row = (
      await db
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
    )[0]
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
        await databaseSessionFor(db).transaction(async (tx) => {
          const now = Date.now()
          canceledNodeRuns = await cancelOpenNodeRunsInTx(tx, {
            taskId,
            finishedAt: now,
            errorMessage: taskStopProjection(repeatedCause).code,
          })
          if (canceledNodeRuns.length > 0) {
            nodeEventRef = await appendTaskNodeStatusesCommittedEvent(tx, {
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
      await db
        .update(tasks)
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
        await db
          .update(tasks)
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
    /**
     * RFC-359 —— 终态 CAS 输给别人时**赢家**的状态。收据必须按它出，不能按本次开工前读到的
     * `priorStatus` 出：那样投递详情会记「本次把它取消了」，而任务实际是别人写成的 `done`。
     * PostgreSQL 侧没有这个坑——它整笔跑在 SERIALIZABLE 里，40001 之后重放整个 atom，
     * 第二遍读到的就是赢家的状态，于是 `priorStatus` / `cancelOutcome` 天然是对的。
     */
    let raceWinnerStatus: TaskStatus | null = null
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
        const winner = (
          await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
        )[0]
        if (winner !== undefined && CANCELABLE.includes(winner.status)) throw error
        raceWinnerStatus = winner?.status ?? null
        let nodeEventRef: CommittedEventRef | null = null
        await databaseSessionFor(db).transaction(async (tx) => {
          const now = Date.now()
          await tx
            .update(tasks)
            .set({
              sourceTerminationFence: nextFence,
              sourceTerminationEffectRev: input.streamRevision,
            })
            .where(eq(tasks.id, taskId))
            .run()
          const owner = (
            await tx
              .select()
              .from(taskExecutionOwners)
              .where(eq(taskExecutionOwners.taskId, taskId))
              .limit(1)
          )[0]
          if (owner?.state === 'claimed') {
            exactToken = taskExecutionModule.runtimeRegistry.tokenForOwner(owner)
            ownerWithoutLocalToken = exactToken === null
            await revokeExactOwnerInTx(tx, {
              owner,
              expectedRevision: owner.revision,
              now: Date.now(),
              recoveryCode: 'terminal-control-source-race-winner',
            })
          }
          await terminalizeTaskExecutionIntentsInTx(tx, {
            taskId,
            state: 'canceled',
            failureCode: projection.code,
            now,
          })
          canceledNodeRuns = await cancelOpenNodeRunsInTx(tx, {
            taskId,
            finishedAt: now,
            errorMessage: projection.code,
          })
          if (canceledNodeRuns.length > 0) {
            nodeEventRef = await appendTaskNodeStatusesCommittedEvent(tx, {
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
      await databaseSessionFor(db).transaction(async (tx) => {
        const now = Date.now()
        await tx
          .update(tasks)
          .set({
            sourceTerminationFence: nextFence,
            sourceTerminationEffectRev: input.streamRevision,
          })
          .where(eq(tasks.id, taskId))
          .run()
        const owner = (
          await tx
            .select()
            .from(taskExecutionOwners)
            .where(eq(taskExecutionOwners.taskId, taskId))
            .limit(1)
        )[0]
        if (owner?.state === 'claimed') {
          exactToken = taskExecutionModule.runtimeRegistry.tokenForOwner(owner)
          ownerWithoutLocalToken = exactToken === null
          await revokeExactOwnerInTx(tx, {
            owner,
            expectedRevision: owner.revision,
            now,
            recoveryCode: 'terminal-control-source-terminal',
          })
        }
        await terminalizeTaskExecutionIntentsInTx(tx, {
          taskId,
          state: 'canceled',
          failureCode: projection.code,
          now,
        })
        canceledNodeRuns = await cancelOpenNodeRunsInTx(tx, {
          taskId,
          finishedAt: now,
          errorMessage: projection.code,
        })
        if (canceledNodeRuns.length > 0) {
          nodeEventRef = await appendTaskNodeStatusesCommittedEvent(tx, {
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

    const effectivePriorStatus = raceWinnerStatus ?? priorStatus
    return {
      receipt: {
        taskId,
        priorStatus: effectivePriorStatus,
        fenceOutcome: nextFence === 'merged' ? 'fenced-merged' : 'fenced-closed',
        cancelOutcome:
          sourceTerminationTargetDisposition(effectivePriorStatus) === 'cancel'
            ? 'canceled'
            : 'already-terminal',
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
