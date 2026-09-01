import { and, eq, isNull } from 'drizzle-orm'
import {
  IllegalMergeStateTransition,
  nextMergeState,
  type MergeStateOrNull,
} from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { MergeStateLifecyclePersistence } from '../application/ports/mergeStateLifecyclePersistence'
import { withTaskExecutionMutation } from './sqliteOwnedTaskMutation'

export class SqliteMergeStateLifecyclePersistence implements MergeStateLifecyclePersistence {
  constructor(private readonly db: DbClient) {}

  async transition(
    input: Parameters<MergeStateLifecyclePersistence['transition']>[0],
  ): ReturnType<MergeStateLifecyclePersistence['transition']> {
    const row = this.db
      .select({ mergeState: nodeRuns.mergeState, taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, input.nodeRunId))
      .get()
    if (row === undefined) {
      throw new NotFoundError('node-run-not-found', `node_run ${input.nodeRunId} not found`)
    }
    const from = (row.mergeState ?? null) as MergeStateOrNull
    const to = nextMergeState(from, input.event)
    const updated = withTaskExecutionMutation({
      db: this.db,
      taskId: row.taskId,
      ...(input.executionContext === undefined ? {} : { context: input.executionContext }),
      ...(input.now === undefined ? {} : { now: input.now }),
      run: (tx) =>
        tx
          .update(nodeRuns)
          .set({ mergeState: to, ...(input.extra ?? {}) })
          .where(
            and(
              eq(nodeRuns.id, input.nodeRunId),
              from === null ? isNull(nodeRuns.mergeState) : eq(nodeRuns.mergeState, from),
            ),
          )
          .returning({ id: nodeRuns.id })
          .all(),
    })
    if (updated.length === 0) {
      throw new ConflictError(
        'concurrent-merge-state-transition',
        `node_run ${input.nodeRunId} merge_state changed concurrently`,
      )
    }
    return { from, to }
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
