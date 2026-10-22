// RFC-359 W4-B1 —— 子任务预算查询：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import type { TaskStatus } from '@agent-workflow/shared'
import type { ChildTaskBudgetQueries } from '../application/ports/childTaskBudgetQueries'

const COUNTED_STATUSES: readonly TaskStatus[] = ['pending', 'running']

export class DrizzleChildTaskBudgetQueries implements ChildTaskBudgetQueries {
  constructor(private readonly db: PersistenceDb) {}

  async listCountedChildTaskIds(): Promise<readonly string[]> {
    const { tasks } = tablesOf(this.db)
    const rows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(isNotNull(tasks.parentTaskId), inArray(tasks.status, COUNTED_STATUSES as TaskStatus[])),
      )
    return rows.map((row) => row.id)
  }

  async isChildTask(taskId: string): Promise<boolean> {
    const { tasks } = tablesOf(this.db)
    const rows = await this.db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    return rows[0]?.parentTaskId != null
  }

  async parentTaskId(taskId: string): Promise<string | null> {
    const { tasks } = tablesOf(this.db)
    const rows = await this.db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    return rows[0]?.parentTaskId ?? null
  }
}
