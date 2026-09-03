import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import { nodeRuns } from '@/db/schema'
import { buildNodeRunMintRecord } from '../application/buildNodeRunMintRecord'
import { childScopePath } from '../domain/environmentChain'
import type { NodeRunMintInput } from '../application/ports/nodeRunLifecyclePersistence'
import type { PostgresqlTaskExecutionTransaction } from './postgresqlTaskLifecycleTransaction'

const ABANDONABLE_MERGE_STATES = [
  'isolating',
  'pending-merge',
  'conflict-agent',
  'conflict-human',
] as const

/** Provider-private participant for an already-reserved PostgreSQL transaction. */
export interface PostgresqlNodeRunMintParticipantInTx {
  mint(input: NodeRunMintInput): Promise<string>
}

export function createPostgresqlNodeRunMintParticipantInTx(
  tx: PostgresqlTaskExecutionTransaction,
): PostgresqlNodeRunMintParticipantInTx {
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
            : (
                await tx
                  .select({ nodeId: nodeRuns.nodeId, scopePath: nodeRuns.scopePath })
                  .from(nodeRuns)
                  .where(eq(nodeRuns.id, record.containerRunId))
                  .limit(1)
              )[0]
        scopePath =
          container === undefined
            ? ''
            : childScopePath(container.scopePath, container.nodeId, record.iteration)
      }
      const values = { ...record, scopePath }
      // Prior generations of the SAME frame are superseded by this mint (frame
      // is part of the key — see the SQLite twin).
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
