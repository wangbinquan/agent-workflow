import { and, count, eq } from 'drizzle-orm'

import { agents, nodeRuns, tasks, workgroupTaskState } from '@/db/schema'
import { rowToAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { DwStateSchema } from '@agent-workflow/shared'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'

export class PostgresqlDynamicWorkflowPersistence implements DynamicWorkflowPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async loadTask(taskId: string) {
    const rows = await this.db
      .select({
        workgroupConfigJson: tasks.workgroupConfigJson,
        triggerContextJson: tasks.triggerContextJson,
        dwStateJson: workgroupTaskState.dwStateJson,
      })
      .from(tasks)
      .leftJoin(workgroupTaskState, eq(workgroupTaskState.taskId, tasks.id))
      .where(eq(tasks.id, taskId))
      .limit(1)
    return rows[0] ?? null
  }

  async loadAgent(agentId: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
    return rows[0] === undefined ? null : rowToAgent(rows[0])
  }

  async hasAwaitingConfirmationRun(taskId: string, cause: string): Promise<boolean> {
    const rows = await this.db
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
    return rows[0] !== undefined
  }

  async countNodeRuns(taskId: string, nodeId: string): Promise<number> {
    const rows = await this.db
      .select({ count: count() })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
      .limit(1)
    return Number(rows[0]?.count ?? 0)
  }

  async saveState(
    taskId: string,
    state: Parameters<DynamicWorkflowPersistence['saveState']>[1],
    now = Date.now(),
  ) {
    await this.db
      .update(workgroupTaskState)
      .set({ dwStateJson: JSON.stringify(DwStateSchema.parse(state)), updatedAt: now })
      .where(eq(workgroupTaskState.taskId, taskId))
      .run()
  }
}
