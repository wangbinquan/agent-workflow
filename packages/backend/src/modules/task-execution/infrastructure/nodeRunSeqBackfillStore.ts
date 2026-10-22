// RFC-374: one transaction per task, conditional NULL updates, resumable allocation cleanup.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first, rawExec, rawRows } from '@/platform/persistence/queryHelpers'
import { and, asc, eq, isNotNull, isNull, max, min, sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { BOUNDED_DELETE_MAX_ROWS } from '@/platform/persistence/capabilities'
import {
  affectedRows,
  databaseSessionFor,
  engineOf,
} from '@/platform/persistence/databaseTransaction'
import type { NodeRunSeqBackfillStore } from '../application/ports/nodeRunSeqBackfillStore'
import { planNodeRunSeqBackfill } from '../domain/nodeRunSeqBackfill'

export function createNodeRunSeqBackfillStore(db: PersistenceDb): NodeRunSeqBackfillStore {
  return {
    async listTaskIds(limit) {
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .selectDistinct({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(isNull(nodeRuns.seq))
        .limit(limit)
      return rows.map((row) => row.taskId)
    },
    async backfillTask(taskId) {
      return databaseSessionFor(db).transaction(async (tx) => {
        const { nodeRuns, nodeRunSeqAllocations } = tablesOf(tx)
        const existing = await first(
          tx
            .select({ minSeq: min(nodeRuns.seq), maxId: max(nodeRuns.id) })
            .from(nodeRuns)
            .where(and(eq(nodeRuns.taskId, taskId), isNotNull(nodeRuns.seq))),
        )
        const missing = await tx
          .select({ id: nodeRuns.id })
          .from(nodeRuns)
          .where(and(eq(nodeRuns.taskId, taskId), isNull(nodeRuns.seq)))
        const plan = planNodeRunSeqBackfill(
          existing ?? { minSeq: null, maxId: null },
          missing.map((row) => row.id),
        )
        if (plan.kind === 'initial') {
          // Historical order is deliberately ID order, including rows never allocated by this binary.
          return affectedRows(
            await rawExec(
              tx,
              sql`
            WITH ranked AS (
              SELECT ${nodeRuns.id} AS id,
                ROW_NUMBER() OVER (ORDER BY ${nodeRuns.id}) - COUNT(*) OVER () AS seq
              FROM ${nodeRuns} WHERE ${nodeRuns.taskId} = ${taskId} AND ${nodeRuns.seq} IS NULL
            )
            UPDATE ${nodeRuns} SET "seq" = ranked.seq FROM ranked
            WHERE ${nodeRuns.id} = ranked.id AND ${nodeRuns.seq} IS NULL
          `,
            ),
          )
        }
        let changed = 0
        for (const row of plan.older) {
          changed += affectedRows(
            await tx
              .update(nodeRuns)
              .set({ seq: row.seq })
              .where(and(eq(nodeRuns.id, row.id), isNull(nodeRuns.seq))),
          )
        }
        for (const id of plan.newer) {
          const allocation = await first(
            tx
              .insert(nodeRunSeqAllocations)
              .values({ taskId, nodeRunId: id, allocatedAt: Date.now() })
              .returning({ seq: nodeRunSeqAllocations.seq }),
          )
          if (allocation === undefined) throw new Error('node-run-seq-allocation-missing')
          changed += affectedRows(
            await tx
              .update(nodeRuns)
              .set({ seq: allocation.seq })
              .where(and(eq(nodeRuns.id, id), isNull(nodeRuns.seq))),
          )
        }
        return changed
      })
    },
    async assertAllocatorCurrent() {
      const { nodeRuns, nodeRunSeqAllocations } = tablesOf(db)
      const runs = await first(db.select({ seq: max(nodeRuns.seq) }).from(nodeRuns))
      const allocated = await first(
        db.select({ seq: max(nodeRunSeqAllocations.seq) }).from(nodeRunSeqAllocations),
      )
      if ((runs?.seq ?? 0) > (allocated?.seq ?? 0)) throw new Error('node-run-seq-allocator-behind')
    },
    async pruneAllocations() {
      return databaseSessionFor(db).transaction(async (tx) => {
        const { nodeRunSeqAllocations } = tablesOf(tx)
        const candidates = sql`SELECT ${nodeRunSeqAllocations.seq} AS id FROM ${nodeRunSeqAllocations}
          WHERE ${nodeRunSeqAllocations.seq} < (SELECT MAX(${nodeRunSeqAllocations.seq}) FROM ${nodeRunSeqAllocations})
          ORDER BY ${asc(nodeRunSeqAllocations.seq)} LIMIT ${BOUNDED_DELETE_MAX_ROWS}`
        const rows = await rawRows(
          tx,
          engineOf(tx).deleteByCandidates(
            nodeRunSeqAllocations,
            nodeRunSeqAllocations.seq,
            candidates,
          ),
        )
        return rows.length
      })
    },
  }
}
