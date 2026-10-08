import { and, asc, eq, inArray, gt } from 'drizzle-orm'
import { parseObservationCapturedUsage } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionObservationSources } from '@/db/schema'
import { systemAgentObservationSources } from '@/db/observationSystem'
import type {
  ObservationUsageSource,
  ObservationNativeHistorySource,
} from '@/modules/run-observability/public/participants'
import { createObservationSpanSources } from './observationSpanSources'
import {
  createCombinedObservationNativeScopes,
  createCombinedObservationNativeHistory,
} from './observationNativeSources'

/** Acks change delivery metadata only; runtime evidence and execution ownership stay intact. */
export function createObservationUsageSource(
  db: ProviderNeutralDatabase,
  historyPrepare?: ObservationNativeHistorySource['prepare'],
): ObservationUsageSource {
  return {
    nativeScopes: createCombinedObservationNativeScopes(db),
    ...(historyPrepare
      ? { nativeHistory: createCombinedObservationNativeHistory(db, historyPrepare) }
      : {}),
    spanSources: createObservationSpanSources(db),
    async pending(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)
        throw new RangeError('Observation source page must contain 1 through 500 rows')
      // Select one node at a time and wrap after the last node, even when its projection failed.
      // Ordering by stable node identity prevents a permanently broken FIFO head starving others.
      const selectNode = async (
        source: typeof taskExecutionObservationSources | typeof systemAgentObservationSources,
        after?: string,
      ) =>
        (
          await db
            .select({ id: source.nodeRunId })
            .from(source)
            .where(
              and(
                eq(source.pending, true),
                after === undefined ? undefined : gt(source.nodeRunId, after),
              ),
            )
            .orderBy(asc(source.nodeRunId))
            .limit(1)
            .get()
        )?.id
      const selectOriginal = async (after?: string) => {
        const candidates = []
        for (const kind of ['task', 'system'] as const) {
          const source =
            kind === 'system' ? systemAgentObservationSources : taskExecutionObservationSources
          const id = input.nodeRunId ?? (await selectNode(source, after))
          if (
            id !== undefined &&
            (input.nodeRunId === undefined ||
              (await db
                .select({ id: source.id })
                .from(source)
                .where(and(eq(source.pending, true), eq(source.nodeRunId, id)))
                .limit(1)
                .get()))
          )
            candidates.push({ id, kind, source })
        }
        return candidates.sort((a, b) => a.id.localeCompare(b.id))[0]
      }
      const selected = (await selectOriginal(input.afterNodeRunId)) ?? (await selectOriginal())
      if (!selected) return []
      const { id: nodeRunId, source } = selected
      const rows = await db
        .select({
          id: source.id,
          taskId: source.taskId,
          nodeRunId: source.nodeRunId,
          document: source.evidenceJson,
        })
        .from(source)
        .where(and(eq(source.pending, true), eq(source.nodeRunId, nodeRunId)))
        .orderBy(asc(source.id))
        .limit(input.limit)
        .all()
      return rows.map(({ document, ...row }) => ({
        ...row,
        ...(selected.kind === 'system' ? { sourceNamespace: 'system' as const } : {}),
        evidence: parseObservationCapturedUsage(JSON.parse(document!)),
      }))
    },
    async acknowledge(ids, namespace) {
      if (ids.length === 0) return
      if (ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
        throw new RangeError('Invalid observation acknowledgement')
      const source =
        namespace === 'system' ? systemAgentObservationSources : taskExecutionObservationSources
      await db
        .update(source)
        .set({ pending: false })
        .where(inArray(source.id, [...ids]))
        .run()
    },
  }
}
