import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { createWebhookTerminalWorkspacePrunePolicy } from '@/services/webhook/terminalWorkspaceCleanup'
import { createPostgresqlWebhookTerminalWorkspaceAttributionQueries } from '../infrastructure/postgresqlTerminalWorkspaceAttribution'
import { createSqliteWebhookTerminalWorkspaceAttributionQueries } from '../infrastructure/sqliteTerminalWorkspaceAttribution'

export function composeSqliteWebhookTerminalWorkspacePrunePolicy(input: {
  readonly db: DbClient
  readonly enabled: () => boolean
}): TerminalWorkspacePrunePolicy {
  return createWebhookTerminalWorkspacePrunePolicy({
    attribution: createSqliteWebhookTerminalWorkspaceAttributionQueries(input.db),
    enabled: input.enabled,
  })
}

export function composePostgresqlWebhookTerminalWorkspacePrunePolicy(input: {
  readonly db: PostgresqlDatabaseClient
  readonly enabled: () => boolean
}): TerminalWorkspacePrunePolicy {
  return createWebhookTerminalWorkspacePrunePolicy({
    attribution: createPostgresqlWebhookTerminalWorkspaceAttributionQueries(input.db),
    enabled: input.enabled,
  })
}
