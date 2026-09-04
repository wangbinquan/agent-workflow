// RFC-359 W4-B1 —— RFC-354 一次性 frame 回填的存储：一份实现，两个 provider 共用。

import { and, eq, isNull, sql } from 'drizzle-orm'
import { clarifyRounds, maintenanceState, nodeRuns, tasks } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { FRAME_BACKFILL_MARKER_KEY, type FrameBackfillStore } from '../application/frameBackfillJob'
import type { FrameBackfillRunRow, FrameBackfillUpdate } from '../domain/frameBackfill'

export function createFrameBackfillStore(db: ProviderNeutralDatabase): FrameBackfillStore {
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
      // 统一事务原语：SQLite 上是显式 BEGIN IMMEDIATE + 真回滚（裸 db.transaction 在 bun:sqlite 上零原子性）。
      await databaseSessionFor(db).transaction(async (tx) => {
        for (const update of updates) {
          await tx
            .update(nodeRuns)
            .set({ containerRunId: update.containerRunId, scopePath: update.scopePath })
            .where(eq(nodeRuns.id, update.id))
        }
      })
    },
    async alignClarifyRounds(taskId) {
      const rows = await db
        .update(clarifyRounds)
        .set({
          containerRunId: sql`(select ${nodeRuns.containerRunId} from ${nodeRuns} where ${nodeRuns.id} = ${clarifyRounds.intermediaryNodeRunId})`,
        })
        .where(
          and(
            eq(clarifyRounds.taskId, taskId),
            isNull(clarifyRounds.containerRunId),
            sql`exists (select 1 from ${nodeRuns} where ${nodeRuns.id} = ${clarifyRounds.intermediaryNodeRunId} and ${nodeRuns.containerRunId} is not null)`,
          ),
        )
        .returning({ id: clarifyRounds.id })
      return rows.length
    },
  }
}
