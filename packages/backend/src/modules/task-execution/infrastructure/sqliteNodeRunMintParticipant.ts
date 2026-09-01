import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import type { DbTxSync } from '@/db/txSync'
import { nodeRuns } from '@/db/schema'
import { buildNodeRunMintRecord } from '../application/buildNodeRunMintRecord'
import type { NodeRunMintInput } from '../application/ports/nodeRunLifecyclePersistence'

const ABANDONABLE_MERGE_STATES = [
  'isolating',
  'pending-merge',
  'conflict-agent',
  'conflict-human',
] as const

/** Provider-private participant for an already-reserved SQLite transaction. */
export interface SqliteNodeRunMintParticipantInTx {
  mint(input: NodeRunMintInput): string
}

export function createSqliteNodeRunMintParticipantInTx(
  tx: DbTxSync,
): SqliteNodeRunMintParticipantInTx {
  return Object.freeze({
    mint(input: NodeRunMintInput) {
      const values = buildNodeRunMintRecord(input)
      const priorIds = tx
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, values.taskId),
            eq(nodeRuns.nodeId, values.nodeId),
            eq(nodeRuns.iteration, values.iteration),
            isNull(nodeRuns.parentNodeRunId),
            lt(nodeRuns.id, values.id),
            ...(values.shardKey === null ? [] : [eq(nodeRuns.shardKey, values.shardKey)]),
          ),
        )
        .all()
        .map((row) => row.id)
      if (priorIds.length > 0) {
        tx.update(nodeRuns)
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
      tx.insert(nodeRuns).values(values).run()
      return values.id
    },
  })
}
