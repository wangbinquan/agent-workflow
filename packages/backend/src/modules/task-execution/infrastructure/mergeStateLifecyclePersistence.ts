// RFC-359 W4-B1 —— node run merge_state 迁移：一份实现，两个 provider 共用；读 + CAS 写在同一事务里。

import { and, eq, isNull } from 'drizzle-orm'
import {
  IllegalMergeStateTransition,
  nextMergeState,
  type MergeStateOrNull,
} from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'

import { nodeRuns } from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { MergeStateLifecyclePersistence } from '../application/ports/mergeStateLifecyclePersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'

export class DrizzleMergeStateLifecyclePersistence implements MergeStateLifecyclePersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async transition(
    input: Parameters<MergeStateLifecyclePersistence['transition']>[0],
  ): ReturnType<MergeStateLifecyclePersistence['transition']> {
    return await withTaskExecutionWrite(this.db, async (tx) => {
      const rows = await tx
        .select({ mergeState: nodeRuns.mergeState, taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
      const row = rows[0]
      if (row === undefined) {
        throw new NotFoundError('node-run-not-found', `node_run ${input.nodeRunId} not found`)
      }
      await fenceTaskWrite(tx, {
        taskId: row.taskId,
        context: input.executionContext,
        ...(input.now === undefined ? {} : { now: input.now }),
      })
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
