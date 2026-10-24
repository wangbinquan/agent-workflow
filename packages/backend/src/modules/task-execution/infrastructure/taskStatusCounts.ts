// RFC-395 II-b O3 — the shared owner of /health and Doctor task counts.
import { count, eq } from 'drizzle-orm'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type {
  TaskStatusCountQueries,
  TaskLifecycleCounts,
} from '../application/ports/taskStatusCounts'

export function createTaskStatusCounts(db: PersistenceDb): TaskStatusCountQueries {
  return Object.freeze({
    async countRunningTasks() {
      const { tasks } = tablesOf(db)
      const rows = await db.select({ n: count() }).from(tasks).where(eq(tasks.status, 'running'))
      return Number(rows[0]?.n ?? 0)
    },
  })
}

function safeDoctorCount(value: unknown): number {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

export function createTaskLifecycleCounts(): TaskLifecycleCounts {
  return {
    async countLifecycleStates(source) {
      // Dispatch on the native handle; each branch retains an exhaustive provider fence.
      if ('db' in source) {
        if (source.provider !== 'sqlite') return unhandledDatabaseProvider(source)
        const taskCount = (status: string): number =>
          (
            source.db.query('SELECT count(*) AS n FROM tasks WHERE status = ?').get(status) as {
              n: number
            }
          ).n
        return {
          interrupted: taskCount('interrupted'),
          failed: taskCount('failed'),
          awaitingReview: taskCount('awaiting_review'),
          awaitingHuman: taskCount('awaiting_human'),
          quarantined: (
            source.db
              .query('SELECT count(*) AS n FROM tasks WHERE auto_recovery_suspended = 1')
              .get() as { n: number }
          ).n,
        }
      }
      if (source.provider !== 'postgresql') return unhandledDatabaseProvider(source)
      const rows = await source.pool.unsafe(
        'SELECT ' +
          "count(*) FILTER (WHERE status = 'interrupted') AS interrupted, " +
          "count(*) FILTER (WHERE status = 'failed') AS failed, " +
          "count(*) FILTER (WHERE status = 'awaiting_review') AS awaiting_review, " +
          "count(*) FILTER (WHERE status = 'awaiting_human') AS awaiting_human, " +
          'count(*) FILTER (WHERE auto_recovery_suspended = TRUE) AS quarantined ' +
          'FROM agent_workflow.tasks',
      )
      const row = rows[0] ?? {}
      return {
        interrupted: safeDoctorCount(row.interrupted),
        failed: safeDoctorCount(row.failed),
        awaitingReview: safeDoctorCount(row.awaiting_review),
        awaitingHuman: safeDoctorCount(row.awaiting_human),
        quarantined: safeDoctorCount(row.quarantined),
      }
    },
  }
}
