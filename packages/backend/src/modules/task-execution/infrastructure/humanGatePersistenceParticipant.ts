// RFC-395 II-a A7：保留人工门原有的同事务写入与 CAS，存储归执行域。
import { and, eq } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { HumanGatePersistenceParticipantInTx } from '../application/ports/humanGatePersistenceParticipant'

/** 只迁移既有调用点的聚合锁，不增加检查或另开事务。 */
async function lockTaskForHumanGateInTx(tx: PersistenceTx, taskId: string): Promise<void> {
  const { tasks } = tablesOf(tx)
  await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, taskId)
}

async function completeClarifyRunInTx(
  tx: PersistenceTx,
  runId: string,
  now: number,
): Promise<void> {
  const { nodeRuns } = tablesOf(tx)
  // rfc053-allow-direct-status-write -- atomic clarify-node close on full seal
  await tx
    .update(nodeRuns)
    .set({ status: 'done', finishedAt: now })
    .where(and(eq(nodeRuns.id, runId), eq(nodeRuns.status, 'awaiting_human')))
}

async function cancelClarifyRunInTx(
  tx: PersistenceTx,
  input: {
    readonly runId: string
    readonly now: number
    readonly cause: string
  },
): Promise<boolean> {
  const { nodeRuns } = tablesOf(tx)
  // rfc053-allow-direct-status-write -- provider terminal-sweep CAS
  const rows = await tx
    .update(nodeRuns)
    .set({ status: 'canceled', finishedAt: input.now, errorMessage: input.cause })
    .where(and(eq(nodeRuns.id, input.runId), eq(nodeRuns.status, 'awaiting_human')))
    .returning({ id: nodeRuns.id })
  if (rows.length > 0) return true
  await tx
    .update(nodeRuns)
    .set({ errorMessage: input.cause })
    .where(and(eq(nodeRuns.id, input.runId), eq(nodeRuns.status, 'canceled')))
  return false
}

async function cancelTaskGateRunsInTx(
  tx: PersistenceTx,
  input: {
    readonly taskId: string
    readonly now: number
    readonly cause: string
  },
): Promise<{ nodeRunId: string; nodeId: string }[]> {
  const { nodeRuns } = tablesOf(tx)
  const canceled: { nodeRunId: string; nodeId: string }[] = []
  for (const status of ['awaiting_human', 'awaiting_review'] as const) {
    // rfc053-allow-direct-status-write -- provider terminal-sweep CAS
    const rows = await tx
      .update(nodeRuns)
      .set({ status: 'canceled', finishedAt: input.now, errorMessage: input.cause })
      .where(and(eq(nodeRuns.taskId, input.taskId), eq(nodeRuns.status, status)))
      .returning({ nodeRunId: nodeRuns.id, nodeId: nodeRuns.nodeId })
    canceled.push(...rows)
  }
  return canceled
}

/** 未提供 kind/archive 时保留原值；冲突更新不改变 active。 */
async function writeReviewOutputInTx(
  tx: PersistenceTx,
  input: {
    readonly nodeRunId: string
    readonly portName: string
    readonly content: string
    readonly kind?: string | null
    readonly archiveJson?: string | null
  },
): Promise<void> {
  const { nodeRunOutputs } = tablesOf(tx)
  const { nodeRunId, portName, ...content } = input
  await tx
    .insert(nodeRunOutputs)
    .values({ nodeRunId, portName, ...content })
    .onConflictDoUpdate({
      target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
      set: content,
    })
}

async function transferTaskOwnerInTx(
  tx: PersistenceTx,
  taskId: string,
  ownerUserId: string | null,
): Promise<void> {
  const { tasks } = tablesOf(tx)
  await tx.update(tasks).set({ ownerUserId }).where(eq(tasks.id, taskId))
}

async function appendHumanGateTextEventInTx(
  tx: PersistenceTx,
  input: {
    readonly nodeRunId: string
    readonly ts: number
    readonly payload: string
  },
): Promise<void> {
  const { nodeRunEvents } = tablesOf(tx)
  await insertOne(tx, nodeRunEvents, { ...input, kind: 'text' })
}

/** 七项操作绑定同一个事务，不增加事务或改变既有 SQL。 */
export function createHumanGatePersistenceParticipantInTx(
  tx: PersistenceTx,
): HumanGatePersistenceParticipantInTx {
  return {
    lockTask(taskId) {
      return lockTaskForHumanGateInTx(tx, taskId)
    },
    completeClarifyRun(runId, now) {
      return completeClarifyRunInTx(tx, runId, now)
    },
    cancelClarifyRun(input) {
      return cancelClarifyRunInTx(tx, input)
    },
    cancelTaskGateRuns(input) {
      return cancelTaskGateRunsInTx(tx, input)
    },
    writeReviewOutput(input) {
      return writeReviewOutputInTx(tx, input)
    },
    transferTaskOwner(taskId, ownerUserId) {
      return transferTaskOwnerInTx(tx, taskId, ownerUserId)
    },
    appendTextEvent(input) {
      return appendHumanGateTextEventInTx(tx, input)
    },
  }
}
