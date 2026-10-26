import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
} from '../application/resourcePackageMaintenance'
import {
  decodeResourcePackageRecoveryRow,
  decodeResourcePackageReceipt,
  resourcePackageArtifactCodecs,
} from './resourcePackageArtifactCodec'

/** All records use the same envelope; operation instructions select their effect adapter. */
export function createVersionedResourcePackageArtifactRecovery(
  current: ResourcePackageApplyArtifactRecoveryPort,
  operations: ResourcePackageApplyArtifactRecoveryPort,
): ResourcePackageApplyArtifactRecoveryPort {
  async function recover(
    operation: 'rollForward' | 'compensate',
    journal: ResourcePackageApplyJournalSnapshot,
  ) {
    const { artifacts } = decodeResourcePackageRecoveryRow(journal, operation)
    if (operation === 'rollForward') {
      const receipt = decodeResourcePackageReceipt(journal)
      for (const artifact of artifacts) {
        const resourceId = artifact.kind === 'plugin-install' ? artifact.pluginId : artifact.skillId
        if (
          !receipt.applied.some(
            (entry) =>
              entry.operationId === artifact.operationId && entry.resourceId === resourceId,
          )
        )
          throw new Error(`resource-package-artifact-receipt-missing:${artifact.operationId}`)
      }
    }
    const batches =
      operation === 'compensate'
        ? [...artifacts].reverse().map((artifact) => [artifact])
        : [
            artifacts.filter((artifact) => artifact.recovery === undefined),
            artifacts.filter((artifact) => artifact.recovery !== undefined),
          ]
    let failure: unknown
    for (const batch of batches) {
      if (batch.length === 0) continue
      try {
        await (batch[0]!.recovery === undefined ? current : operations)[operation]({
          ...journal,
          preparedArtifactsJson: resourcePackageArtifactCodecs.encode(batch),
        })
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
  return {
    rollForward: (journal) => recover('rollForward', journal),
    compensate: (journal) => recover('compensate', journal),
  }
}
