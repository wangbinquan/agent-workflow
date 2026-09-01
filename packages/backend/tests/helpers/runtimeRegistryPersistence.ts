import type { DbClient } from '@/db/client'
import type { RuntimeRegistryPersistence } from '@/platform/runtime-registry/application/runtimeRegistryOperations'
import { SqliteRuntimeRegistryPersistence } from '@/platform/runtime-registry/infrastructure/sqliteRuntimeRegistryPersistence'

/** Bind legacy service-level runtime-registry tests to the explicit SQLite provider. */
export function runtimeRegistryPersistence(db: DbClient): RuntimeRegistryPersistence {
  return new SqliteRuntimeRegistryPersistence(db)
}
