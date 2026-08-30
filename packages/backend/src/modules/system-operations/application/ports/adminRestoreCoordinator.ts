import type {
  AdminRecoveryStatus,
  AdminRestorePlan,
  LocalRestoreActivation,
  RestoreDirection,
} from '../../domain/recovery'
import type { RestoreArtifactRef } from '../../public/types'

export interface AdminRestoreCoordinatorPort {
  plan(
    artifactRef: RestoreArtifactRef,
    input: Readonly<{ skipIntegrityCheck: boolean }>,
  ): Promise<AdminRestorePlan>
  stage(
    artifactRef: RestoreArtifactRef,
    input: Readonly<{
      noSafetyBackup: boolean
      noMigrate: boolean
      skipIntegrityCheck: boolean
    }>,
  ): Promise<Readonly<{ direction: RestoreDirection }>>
  status(): AdminRecoveryStatus
  cancel(): Readonly<{ cleared: boolean }>
  activateLocal(
    artifactRef: RestoreArtifactRef,
    input: Readonly<{
      noSafetyBackup: boolean
      noMigrate: boolean
      skipIntegrityCheck: boolean
    }>,
  ): Promise<LocalRestoreActivation>
}
