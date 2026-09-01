import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import { nodeRuns, tasks } from '@/db/schema'
import type {
  WorkgroupHostLedgerMintReceipt,
  WorkgroupHostLedgerOperation,
  WorkgroupHostLedgerParticipantInTx,
  WorkgroupHostLedgerSnapshot,
  WorkgroupTaskRoomClarifyParticipantInTx,
} from '../public/commands'
import { WORKGROUP_TURN_LEADER_NODE_ID, WORKGROUP_TURN_MEMBER_NODE_ID } from '../public/commands'
import type { PostgresqlTaskExecutionTransaction } from './postgresqlTaskLifecycleTransaction'
import { createPostgresqlNodeRunMintParticipantInTx } from './postgresqlNodeRunMintParticipant'

class WorkgroupHostLedgerConflict extends Error {
  constructor(readonly operationKey: string) {
    super(`workgroup host-ledger operation '${operationKey}' lost its fence`)
    this.name = 'WorkgroupHostLedgerConflict'
  }
}

async function loadSnapshot(
  transaction: PostgresqlTaskExecutionTransaction,
  clarify: WorkgroupTaskRoomClarifyParticipantInTx,
  taskId: string,
): Promise<WorkgroupHostLedgerSnapshot | null> {
  const taskRows = await transaction
    .select({ workgroupConfigJson: tasks.workgroupConfigJson })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const task = taskRows[0]
  if (task === undefined) return null

  const [hostRows, clarifyProjection] = await Promise.all([
    transaction
      .select({
        id: nodeRuns.id,
        nodeId: nodeRuns.nodeId,
        shardKey: nodeRuns.shardKey,
        status: nodeRuns.status,
        rerunCause: nodeRuns.rerunCause,
        retryIndex: nodeRuns.retryIndex,
        wgRound: nodeRuns.wgRound,
        envelopeNonce: nodeRuns.envelopeNonce,
      })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          inArray(nodeRuns.nodeId, [WORKGROUP_TURN_LEADER_NODE_ID, WORKGROUP_TURN_MEMBER_NODE_ID]),
        ),
      )
      .orderBy(asc(nodeRuns.id)),
    clarify.loadProjection(taskId),
  ])
  const askingNodeRunIds = new Set(clarifyProjection.askingNodeRunIds)

  return {
    workgroupConfigJson: task.workgroupConfigJson,
    hostRuns: hostRows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      shardKey: row.shardKey,
      status: row.status,
      rerunCause: row.rerunCause,
      retryIndex: row.retryIndex,
      wgRound: row.wgRound,
      envelopeNonce: row.envelopeNonce ?? '',
    })),
    leaderClarifyParked: hostRows.some(
      (row) => row.nodeId === WORKGROUP_TURN_LEADER_NODE_ID && askingNodeRunIds.has(row.id),
    ),
  }
}

async function applyOperation(
  transaction: PostgresqlTaskExecutionTransaction,
  taskId: string,
  operation: WorkgroupHostLedgerOperation,
): Promise<WorkgroupHostLedgerMintReceipt | null> {
  if (operation.kind === 'mint-host-run') {
    await createPostgresqlNodeRunMintParticipantInTx(transaction).mint({
      id: operation.runId,
      taskId,
      nodeId: operation.nodeId,
      status: operation.status,
      cause: operation.cause,
      retryIndex: operation.retryIndex,
      overrides: {
        shardKey: operation.shardKey,
        agentOverrideName: operation.agentOverrideName,
        agentOverrideId: operation.agentOverrideId,
        wgRound: operation.wgRound,
      },
    })
    const mintedRows = await transaction
      .select({ envelopeNonce: nodeRuns.envelopeNonce })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.id, operation.runId)))
      .limit(1)
    const envelopeNonce = mintedRows[0]?.envelopeNonce
    if (envelopeNonce === null || envelopeNonce === undefined) {
      throw new WorkgroupHostLedgerConflict(operation.operationKey)
    }
    return {
      operationKey: operation.operationKey,
      runId: operation.runId,
      envelopeNonce,
    }
  }

  const changed = await transaction
    .update(nodeRuns)
    .set({ wgRound: operation.wgRound })
    .where(
      and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.id, operation.runId), isNull(nodeRuns.wgRound)),
    )
    .returning({ id: nodeRuns.id })
  if (changed.length === 1) return null
  const currentRows = await transaction
    .select({ wgRound: nodeRuns.wgRound })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.id, operation.runId)))
    .limit(1)
  if (currentRows[0]?.wgRound !== operation.wgRound) {
    throw new WorkgroupHostLedgerConflict(operation.operationKey)
  }
  return null
}

/** Bind TaskExecution host-ledger mechanics to one caller-reserved PG transaction. */
export function createPostgresqlWorkgroupHostLedgerParticipantInTx(
  transaction: PostgresqlTaskExecutionTransaction,
  clarify: WorkgroupTaskRoomClarifyParticipantInTx,
): WorkgroupHostLedgerParticipantInTx {
  return Object.freeze({
    load: (taskId: string) => loadSnapshot(transaction, clarify, taskId),
    async apply(input: Parameters<WorkgroupHostLedgerParticipantInTx['apply']>[0]) {
      try {
        const mintedRuns: WorkgroupHostLedgerMintReceipt[] = []
        for (const operation of input.operations) {
          const minted = await applyOperation(transaction, input.taskId, operation)
          if (minted !== null) mintedRuns.push(minted)
        }
        return { committed: true as const, mintedRuns }
      } catch (error) {
        if (error instanceof WorkgroupHostLedgerConflict) {
          return { committed: false as const, conflictOperationKey: error.operationKey }
        }
        throw error
      }
    },
  })
}
