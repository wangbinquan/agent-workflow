import { asc, desc, eq } from 'drizzle-orm'
import type { TaskFeedback } from '@agent-workflow/shared'
import { taskFeedback, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  NewTaskFeedbackRecord,
  TaskFeedbackStore,
} from '../application/ports/taskFeedbackStore'

interface TaskFeedbackRow {
  readonly id: string
  readonly taskId: string
  readonly authorUserId: string | null
  readonly bodyMd: string
  readonly createdAt: number
  readonly distilled: number
  readonly distillJobId: string | null
}

function rowToFeedback(row: TaskFeedbackRow): TaskFeedback {
  return {
    id: row.id,
    taskId: row.taskId,
    authorUserId: row.authorUserId,
    bodyMd: row.bodyMd,
    createdAt: row.createdAt,
    distilled: row.distilled === 1,
    distillJobId: row.distillJobId,
  }
}

export class PostgresqlTaskFeedbackStore implements TaskFeedbackStore {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async loadTaskIdentity(taskId: string) {
    const row = (
      await this.db
        .select({ id: tasks.id, ownerUserId: tasks.ownerUserId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    return row ?? null
  }

  async insert(input: NewTaskFeedbackRecord): Promise<void> {
    await this.db.insert(taskFeedback).values({ ...input, distilled: 0 })
  }

  async markDistilled(id: string, distillJobId: string): Promise<void> {
    await this.db
      .update(taskFeedback)
      .set({ distilled: 1, distillJobId })
      .where(eq(taskFeedback.id, id))
  }

  async getById(id: string): Promise<TaskFeedback | null> {
    const row = (
      await this.db.select().from(taskFeedback).where(eq(taskFeedback.id, id)).limit(1)
    )[0] as TaskFeedbackRow | undefined
    return row === undefined ? null : rowToFeedback(row)
  }

  async listByTask(taskId: string): Promise<readonly TaskFeedback[]> {
    const rows = (await this.db
      .select()
      .from(taskFeedback)
      .where(eq(taskFeedback.taskId, taskId))
      .orderBy(asc(taskFeedback.createdAt))) as TaskFeedbackRow[]
    return rows.map(rowToFeedback)
  }

  async listRecent(limit: number): Promise<readonly TaskFeedback[]> {
    const rows = (await this.db
      .select()
      .from(taskFeedback)
      .orderBy(desc(taskFeedback.createdAt))
      .limit(limit)) as TaskFeedbackRow[]
    return rows.map(rowToFeedback)
  }
}
