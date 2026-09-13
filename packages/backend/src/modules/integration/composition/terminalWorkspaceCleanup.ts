import type { ProviderNeutralDatabase } from '@/db/query'
import type { TerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { createWebhookTerminalWorkspacePrunePolicy } from '@/services/webhook/terminalWorkspaceCleanup'
import { createWebhookTerminalWorkspaceAttributionQueries } from '../infrastructure/terminalWorkspaceAttribution'

/**
 * RFC-359：这里此前是**两个函数体逐字相同**的孪生（`composeSqlite…` / `composePostgresql…`），
 * 唯一的差别是形参上那个 `db` 的声明类型——而它转交给的
 * `createWebhookTerminalWorkspaceAttributionQueries` 本来就收 `ProviderNeutralDatabase`。
 * 也就是说那不是「两台机器」，是同一台机器抄了两遍名字。收成一份。
 */
export function composeWebhookTerminalWorkspacePrunePolicy(input: {
  readonly db: ProviderNeutralDatabase
  readonly enabled: () => boolean
}): TerminalWorkspacePrunePolicy {
  return createWebhookTerminalWorkspacePrunePolicy({
    attribution: createWebhookTerminalWorkspaceAttributionQueries(input.db),
    enabled: input.enabled,
  })
}
