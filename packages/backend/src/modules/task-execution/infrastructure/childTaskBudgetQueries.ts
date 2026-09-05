// RFC-359 W4-B1 —— 子任务预算查询：一份实现，两个 provider 共用。

import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'

import type { TaskStatus } from '@agent-workflow/shared'
import { tasks } from '@/db/schema'
import type { ChildTaskBudgetQueries } from '../application/ports/childTaskBudgetQueries'

const COUNTED_STATUSES: readonly TaskStatus[] = ['pending', 'running']

export class DrizzleChildTaskBudgetQueries implements ChildTaskBudgetQueries {
  constructor(private readonly db: ProviderNeutralDatabase) {}

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
