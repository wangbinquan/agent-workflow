import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq, inArray } from 'drizzle-orm'
import type { TaskTriggerQueries } from '../application/ports/taskTriggerQueries'
import { taskReadColumns } from './taskRepositorySql'

/**
 * Webhook 消费的启动归属、状态与工作区投影。RFC-565：bootstrap 在装配期就建好这份读交给 integration，所以这里只在方法运行时才按句柄
 * 取表——构造不碰句柄（此前消费方每次调用现造一份，取表本来也发生在调用时）。
 */
export function createTaskTriggerQueries(db: PersistenceDb): TaskTriggerQueries {
  return {
    async frozenContext(taskId) {
      const { tasks } = tablesOf(db)
      return (
        await db
          .select({ triggerContextJson: taskReadColumns(db).triggerContextJson })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
      )[0]?.triggerContextJson
    },
    async workspaceAttribution(taskId: string) {
      const { tasks } = tablesOf(db)
      return (
        (
          await db
            .select({
              webhookTriggerId: taskReadColumns(db).webhookTriggerId,
              eventSubscriptionId: taskReadColumns(db).eventSubscriptionId,
            })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1)
        )[0] ?? null
      )
    },
    async findByOrigin(input: { readonly fireId: string; readonly eventDeliveryId?: string }) {
      const { tasks, taskLaunchContexts: launch } = tablesOf(db)
      return (
        (
          await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              input.eventDeliveryId === undefined
                ? inArray(
                    tasks.id,
                    db
                      .select({ taskId: launch.taskId })
                      .from(launch)
                      .where(eq(launch.webhookFireId, input.fireId)),
                  )
                : inArray(
                    tasks.id,
                    db
                      .select({ taskId: launch.taskId })
                      .from(launch)
                      .where(eq(launch.eventDeliveryId, input.eventDeliveryId)),
                  ),
            )
            .limit(1)
        )[0]?.id ?? null
      )
    },
    async status(taskId: string) {
      const { tasks } = tablesOf(db)
      return (
        (
          await db
            .select({ id: tasks.id, status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1)
        )[0] ?? null
      )
    },
    async terminalWorkspaces(taskIds: readonly string[]) {
      if (taskIds.length === 0) return []
      const { tasks } = tablesOf(db)
      return db
        .select({
          id: tasks.id,
          ownerUserId: tasks.ownerUserId,
          status: tasks.status,
          spaceKind: taskReadColumns(db).spaceKind,
          workspacePruningAt: tasks.workspacePruningAt,
          workspacePrunedAt: tasks.workspacePrunedAt,
        })
        .from(tasks)
        .where(inArray(tasks.id, [...taskIds]))
    },
  }
}
