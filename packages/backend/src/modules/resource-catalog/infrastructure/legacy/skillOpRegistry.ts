// RFC-170 §6a / T-BOOT — the per-kind recovery handler registry.
//
// Assembled here and passed to recoverSkillOperations at boot. Each concrete op
// module contributes its own handler so the forward path and its crash recovery
// live together and can't drift. The registry is exhaustive: missing a kind is
// a compile-time error here and a fail-closed runtime error in the driver.

import { deleteRecoveryHandler } from '@/modules/resource-catalog/infrastructure/legacy/skillDeleteOp'
import { migrateRecoveryHandler } from '@/modules/resource-catalog/infrastructure/legacy/skillMigrateOp'
import { reserveRecoveryHandler } from '@/modules/resource-catalog/infrastructure/legacy/skillReserveOp'
import { versionWriteRecoveryHandler } from '@/modules/resource-catalog/infrastructure/legacy/skillVersionOp'
import type { SkillOpKind } from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import type { OpRecoveryHandler } from '@/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'

export const SKILL_OP_RECOVERY_REGISTRY = {
  delete: deleteRecoveryHandler,
  migrate: migrateRecoveryHandler,
  reserve: reserveRecoveryHandler,
  'version-write': versionWriteRecoveryHandler,
} satisfies Record<SkillOpKind, OpRecoveryHandler>
