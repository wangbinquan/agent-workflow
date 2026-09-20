import type { ProviderNeutralDatabase } from '@/db/query'
import type { RuntimeRegistryPersistence } from '@/modules/runtime-management/application/ports/runtimeRegistry'
import { DrizzleRuntimeRegistryPersistence as RuntimeManagementPersistence } from '@/modules/runtime-management/infrastructure/runtimeRegistryPersistence'
import { composeRuntimeProfileParticipants } from '@/modules/resource-catalog/composition/runtimeProfileParticipants'

/**
 * 给 service 层的存量 runtime-registry 用例绑一个持久化实现。
 * RFC-359 W4-D28b 之后只有一份中立实现，两个引擎共用；这里接收所选引擎的真实句柄。
 */
export function runtimeRegistryPersistence(
  db: ProviderNeutralDatabase,
): RuntimeRegistryPersistence {
  return new DrizzleRuntimeRegistryPersistence(db)
}

/** Constructor vocabulary retained only for the real-provider conformance fixtures. */
export class DrizzleRuntimeRegistryPersistence extends RuntimeManagementPersistence {
  constructor(db: ProviderNeutralDatabase) {
    super(db, composeRuntimeProfileParticipants())
  }
}
