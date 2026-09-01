import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlMcpProbeStore } from '../infrastructure/postgresqlMcpProbeStore'
import { createSqliteMcpProbeStore } from '../infrastructure/sqliteMcpProbeStore'
import type { McpProbeStore } from '../public/participants'

export function composeSqliteMcpProbeStore(db: DbClient): McpProbeStore {
  return createSqliteMcpProbeStore(db)
}

export function composePostgresqlMcpProbeStore(db: PostgresqlDatabaseClient): McpProbeStore {
  return createPostgresqlMcpProbeStore(db)
}
