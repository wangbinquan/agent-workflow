import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createMcpProbeStore } from '../infrastructure/mcpProbeStore'
import type { McpProbeStore } from '../public/participants'

export function composeSqliteMcpProbeStore(db: DbClient): McpProbeStore {
  return createMcpProbeStore(db)
}

export function composePostgresqlMcpProbeStore(db: PostgresqlDatabaseClient): McpProbeStore {
  return createMcpProbeStore(db)
}
