import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import type { WebhookTerminalWorkspaceAttributionQueries } from '../application/ports/terminalWorkspaceAttribution'

export function createSqliteWebhookTerminalWorkspaceAttributionQueries(
  db: DbClient,
): WebhookTerminalWorkspaceAttributionQueries {
  return Object.freeze({
    async load(taskId: string) {
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
