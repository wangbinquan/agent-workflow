import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import type { TaskStatus } from '@agent-workflow/shared'
import { tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ChildTaskBudgetQueries } from '../application/ports/childTaskBudgetQueries'

const COUNTED_STATUSES: readonly TaskStatus[] = ['pending', 'running']

export class PostgresqlChildTaskBudgetQueries implements ChildTaskBudgetQueries {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async listCountedChildTaskIds(): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(isNotNull(tasks.parentTaskId), inArray(tasks.status, COUNTED_STATUSES as TaskStatus[])),
      )
    return rows.map((row) => row.id)
  }

  async isChildTask(taskId: string): Promise<boolean> {
    const rows = await this.db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    return rows[0]?.parentTaskId != null
  }

  async parentTaskId(taskId: string): Promise<string | null> {
    const rows = await this.db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    return rows[0]?.parentTaskId ?? null
  }
}
