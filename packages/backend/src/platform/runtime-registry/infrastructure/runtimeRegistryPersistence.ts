// RFC-360 temporary constructor compatibility for legacy test fixtures.
// The sole persistence algorithm and transaction bodies are owned by Runtime Management.
import type { ProviderNeutralDatabase } from '@/db/query'
import { composeRuntimeProfileParticipants } from '@/modules/resource-catalog/composition/runtimeProfileParticipants'
import { DrizzleRuntimeRegistryPersistence as RuntimeManagementPersistence } from '@/modules/runtime-management/infrastructure/runtimeRegistryPersistence'

export class DrizzleRuntimeRegistryPersistence extends RuntimeManagementPersistence {
  constructor(db: ProviderNeutralDatabase) {
    super(db, composeRuntimeProfileParticipants())
  }
}
