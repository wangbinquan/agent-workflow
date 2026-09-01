import { eq } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { WebhookTerminalWorkspaceAttributionQueries } from '../application/ports/terminalWorkspaceAttribution'

export function createPostgresqlWebhookTerminalWorkspaceAttributionQueries(
  db: PostgresqlDatabaseClient,
): WebhookTerminalWorkspaceAttributionQueries {
  return Object.freeze({
    async load(taskId: string) {
      return (
        (await db
          .select({
            webhookTriggerId: tasks.webhookTriggerId,
            eventSubscriptionId: tasks.eventSubscriptionId,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .get()) ?? null
      )
    },
  })
}
