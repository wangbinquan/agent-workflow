// RFC-395 II-b O3 — unchanged resource-limit queries and canceled-row reason write, owned by Task.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { decodeCallHumanWait, decodeResourceLimitTokenTotal } from '../domain/resourceLimitUsage'
import type {
  TaskResourceLimitFacts,
  ResourceLimitTask,
  ResourceLimitCallHumanWait,
  ResourceLimitTaskClock,
} from '../application/ports/taskResourceLimitFacts'

export function createTaskResourceLimitFacts(db: PersistenceDb): TaskResourceLimitFacts {
  return {
    async listRunningTasks(): Promise<ReadonlyArray<ResourceLimitTask>> {
      const { tasks } = tablesOf(db)
      return await db
        .select({
          id: tasks.id,
          maxDurationMs: tasks.maxDurationMs,
          maxTotalTokens: tasks.maxTotalTokens,
          runningMs: tasks.runningMs,
          runningSince: tasks.runningSince,
        })
        .from(tasks)
        .where(eq(tasks.status, 'running'))
    },

    async callHumanWaits(taskId: string): Promise<ReadonlyArray<ResourceLimitCallHumanWait>> {
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .select({
          childTaskId: nodeRuns.childTaskId,
          wrapperProgressJson: nodeRuns.wrapperProgressJson,
        })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), isNotNull(nodeRuns.childTaskId)))
      return rows.map((row) => ({
        childTaskId: row.childTaskId,
        ...decodeCallHumanWait(row.wrapperProgressJson),
      }))
    },

    async listTaskStatuses(taskIds: readonly string[]): Promise<ReadonlyArray<string>> {
      if (taskIds.length === 0) return []
      const { tasks } = tablesOf(db)
      return (
        await db
          .select({ status: tasks.status })
          .from(tasks)
          .where(inArray(tasks.id, [...taskIds]))
      ).map((row) => row.status)
    },

    async sumTaskTokens(taskId: string): Promise<number> {
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .select({ total: sql<number | null>`sum(${nodeRuns.tokTotal})` })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
      return decodeResourceLimitTokenTotal(rows[0]?.total)
    },

    async readTaskClock(taskId: string): Promise<ResourceLimitTaskClock | null> {
      const { tasks } = tablesOf(db)
      return (
        (await first(
          db
            .select({ runningMs: tasks.runningMs, runningSince: tasks.runningSince })
            .from(tasks)
            .where(eq(tasks.id, taskId)),
        )) ?? null
      )
    },

    async writeLimitReason(input: {
      readonly taskId: string
      readonly summary: string
      readonly message: string
    }): Promise<void> {
      const { tasks } = tablesOf(db)
      await db
        .update(tasks)
        .set({ errorSummary: input.summary, errorMessage: input.message })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.status, 'canceled')))
    },
  }
}
