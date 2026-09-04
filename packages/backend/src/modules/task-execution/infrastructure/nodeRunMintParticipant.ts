// RFC-359 —— node_runs 的铸造参与者：一份实现，两个引擎。
//
// 此前 `sqliteNodeRunMintParticipant.ts`（同步）与 `postgresqlNodeRunMintParticipant.ts`（异步）
// 是逐字相同的 SQL 抄两遍。这里是唯一的 async 版本；同步版本在其余 dbTxSync 调用方迁完之前保留
// （RFC-098 的 node_runs INSERT 守卫同时登记这两处 canonical writer）。

import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import { nodeRuns } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { buildNodeRunMintRecord } from '../application/buildNodeRunMintRecord'
import type { NodeRunMintInput } from '../application/ports/nodeRunLifecyclePersistence'
import { childScopePath } from '../domain/environmentChain'

const ABANDONABLE_MERGE_STATES = [
  'isolating',
  'pending-merge',
  'conflict-agent',
  'conflict-human',
] as const

/** 在调用方已持有的事务里铸造 node_runs 行。 */
export interface NodeRunMintParticipantInTx {
  mint(input: NodeRunMintInput): Promise<string>
}

export function createNodeRunMintParticipantInTx(
  tx: DatabaseTransaction,
): NodeRunMintParticipantInTx {
  return Object.freeze({
    async mint(input: NodeRunMintInput) {
      const record = buildNodeRunMintRecord(input)
      // RFC-354 — derive the breadcrumb from the generation row this row hangs
      // off; the record carries null exactly when the caller left it to us.
      let scopePath = record.scopePath
      if (scopePath === null) {
        const container =
          record.containerRunId === null
            ? undefined
            : await tx
                .select({ nodeId: nodeRuns.nodeId, scopePath: nodeRuns.scopePath })
                .from(nodeRuns)
                .where(eq(nodeRuns.id, record.containerRunId))
                .get()
        scopePath =
          container === undefined
            ? ''
            : childScopePath(container.scopePath, container.nodeId, record.iteration)
      }
      const values = { ...record, scopePath }
      // Prior generations of the SAME frame are superseded by this mint. The frame is part of
      // the key: a nested loop's round-0 row under outer round 1 must never abandon the round-0
      // row under outer round 0.
      const priorRows = await tx
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, values.taskId),
            eq(nodeRuns.nodeId, values.nodeId),
            eq(nodeRuns.iteration, values.iteration),
            values.containerRunId === null
              ? isNull(nodeRuns.containerRunId)
              : eq(nodeRuns.containerRunId, values.containerRunId),
            isNull(nodeRuns.parentNodeRunId),
            lt(nodeRuns.id, values.id),
            ...(values.shardKey === null ? [] : [eq(nodeRuns.shardKey, values.shardKey)]),
          ),
        )
      const priorIds = priorRows.map((row) => row.id)
      if (priorIds.length > 0) {
        await tx
          .update(nodeRuns)
          .set({ mergeState: 'abandoned' })
          .where(
            and(
              eq(nodeRuns.taskId, values.taskId),
              inArray(nodeRuns.mergeState, [...ABANDONABLE_MERGE_STATES]),
              or(inArray(nodeRuns.id, priorIds), inArray(nodeRuns.parentNodeRunId, priorIds)),
            ),
          )
          .run()
      }
      await tx.insert(nodeRuns).values(values).run()
      return values.id
    },
  })
}
