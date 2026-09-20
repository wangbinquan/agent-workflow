import type { ProviderNeutralDatabase } from '@/db/query'
import { createRuntimeRegistryApplication } from '../application/runtimeRegistry'
import { createRuntimeRegistryEffects } from '../infrastructure/runtimeRegistryEffects'
import type { RuntimeRegistryOperations } from '../application/ports/runtimeRegistry'
export { initializeRuntimeRegistryBoot } from '../application/runtimeRegistryBoot'
import { DrizzleRuntimeRegistryPersistence } from '@/modules/runtime-management/infrastructure/runtimeRegistryPersistence'

export function composeRuntimeRegistryOperations(
  db: ProviderNeutralDatabase,
  participants: ConstructorParameters<typeof DrizzleRuntimeRegistryPersistence>[1],
): RuntimeRegistryOperations {
  return createRuntimeRegistryApplication(
    createRuntimeRegistryEffects(),
  ).composeRuntimeRegistryOperations(new DrizzleRuntimeRegistryPersistence(db, participants))
}

export type { RuntimeRegistryOperations } from '../application/ports/runtimeRegistry'
