// RFC-170 §6a / T-BOOT — the per-kind recovery handler registry.
//
// Assembled here and passed to recoverSkillOperations at boot. Each concrete op
// module contributes its own handler so the forward path and its crash recovery
// live together and can't drift. Kinds with no handler yet fall through to the
// driver's generic "release the lock + log loud" path (never silently stuck).

import type { OpRecoveryRegistry } from '@/services/skillOpRecoveryDriver'
import { deleteRecoveryHandler } from '@/services/skillDeleteOp'
import { reserveRecoveryHandler } from '@/services/skillReserveOp'
import { versionWriteRecoveryHandler } from '@/services/skillVersionOp'

export const SKILL_OP_RECOVERY_REGISTRY: OpRecoveryRegistry = {
  delete: deleteRecoveryHandler,
  reserve: reserveRecoveryHandler,
  'version-write': versionWriteRecoveryHandler,
  // replace / migrate / adopt-managed handlers land here as those ops are implemented.
}
