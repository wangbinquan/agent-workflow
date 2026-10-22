// RFC-359 W4-B4 —— webhook 终态工作区归属查询：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WebhookTerminalWorkspaceAttributionQueries } from '../application/ports/terminalWorkspaceAttribution'

export function createWebhookTerminalWorkspaceAttributionQueries(
  db: PersistenceDb,
): WebhookTerminalWorkspaceAttributionQueries {
  return Object.freeze({
    async load(taskId: string) {
      const { tasks } = tablesOf(db)
      return (
        (
          await db
            .select({
              webhookTriggerId: tasks.webhookTriggerId,
              eventSubscriptionId: tasks.eventSubscriptionId,
            })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1)
        )[0] ?? null
      )
    },
  })
}
