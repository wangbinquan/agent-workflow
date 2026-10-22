// RFC-359 W4-B3 —— 任务反馈存储：一份实现，两个 provider 共用。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { asc, desc, eq } from 'drizzle-orm'
import type { TaskFeedback } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
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

export class DrizzleTaskFeedbackStore implements TaskFeedbackStore {
  constructor(private readonly db: PersistenceDb) {}

  async loadTaskIdentity(taskId: string) {
    const { tasks } = tablesOf(this.db)
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
    const { taskFeedback } = tablesOf(this.db)
    await insertOne(this.db, taskFeedback, { ...input, distilled: 0 })
  }

  async markDistilled(id: string, distillJobId: string): Promise<void> {
    const { taskFeedback } = tablesOf(this.db)
    await this.db
      .update(taskFeedback)
      .set({ distilled: 1, distillJobId })
      .where(eq(taskFeedback.id, id))
  }

  async getById(id: string): Promise<TaskFeedback | null> {
    const { taskFeedback } = tablesOf(this.db)
    const row = (
      await this.db.select().from(taskFeedback).where(eq(taskFeedback.id, id)).limit(1)
    )[0] as TaskFeedbackRow | undefined
    return row === undefined ? null : rowToFeedback(row)
  }

  async listByTask(taskId: string): Promise<readonly TaskFeedback[]> {
    const { taskFeedback } = tablesOf(this.db)
    const rows = (await this.db
      .select()
      .from(taskFeedback)
      .where(eq(taskFeedback.taskId, taskId))
      .orderBy(asc(taskFeedback.createdAt))) as TaskFeedbackRow[]
    return rows.map(rowToFeedback)
  }

  async listRecent(limit: number): Promise<readonly TaskFeedback[]> {
    const { taskFeedback } = tablesOf(this.db)
    const rows = (await this.db
      .select()
      .from(taskFeedback)
      .orderBy(desc(taskFeedback.createdAt))
      .limit(limit)) as TaskFeedbackRow[]
    return rows.map(rowToFeedback)
  }
}
