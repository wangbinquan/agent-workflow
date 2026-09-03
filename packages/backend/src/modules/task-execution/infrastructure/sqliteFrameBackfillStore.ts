// RFC-354 T4 — SQLite adapter for the one-shot frame backfill.

import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { clarifyRounds, maintenanceState, nodeRuns, tasks } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { FRAME_BACKFILL_MARKER_KEY, type FrameBackfillStore } from '../application/frameBackfillJob'
import type { FrameBackfillRunRow, FrameBackfillUpdate } from '../domain/frameBackfill'

export function createSqliteFrameBackfillStore(db: DbClient): FrameBackfillStore {
  return {
    async readMarker() {
      const rows = await db
        .select({ value: maintenanceState.value })
        .from(maintenanceState)
        .where(eq(maintenanceState.key, FRAME_BACKFILL_MARKER_KEY))
        .limit(1)
      return rows[0]?.value ?? null
    },
    async writeMarker(value) {
      const now = Date.now()
      await db
        .insert(maintenanceState)
        .values({ key: FRAME_BACKFILL_MARKER_KEY, value, updatedAt: now })
        .onConflictDoUpdate({
          target: maintenanceState.key,
          set: { value, updatedAt: now },
        })
    },
    async listTaskIds() {
      const rows = await db.selectDistinct({ taskId: nodeRuns.taskId }).from(nodeRuns)
      return rows.map((row) => row.taskId)
    },
    async loadTask(taskId) {
      const task = await db
        .select({ workflowSnapshot: tasks.workflowSnapshot })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      if (task[0] === undefined) return null
      const runs: FrameBackfillRunRow[] = await db
        .select({
          id: nodeRuns.id,
          nodeId: nodeRuns.nodeId,
          iteration: nodeRuns.iteration,
          parentNodeRunId: nodeRuns.parentNodeRunId,
          containerRunId: nodeRuns.containerRunId,
          scopePath: nodeRuns.scopePath,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
      return { workflowSnapshot: task[0].workflowSnapshot, runs }
    },
    async applyRunFrames(updates: readonly FrameBackfillUpdate[]) {
      dbTxSync(db, (tx) => {
        for (const update of updates) {
          tx.update(nodeRuns)
            .set({ containerRunId: update.containerRunId, scopePath: update.scopePath })
            .where(eq(nodeRuns.id, update.id))
            .run()
        }
      })
    },
    async alignClarifyRounds(taskId) {
      const stale = and(
        eq(clarifyRounds.taskId, taskId),
        isNull(clarifyRounds.containerRunId),
        sql`exists (select 1 from ${nodeRuns} where ${nodeRuns.id} = ${clarifyRounds.intermediaryNodeRunId} and ${nodeRuns.containerRunId} is not null)`,
      )
      const pending = await db.select({ id: clarifyRounds.id }).from(clarifyRounds).where(stale)
      if (pending.length === 0) return 0
      await db
        .update(clarifyRounds)
        .set({
          containerRunId: sql`(select ${nodeRuns.containerRunId} from ${nodeRuns} where ${nodeRuns.id} = ${clarifyRounds.intermediaryNodeRunId})`,
        })
        .where(stale)
      return pending.length
    },
  }
}
