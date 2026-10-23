// RFC-359 W4-B4 —— webhook 终态工作区归属查询：一份实现，两个 provider 共用。

import { createTaskTriggerQueries } from '@/modules/task-execution/public/queries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WebhookTerminalWorkspaceAttributionQueries } from '../application/ports/terminalWorkspaceAttribution'

export function createWebhookTerminalWorkspaceAttributionQueries(
  db: PersistenceDb,
): WebhookTerminalWorkspaceAttributionQueries {
  return Object.freeze({
    async load(taskId: string) {
      return createTaskTriggerQueries(db).workspaceAttribution(taskId)
    },
  })
}
