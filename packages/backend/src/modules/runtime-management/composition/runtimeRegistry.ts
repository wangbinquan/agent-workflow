import type { ProviderNeutralDatabase } from '@/db/query'
import { createRuntimeRegistryApplication } from '../application/runtimeRegistry'
import { createRuntimeRegistryEffects } from '../infrastructure/runtimeRegistryEffects'
import type { RuntimeRegistryOperations } from '../application/ports/runtimeRegistry'
export { initializeRuntimeRegistryBoot } from '../application/runtimeRegistryBoot'
import { DrizzleRuntimeRegistryPersistence } from '@/modules/runtime-management/infrastructure/runtimeRegistryPersistence'
import { composeRuntimeProfileParticipants } from '@/modules/resource-catalog/composition/runtimeProfileParticipants'

export function composeRuntimeRegistryOperations(
  db: ProviderNeutralDatabase,
): RuntimeRegistryOperations {
  return createRuntimeRegistryApplication(
    createRuntimeRegistryEffects(),
  ).composeRuntimeRegistryOperations(
    new DrizzleRuntimeRegistryPersistence(db, composeRuntimeProfileParticipants()),
  )
}

export type { RuntimeRegistryOperations } from '../application/ports/runtimeRegistry'
