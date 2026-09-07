import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { composeRuntimeRegistryOperations } from '@/services/runtimeRegistry'
import type { RuntimeRegistryOperations } from './application/runtimeRegistryOperations'
export { initializeRuntimeRegistryBoot } from './application/runtimeRegistryBoot'
import { DrizzleRuntimeRegistryPersistence } from './infrastructure/runtimeRegistryPersistence'

export function composeSqliteRuntimeRegistryOperations(db: DbClient): RuntimeRegistryOperations {
  return composeRuntimeRegistryOperations(new DrizzleRuntimeRegistryPersistence(db))
}

export function composePostgresqlRuntimeRegistryOperations(
  db: PostgresqlDatabaseClient,
): RuntimeRegistryOperations {
  return composeRuntimeRegistryOperations(new DrizzleRuntimeRegistryPersistence(db))
}

export type { RuntimeRegistryOperations } from './application/runtimeRegistryOperations'
