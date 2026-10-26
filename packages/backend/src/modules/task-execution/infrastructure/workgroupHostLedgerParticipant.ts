import { createRunSelectionReader } from './runSelection/table/reader'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { asc, and, eq, inArray, isNull } from 'drizzle-orm'
import { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
import { projectWorkgroupRunSelections } from './runSelection/workgroupProjection'
import { taskWorkgroupConfigSelection } from './taskWorkgroupConfig'

import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { generateNodeRunEnvelopeNonce } from '../application/buildNodeRunMintRecord'
import {
  type WorkgroupHostLedgerFailRunOperation,
  type WorkgroupHostLedgerMintReceipt,
  type WorkgroupHostLedgerOperation,
  type WorkgroupHostLedgerParticipantInTx,
  type WorkgroupHostLedgerSnapshot,
  type WorkgroupTaskRoomClarifyParticipantInTx,
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
} from '../public/commands'

import { setNodeRunStatusTx } from './nodeRunLifecycleTransition'
import { createNodeRunMintParticipantInTx } from './nodeRunMintParticipant'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import { assertTaskOwnerTx } from './ownedTaskExecution'
import { taskAggregateWrite } from './taskDefinitionWriteParticipant'

class WorkgroupHostLedgerConflict extends Error {
  constructor(readonly operationKey: string) {
    super(`workgroup host-ledger operation '${operationKey}' lost its fence`)
    this.name = 'WorkgroupHostLedgerConflict'
  }
}

async function loadSnapshot(
  transaction: PersistenceTx,
  clarify: WorkgroupTaskRoomClarifyParticipantInTx,
  taskId: string,
): Promise<WorkgroupHostLedgerSnapshot | null> {
  const { nodeRuns } = tablesOf(transaction)
  const { tasks } = tablesOf(transaction)
  const taskRows = await transaction
    .select({ workgroupConfig: taskWorkgroupConfigSelection(transaction) })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const task = taskRows[0]
  if (task === undefined) return null

  const [hostRows, clarifyProjection] = await Promise.all([
    transaction
      .select({
        id: nodeRuns.id,
        seq: nodeRuns.seq,
        nodeId: nodeRuns.nodeId,
        shardKey: nodeRuns.shardKey,
        status: nodeRuns.status,
        rerunCause: nodeRuns.rerunCause,
        retryIndex: nodeRuns.attemptIndex,
        wgRound: nodeRuns.wgRound,
        envelopeNonce: nodeRuns.envelopeNonce,
      })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.recordMode, 'executable'),
          inArray(nodeRuns.nodeId, [WORKGROUP_TURN_LEADER_NODE_ID, WORKGROUP_TURN_MEMBER_NODE_ID]),
        ),
      )
      .orderBy(asc(nodeRuns.seq)),
    clarify.loadProjection(taskId),
  ])
  const askingNodeRunIds = new Set(clarifyProjection.askingNodeRunIds)

  return {
    workgroupConfig: task.workgroupConfig,
    hostRuns: await projectWorkgroupRunSelections(
      hostRows.map((row) => {
        if (row.retryIndex === null || row.envelopeNonce === null)
          throw new Error(`workgroup-host-history-only:${row.id}`)
        return {
          id: row.id,
          seq: row.seq,
          nodeId: row.nodeId,
          shardKey: row.shardKey,
          status: row.status,
          rerunCause: row.rerunCause,
          retryIndex: row.retryIndex,
          wgRound: row.wgRound,
          envelopeNonce: row.envelopeNonce,
        }
      }),
      createRunSelectionReader(transaction),
      taskId,
    ),
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

/**
 * RFC-369 §4.4 —— 先点读，只有 pending 才走事务内生命周期 CAS 落 failed；其余状态空操作。
 * `setNodeRunStatusTx` 遇终态 / 不在 allowedFrom 会抛 ConflictError，把整笔提交带成 lost，所以不能直接调。
 * failureCode 留 NULL：封闭的 FAILURE_CODES 里没有「内部错误」这一档。
 */
async function failPendingHostRun(
  transaction: PersistenceTx,
  taskId: string,
  operation: WorkgroupHostLedgerFailRunOperation,
): Promise<boolean> {
  const { nodeRuns } = tablesOf(transaction)
  const rows = await transaction
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.id, operation.runId)))
    .limit(1)
  if (rows[0]?.status !== 'pending') return false
  await setNodeRunStatusTx({
    tx: transaction,
    nodeRunId: operation.runId,
    to: 'failed',
    allowedFrom: ['pending'],
    extra: {
      identity: {
        errorMessage: operation.message,
        finishedAt: Date.now(),
      },
    },
    reason: 'workgroup-host-turn-internal-error',
  })
  return true
}

async function applyOperation(
  transaction: PersistenceTx,
  taskId: string,
  operation: Exclude<WorkgroupHostLedgerOperation, WorkgroupHostLedgerFailRunOperation>,
): Promise<WorkgroupHostLedgerMintReceipt | null> {
  if (operation.kind === 'mint-host-run') {
    // Returning the inserted value avoids a SERIALIZABLE predicate read on
    // node_runs while sibling workgroup turns are inserting into the same page.
    const envelopeNonce = generateNodeRunEnvelopeNonce()
    await createNodeRunMintParticipantInTx(transaction).mint({
      ...nodeRunMintIdentityForSlot(
        operation.cause === 'wg-gate'
          ? {
              kind: 'synthetic',
              syntheticKind: 'wg-gate',
              owner: { kind: 'task', id: taskId },
              discriminator: operation.nodeId,
            }
          : { kind: 'workgroup-host', nodeId: operation.nodeId, shardKey: operation.shardKey },
        { kind: 'current' },
        envelopeNonce,
      ),
      id: operation.runId,
      taskId,
      nodeId: operation.nodeId,
      status: operation.status,
      cause: operation.cause,
      retryIndex: operation.retryIndex,
      overrides: {
        identity: {
          shardKey: operation.shardKey,
          wgRound: operation.wgRound,
        },
        config: {
          agentOverrideName: operation.agentOverrideName,
          agentOverrideId: operation.agentOverrideId,
        },
      },
    })
    return {
      operationKey: operation.operationKey,
      runId: operation.runId,
      envelopeNonce,
    }
  }

  operation.kind satisfies 'stamp-host-run-round'
  const { nodeRuns } = tablesOf(transaction)
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
  transaction: PersistenceTx,
  clarify: WorkgroupTaskRoomClarifyParticipantInTx,
): WorkgroupHostLedgerParticipantInTx {
  return Object.freeze({
    async lockTask(taskId: string) {
      const context = currentTaskExecutionContext(taskId)
      // Control-plane ledger writes remain allowed without an execution context.
      // An owned writer must fence before taking the root, never after a run write.
      if (context !== undefined) await assertTaskOwnerTx(transaction, context.token, Date.now())
      await taskAggregateWrite.lockTaskAggregateRoot(transaction, taskId)
    },
    load: (taskId: string) => loadSnapshot(transaction, clarify, taskId),
    async apply(input: Parameters<WorkgroupHostLedgerParticipantInTx['apply']>[0]) {
      try {
        const mintedRuns: WorkgroupHostLedgerMintReceipt[] = []
        const failedRunIds: string[] = []
        for (const operation of input.operations) {
          if (operation.kind === 'fail-host-run') {
            if (await failPendingHostRun(transaction, input.taskId, operation)) {
              failedRunIds.push(operation.runId)
            }
            continue
          }
          const minted = await applyOperation(transaction, input.taskId, operation)
          if (minted !== null) mintedRuns.push(minted)
        }
        return { committed: true as const, mintedRuns, failedRunIds }
      } catch (error) {
        if (error instanceof WorkgroupHostLedgerConflict) {
          return { committed: false as const, conflictOperationKey: error.operationKey }
        }
        throw error
      }
    },
  })
}
