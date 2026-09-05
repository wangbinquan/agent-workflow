import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { createWebhookTerminalWorkspacePrunePolicy } from '@/services/webhook/terminalWorkspaceCleanup'
import { createWebhookTerminalWorkspaceAttributionQueries } from '../infrastructure/terminalWorkspaceAttribution'

export function composeSqliteWebhookTerminalWorkspacePrunePolicy(input: {
  readonly db: DbClient
  readonly enabled: () => boolean
}): TerminalWorkspacePrunePolicy {
  return createWebhookTerminalWorkspacePrunePolicy({
    attribution: createWebhookTerminalWorkspaceAttributionQueries(input.db),
    enabled: input.enabled,
  })
}

export function composePostgresqlWebhookTerminalWorkspacePrunePolicy(input: {
  readonly db: PostgresqlDatabaseClient
  readonly enabled: () => boolean
}): TerminalWorkspacePrunePolicy {
  return createWebhookTerminalWorkspacePrunePolicy({
    attribution: createWebhookTerminalWorkspaceAttributionQueries(input.db),
    enabled: input.enabled,
  })
}
