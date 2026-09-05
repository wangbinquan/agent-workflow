import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { McpRuntimeTestPersistence } from '../application/mcps/runtimeTestPersistence'
import { createMcpRuntimeTestPersistence } from '../infrastructure/mcpRuntimeTestPersistence'
export { createPostgresqlMcpTransactionLifecycle } from '../infrastructure/postgresqlMcpTransactionLifecycle'
import { createMcpRuntimeTestLeaseOperations } from '../infrastructure/mcpRuntimeTestLease'
import type { McpRuntimeTestLeaseOperations } from '../public/participants'

export interface McpRuntimeTestProviderPersistence {
  readonly persistence: McpRuntimeTestPersistence
  readonly leaseOperations: McpRuntimeTestLeaseOperations
}

export function composeSqliteMcpRuntimeTestPersistence(db: DbClient): McpRuntimeTestPersistence {
  return createMcpRuntimeTestPersistence(db)
}

export function composePostgresqlMcpRuntimeTestPersistence(
  db: PostgresqlDatabaseClient,
): McpRuntimeTestPersistence {
  return createMcpRuntimeTestPersistence(db)
}

export function composeSqliteMcpRuntimeTestProvider(
  db: DbClient,
): McpRuntimeTestProviderPersistence {
  return Object.freeze({
    persistence: composeSqliteMcpRuntimeTestPersistence(db),
    leaseOperations: createMcpRuntimeTestLeaseOperations(db),
  })
}

export function composePostgresqlMcpRuntimeTestProvider(
  db: PostgresqlDatabaseClient,
): McpRuntimeTestProviderPersistence {
  return Object.freeze({
    persistence: composePostgresqlMcpRuntimeTestPersistence(db),
    leaseOperations: createMcpRuntimeTestLeaseOperations(db),
  })
}
