import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createAgentImportQueries } from '../application/agents/agentImportQueries'
import { createPostgresqlAgentImportReferenceReadPort } from '../infrastructure/postgresqlAgentImportQueries'
import { createSqliteAgentImportReferenceReadPort } from '../infrastructure/sqliteAgentImportQueries'
import type { AgentImportQueries } from '../public/queries'

export function composeSqliteAgentImportQueries(db: DbClient): AgentImportQueries {
  return createAgentImportQueries(createSqliteAgentImportReferenceReadPort(db))
}

export function composePostgresqlAgentImportQueries(
  db: PostgresqlDatabaseClient,
): AgentImportQueries {
  return createAgentImportQueries(createPostgresqlAgentImportReferenceReadPort(db))
}
