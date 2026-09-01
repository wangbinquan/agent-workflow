import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { McpRuntimeTestPersistence } from '../application/mcps/runtimeTestPersistence'
import { createPostgresqlMcpRuntimeTestLeaseOperations } from '../infrastructure/postgresqlMcpRuntimeTestLease'
import { createPostgresqlMcpRuntimeTestPersistence } from '../infrastructure/postgresqlMcpRuntimeTestPersistence'
export { createPostgresqlMcpTransactionLifecycle } from '../infrastructure/postgresqlMcpTransactionLifecycle'
import { createSqliteMcpRuntimeTestLeaseOperations } from '../infrastructure/sqliteMcpRuntimeTestLease'
import { createSqliteMcpRuntimeTestPersistence } from '../infrastructure/sqliteMcpRuntimeTestPersistence'
import type { McpRuntimeTestLeaseOperations } from '../public/participants'

export interface McpRuntimeTestProviderPersistence {
  readonly persistence: McpRuntimeTestPersistence
  readonly leaseOperations: McpRuntimeTestLeaseOperations
}

export function composeSqliteMcpRuntimeTestPersistence(db: DbClient): McpRuntimeTestPersistence {
  return createSqliteMcpRuntimeTestPersistence(db)
}

export function composePostgresqlMcpRuntimeTestPersistence(
  db: PostgresqlDatabaseClient,
): McpRuntimeTestPersistence {
  return createPostgresqlMcpRuntimeTestPersistence(db)
}

export function composeSqliteMcpRuntimeTestProvider(
  db: DbClient,
): McpRuntimeTestProviderPersistence {
  return Object.freeze({
    persistence: composeSqliteMcpRuntimeTestPersistence(db),
    leaseOperations: createSqliteMcpRuntimeTestLeaseOperations(db),
  })
}

export function composePostgresqlMcpRuntimeTestProvider(
  db: PostgresqlDatabaseClient,
): McpRuntimeTestProviderPersistence {
  return Object.freeze({
    persistence: composePostgresqlMcpRuntimeTestPersistence(db),
    leaseOperations: createPostgresqlMcpRuntimeTestLeaseOperations(db),
  })
}
