// RFC-360: test composition root; both contexts retain their single real implementation.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeRuntimeRegistryOperations as composeRegistry } from '@/modules/runtime-management/composition/runtimeRegistry'
import { composeRuntimeProfileParticipants } from '@/modules/resource-catalog/composition/runtimeProfileParticipants'

export function composeRuntimeRegistryOperations(db: PersistenceDb) {
  return composeRegistry(db, composeRuntimeProfileParticipants())
}
