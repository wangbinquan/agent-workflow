import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { composeRuntimeRegistryOperations } from '@/services/runtimeRegistry'
import type { RuntimeRegistryOperations } from './application/runtimeRegistryOperations'
export { initializeRuntimeRegistryBoot } from './application/runtimeRegistryBoot'
import { PostgresqlRuntimeRegistryPersistence } from './infrastructure/postgresqlRuntimeRegistryPersistence'
import { SqliteRuntimeRegistryPersistence } from './infrastructure/sqliteRuntimeRegistryPersistence'

export function composeSqliteRuntimeRegistryOperations(db: DbClient): RuntimeRegistryOperations {
  return composeRuntimeRegistryOperations(new SqliteRuntimeRegistryPersistence(db))
}

export function composePostgresqlRuntimeRegistryOperations(
  db: PostgresqlDatabaseClient,
): RuntimeRegistryOperations {
  return composeRuntimeRegistryOperations(new PostgresqlRuntimeRegistryPersistence(db))
}

export type { RuntimeRegistryOperations } from './application/runtimeRegistryOperations'
