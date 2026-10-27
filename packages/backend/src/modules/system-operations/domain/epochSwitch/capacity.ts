import type { MigrationPlanDocumentPayload } from './documents'

// The trial target was 1.1x its source. Reserve 1.5x for the target plus indexes;
// staging is measured independently and is never approximated by this ratio.
export const EPOCH_TARGET_SIZE_RATIO = 1.5

export function estimateEpochCapacity(input: {
  sourceBytes: number | null
  operationBytes: number | null
  stagingPeakBytes: number | null
  availableBytes: number | null
  targetOnOperationFilesystem: boolean
  localArtifactMirrors: boolean
}): Pick<
  MigrationPlanDocumentPayload['estimates'],
  | 'sourceBytes'
  | 'targetBytes'
  | 'backupBytes'
  | 'stagingBytes'
  | 'requiredBytes'
  | 'availableBytes'
  | 'components'
> {
  const { sourceBytes, operationBytes, stagingPeakBytes } = input
  const targetBytes = sourceBytes === null ? null : Math.ceil(sourceBytes * EPOCH_TARGET_SIZE_RATIO)
  const runBackupBytes = sourceBytes
  const switchBackupBytes = sourceBytes
  const artifactMirrorBytes =
    sourceBytes === null ? null : input.localArtifactMirrors ? 2 * sourceBytes : 0
  const backupBytes = sourceBytes === null ? null : 2 * sourceBytes + artifactMirrorBytes!
  const targetFilesystemBytes = input.targetOnOperationFilesystem ? targetBytes : 0
  // Includes the retained upgrade, mirrors and manifests, measured with the source
  // handle open so its disposable snapshots are covered too. No upgrade multiplier.
  const requiredBytes =
    operationBytes === null ||
    stagingPeakBytes === null ||
    backupBytes === null ||
    targetFilesystemBytes === null
      ? null
      : operationBytes + stagingPeakBytes + backupBytes + targetFilesystemBytes
  return {
    sourceBytes,
    targetBytes,
    backupBytes,
    stagingBytes: stagingPeakBytes,
    requiredBytes,
    availableBytes: input.availableBytes,
    components: {
      operationBytes,
      runBackupBytes,
      switchBackupBytes,
      artifactMirrorBytes,
      targetFilesystemBytes,
    },
  }
}
