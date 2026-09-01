import { and, eq, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { agents, nodeRuns, tasks, workgroupTaskState } from '@/db/schema'
import { rowToAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { DwStateSchema } from '@agent-workflow/shared'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'

export class SqliteDynamicWorkflowPersistence implements DynamicWorkflowPersistence {
  constructor(private readonly db: DbClient) {}

  async loadTask(taskId: string) {
    const row = this.db
      .select({
        workgroupConfigJson: tasks.workgroupConfigJson,
        triggerContextJson: tasks.triggerContextJson,
        dwStateJson: workgroupTaskState.dwStateJson,
      })
      .from(tasks)
      .leftJoin(workgroupTaskState, eq(workgroupTaskState.taskId, tasks.id))
      .where(eq(tasks.id, taskId))
      .get()
    return row === undefined ? null : row
  }

  async loadAgent(agentId: string) {
    const row = this.db.select().from(agents).where(eq(agents.id, agentId)).get()
    return row === undefined ? null : rowToAgent(row)
  }

  async hasAwaitingConfirmationRun(taskId: string, cause: string): Promise<boolean> {
    const row = this.db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.rerunCause, cause),
          eq(nodeRuns.status, 'awaiting_review'),
        ),
      )
      .limit(1)
      .get()
    return row !== undefined
  }

  async countNodeRuns(taskId: string, nodeId: string): Promise<number> {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
      .get()
    return Number(row?.count ?? 0)
  }

  async saveState(
    taskId: string,
    state: Parameters<DynamicWorkflowPersistence['saveState']>[1],
    now = Date.now(),
  ) {
    this.db
      .update(workgroupTaskState)
      .set({ dwStateJson: JSON.stringify(DwStateSchema.parse(state)), updatedAt: now })
      .where(eq(workgroupTaskState.taskId, taskId))
      .run()
  }
}
