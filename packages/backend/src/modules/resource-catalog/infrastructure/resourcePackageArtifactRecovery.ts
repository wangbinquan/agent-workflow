import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
} from '../application/resourcePackageMaintenance'
import { decodeResourcePackageRecoveryRow } from './resourcePackageArtifactCodec'

/** 格式分派发生在任何 effect 之前；不以 effect 抛出的 ZodError 猜测历史格式。 */
export function createVersionedResourcePackageArtifactRecovery(
  current: ResourcePackageApplyArtifactRecoveryPort,
  legacy: ResourcePackageApplyArtifactRecoveryPort,
): ResourcePackageApplyArtifactRecoveryPort {
  async function recover(
    operation: 'rollForward' | 'compensate',
    journal: ResourcePackageApplyJournalSnapshot,
  ) {
    const selected = decodeResourcePackageRecoveryRow(journal, operation)
    const recovery = selected.format === 'current' ? current : legacy
    await recovery[operation]({
      ...journal,
      preparedArtifactsJson: JSON.stringify(selected.artifacts),
    })
  }
  return {
    rollForward: (journal) => recover('rollForward', journal),
    compensate: (journal) => recover('compensate', journal),
  }
}
