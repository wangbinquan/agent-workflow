import type { TaskTriggerQueries } from '@/modules/task-execution/public/queries'
import type { TerminalWorkspacePrunePolicy } from '@/modules/task-execution/public/types'
import { createWebhookTerminalWorkspacePrunePolicy } from '../application/terminalWorkspaceCleanup'
import { createWebhookTerminalWorkspaceAttributionQueries } from '../infrastructure/terminalWorkspaceAttribution'

/**
 * RFC-359：这里此前是**两个函数体逐字相同**的孪生（`composeSqlite…` / `composePostgresql…`），
 * 唯一的差别是形参上那个 `db` 的声明类型——而它转交给的
 * `createWebhookTerminalWorkspaceAttributionQueries` 本来就收 `PersistenceDb`。
 * 也就是说那不是「两台机器」，是同一台机器抄了两遍名字。收成一份。
 *
 * RFC-565：入参由 `db` 换成 Task Execution 的触发读（bootstrap 在根句柄上建好后交入）——归属查询只读它的 `workspaceAttribution`，
 * 本模块不再拿句柄去造别的 context 的读。
 */
export function composeWebhookTerminalWorkspacePrunePolicy(input: {
  readonly taskTriggers: Pick<TaskTriggerQueries, 'workspaceAttribution'>
  readonly enabled: () => boolean | Promise<boolean>
}): TerminalWorkspacePrunePolicy {
  return createWebhookTerminalWorkspacePrunePolicy({
    attribution: createWebhookTerminalWorkspaceAttributionQueries(input.taskTriggers),
    enabled: input.enabled,
  })
}
