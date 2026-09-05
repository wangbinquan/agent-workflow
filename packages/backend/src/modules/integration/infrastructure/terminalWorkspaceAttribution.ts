// RFC-359 W4-B4 —— webhook 终态工作区归属查询：一份实现，两个 provider 共用。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import type { WebhookTerminalWorkspaceAttributionQueries } from '../application/ports/terminalWorkspaceAttribution'

export function createWebhookTerminalWorkspaceAttributionQueries(
  db: ProviderNeutralDatabase,
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
