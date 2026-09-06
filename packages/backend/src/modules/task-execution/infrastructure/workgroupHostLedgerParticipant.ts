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
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { createNodeRunMintParticipantInTx } from './nodeRunMintParticipant'

class WorkgroupHostLedgerConflict extends Error {
  constructor(readonly operationKey: string) {
    super(`workgroup host-ledger operation '${operationKey}' lost its fence`)
    this.name = 'WorkgroupHostLedgerConflict'
  }
}

async function loadSnapshot(
  transaction: DatabaseTransaction,
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
    leaderClarifyParked: leaderClarifyParkedOf(hostRows, askingNodeRunIds),
  }
}

/**
 * RFC-187 F3 —— 「领队自己在等人回答」的判据：**领队宿主 run** 上挂着一个未答的反问。
 *
 * 与成员反问的区别在于后果：成员反问会把它那张卡停成 `awaiting_human`（由 humanPending 抓到），
 * 而领队反问没有卡——不单独认这一条，驱动每轮都会再叫醒领队，于是它反复重问、孤儿出 N 个反问
 * 会话，最后撞 max_rounds。
 *
 * RFC-359 W4-D19c-tail：合一前这条住在 `legacy/workgroup/strategies/leaderWorker.ts` 的
 * `deriveLeaderClarifyPark`，按「会话的 sourceAgentNodeId 是领队且 status=awaiting_human」判；
 * 这里按 run id 连接（`askingNodeRunIds` 就是未答反问的提问 run 集合），判据同一条。
 */
export function leaderClarifyParkedOf(
  hostRuns: readonly Readonly<{ id: string; nodeId: string }>[],
  askingNodeRunIds: ReadonlySet<string>,
): boolean {
  return hostRuns.some(
    (run) => run.nodeId === WORKGROUP_TURN_LEADER_NODE_ID && askingNodeRunIds.has(run.id),
  )
}

async function applyOperation(
  transaction: DatabaseTransaction,
  taskId: string,
  operation: WorkgroupHostLedgerOperation,
): Promise<WorkgroupHostLedgerMintReceipt | null> {
  if (operation.kind === 'mint-host-run') {
    await createNodeRunMintParticipantInTx(transaction).mint({
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
export function createWorkgroupHostLedgerParticipantInTx(
  transaction: DatabaseTransaction,
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
