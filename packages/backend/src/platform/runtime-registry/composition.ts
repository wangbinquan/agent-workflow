import type { ProviderNeutralDatabase } from '@/db/query'
import { composeRuntimeRegistryOperations as composeOperationsFromPersistence } from '@/services/runtimeRegistry'
import type { RuntimeRegistryOperations } from './application/runtimeRegistryOperations'
export { initializeRuntimeRegistryBoot } from './application/runtimeRegistryBoot'
import { DrizzleRuntimeRegistryPersistence } from './infrastructure/runtimeRegistryPersistence'

export function composeRuntimeRegistryOperations(
  db: ProviderNeutralDatabase,
): RuntimeRegistryOperations {
  return composeOperationsFromPersistence(new DrizzleRuntimeRegistryPersistence(db))
}

export type { RuntimeRegistryOperations } from './application/runtimeRegistryOperations'
