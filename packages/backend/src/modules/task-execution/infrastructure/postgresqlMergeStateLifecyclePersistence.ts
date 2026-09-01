import { and, eq, isNull } from 'drizzle-orm'
import {
  IllegalMergeStateTransition,
  nextMergeState,
  type MergeStateOrNull,
} from '@agent-workflow/shared'

import { nodeRuns } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { MergeStateLifecyclePersistence } from '../application/ports/mergeStateLifecyclePersistence'
import {
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

export class PostgresqlMergeStateLifecyclePersistence implements MergeStateLifecyclePersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async transition(
    input: Parameters<MergeStateLifecyclePersistence['transition']>[0],
  ): ReturnType<MergeStateLifecyclePersistence['transition']> {
    return await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      const rows = await tx
        .select({ mergeState: nodeRuns.mergeState, taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
      const row = rows[0]
      if (row === undefined) {
        throw new NotFoundError('node-run-not-found', `node_run ${input.nodeRunId} not found`)
      }
      if (input.executionContext === undefined) {
        await assertPostgresqlTaskOwnerlessTx(tx, row.taskId)
      } else {
        await assertPostgresqlTaskOwnerTx(tx, input.executionContext.token, input.now ?? Date.now())
      }
      const from = (row.mergeState ?? null) as MergeStateOrNull
      const to = nextMergeState(from, input.event)
      const updated = await tx
        .update(nodeRuns)
        .set({ mergeState: to, ...(input.extra ?? {}) })
        .where(
          and(
            eq(nodeRuns.id, input.nodeRunId),
            from === null ? isNull(nodeRuns.mergeState) : eq(nodeRuns.mergeState, from),
          ),
        )
        .returning({ id: nodeRuns.id })
      if (updated.length === 0) {
        throw new ConflictError(
          'concurrent-merge-state-transition',
          `node_run ${input.nodeRunId} merge_state changed concurrently`,
        )
      }
      return { from, to }
    })
  }

  async tryTransition(
    input: Parameters<MergeStateLifecyclePersistence['tryTransition']>[0],
  ): Promise<boolean> {
    try {
      await this.transition(input)
      return true
    } catch (error) {
      if (
        error instanceof ConflictError ||
        error instanceof NotFoundError ||
        error instanceof IllegalMergeStateTransition
      ) {
        return false
      }
      throw error
    }
  }
}
