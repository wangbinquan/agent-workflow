import { and, asc, eq, inArray, gt } from 'drizzle-orm'
import { parseObservationCapturedUsage } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionObservationSources } from '@/db/schema'
import type { ObservationUsageSource } from '@/modules/run-observability/public/participants'
import { createObservationSpanSources } from './observationSpanSources'
import { createObservationNativeScopes } from './observationNativeScopes'

/** Acks change delivery metadata only; runtime evidence and execution ownership stay intact. */
export function createObservationUsageSource(db: ProviderNeutralDatabase): ObservationUsageSource {
  return {
    nativeScopes: createObservationNativeScopes(db),
    spanSources: createObservationSpanSources(db),
    async pending(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)
        throw new RangeError('Observation source page must contain 1 through 500 rows')
      // Select one node at a time and wrap after the last node, even when its projection failed.
      // Ordering by stable node identity prevents a permanently broken FIFO head starving others.
      const selectNode = async (after?: string) =>
        (
          await db
            .select({ id: taskExecutionObservationSources.nodeRunId })
            .from(taskExecutionObservationSources)
            .where(
              and(
                eq(taskExecutionObservationSources.pending, true),
                after === undefined
                  ? undefined
                  : gt(taskExecutionObservationSources.nodeRunId, after),
              ),
            )
            .orderBy(asc(taskExecutionObservationSources.nodeRunId))
            .limit(1)
            .get()
        )?.id
      const nodeRunId =
        input.nodeRunId ?? (await selectNode(input.afterNodeRunId)) ?? (await selectNode())
      if (nodeRunId === undefined) return []
      const rows = await db
        .select({
          id: taskExecutionObservationSources.id,
          taskId: taskExecutionObservationSources.taskId,
          nodeRunId: taskExecutionObservationSources.nodeRunId,
          document: taskExecutionObservationSources.evidenceJson,
        })
        .from(taskExecutionObservationSources)
        .where(
          and(
            eq(taskExecutionObservationSources.pending, true),
            eq(taskExecutionObservationSources.nodeRunId, nodeRunId),
          ),
        )
        .orderBy(asc(taskExecutionObservationSources.id))
        .limit(input.limit)
        .all()
      return rows.map(({ document, ...row }) => ({
        ...row,
        evidence: parseObservationCapturedUsage(JSON.parse(document!)),
      }))
    },
    async acknowledge(ids) {
      if (ids.length === 0) return
      if (ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
        throw new RangeError('Invalid observation acknowledgement')
      await db
        .update(taskExecutionObservationSources)
        .set({ pending: false })
        .where(inArray(taskExecutionObservationSources.id, [...ids]))
        .run()
    },
  }
}
