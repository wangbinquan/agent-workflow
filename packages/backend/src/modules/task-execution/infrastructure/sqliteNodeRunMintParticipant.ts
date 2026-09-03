import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import type { DbTxSync } from '@/db/txSync'
import { nodeRuns } from '@/db/schema'
import { buildNodeRunMintRecord } from '../application/buildNodeRunMintRecord'
import type { NodeRunMintInput } from '../application/ports/nodeRunLifecyclePersistence'
import { childScopePath } from '../domain/environmentChain'

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
      const record = buildNodeRunMintRecord(input)
      // RFC-354 — derive the breadcrumb from the generation row this row hangs
      // off; the record carries null exactly when the caller left it to us.
      let scopePath = record.scopePath
      if (scopePath === null) {
        const container =
          record.containerRunId === null
            ? undefined
            : tx
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
      // Prior generations of the SAME frame are superseded by this mint. The
      // frame is part of the key: a nested loop's round-0 row under outer
      // round 1 must never abandon the round-0 row under outer round 0.
      const priorIds = tx
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
