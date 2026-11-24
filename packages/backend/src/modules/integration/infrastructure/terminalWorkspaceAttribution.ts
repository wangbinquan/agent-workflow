// RFC-359 W4-B4 —— webhook 终态工作区归属查询：一份实现，两个 provider 共用。
// RFC-565：归属取自 Task Execution 的触发读——由 bootstrap 在根句柄上建好后交入，本文件不再拿句柄去造它。

import type { TaskTriggerQueries } from '@/modules/task-execution/public/queries'
import type { WebhookTerminalWorkspaceAttributionQueries } from '../application/ports/terminalWorkspaceAttribution'

export function createWebhookTerminalWorkspaceAttributionQueries(
  taskTriggers: Pick<TaskTriggerQueries, 'workspaceAttribution'>,
): WebhookTerminalWorkspaceAttributionQueries {
  return Object.freeze({
    async load(taskId: string) {
      return taskTriggers.workspaceAttribution(taskId)
    },
  })
}
