import type { MigrationPlanDocumentPayload } from './documents'

// The trial target was 1.1x its source. Reserve 1.5x for the target plus indexes;
// staging is measured independently and is never approximated by this ratio.
export const EPOCH_TARGET_SIZE_RATIO = 1.5

/**
 * RFC-626 §3.5: what one listed content file adds to the operation directory. An entry is about
 * 215 bytes of the listing (measured: 176.9 MB for 827,743 files), and the listing is kept three
 * times — as the plan step wrote it, as the frozen manifest and inside the backup.
 */
export const CONTENT_MANIFEST_BYTES_PER_FILE = 750
/**
 * RFC-626 §3.5: the staging store as a multiple of the live data. It holds every source row
 * with its key and digest; measured 2.45 times the live data on the reference installation.
 */
export const STAGING_SIZE_RATIO = 3
/** RFC-626 §3.5: the margin kept on top of the sum of the parts. */
export const DIRECT_UPGRADE_MARGIN_RATIO = 0.1

export interface DirectUpgradeCapacity {
  /** L: the bytes the old database holds in use, not the size of its file. */
  readonly liveBytes: number
  /** The frozen copy, which is also the backup. */
  readonly frozenCopyBytes: number
  /** The private copy the remaining epoch-1 migrations are applied to. */
  readonly workingCopyBytes: number
  readonly stagingBytes: number
  readonly targetBytes: number
  /** `targetBytes` when the new database is written to the operation's file system, else 0. */
  readonly targetFilesystemBytes: number
  readonly contentManifestBytes: number
  /** Ordinary copies of the frozen and the working copy where the artifact store cannot link. */
  readonly artifactMirrorBytes: number
  readonly marginBytes: number
  readonly requiredBytes: number
}

/**
 * RFC-626 §3.5: the disk space one automatic upgrade adds to the file system of its operation
 * directory, from the live data L alone. The single-pass upgrade keeps one frozen copy (which
 * is the backup), one working copy, the staging store and — on the same file system — the new
 * database. The earlier estimate multiplied the size of the SQLite file, which for a database
 * that had most of its rows deleted asked for many times what the upgrade writes.
 *
 * The parts are sized so that their sum stays above what an upgrade was measured to add: the
 * reference installation (1.06 GiB of live data, 828 thousand content files) peaked at 6.7 to
 * 6.9 GiB; this estimate asks for 8.2 GiB. The first version of it (staging at twice the live
 * data, one copy of the listing) asked for 6.65 GiB — less than the upgrade then took.
 */
export function estimateDirectUpgradeCapacity(input: {
  readonly liveBytes: number
  readonly contentFiles: number
  readonly targetOnOperationFilesystem: boolean
  readonly artifactHardLinks: boolean
}): DirectUpgradeCapacity {
  const whole = (value: number): number =>
    Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0
  const liveBytes = whole(input.liveBytes)
  const frozenCopyBytes = liveBytes
  const workingCopyBytes = liveBytes
  const stagingBytes = STAGING_SIZE_RATIO * liveBytes
  const targetBytes = Math.ceil(liveBytes * EPOCH_TARGET_SIZE_RATIO)
  const targetFilesystemBytes = input.targetOnOperationFilesystem ? targetBytes : 0
  const contentManifestBytes = whole(input.contentFiles) * CONTENT_MANIFEST_BYTES_PER_FILE
  const artifactMirrorBytes = input.artifactHardLinks ? 0 : 2 * liveBytes
  const parts =
    frozenCopyBytes +
    workingCopyBytes +
    stagingBytes +
    targetFilesystemBytes +
    contentManifestBytes +
    artifactMirrorBytes
  const marginBytes = Math.ceil(parts * DIRECT_UPGRADE_MARGIN_RATIO)
  return {
    liveBytes,
    frozenCopyBytes,
    workingCopyBytes,
    stagingBytes,
    targetBytes,
    targetFilesystemBytes,
    contentManifestBytes,
    artifactMirrorBytes,
    marginBytes,
    requiredBytes: parts + marginBytes,
  }
}

/** The plan document's estimate section for the result above; no rehearsal took place. */
export function directUpgradePlanEstimates(input: {
  readonly capacity: DirectUpgradeCapacity | null
  readonly operationBytes: number | null
  readonly availableBytes: number | null
}): MigrationPlanDocumentPayload['estimates'] {
  const c = input.capacity
  return {
    sourceBytes: c?.liveBytes ?? null,
    targetBytes: c?.targetBytes ?? null,
    backupBytes: c?.frozenCopyBytes ?? null,
    stagingBytes: c?.stagingBytes ?? null,
    requiredBytes: c?.requiredBytes ?? null,
    availableBytes: input.availableBytes,
    rehearsalMs: null,
    maintenanceMs: null,
    components: {
      operationBytes: input.operationBytes,
      // One backup, taken after the freeze: there is no separate backup of the running database.
      runBackupBytes: c ? 0 : null,
      switchBackupBytes: c?.frozenCopyBytes ?? null,
      artifactMirrorBytes: c?.artifactMirrorBytes ?? null,
      targetFilesystemBytes: c?.targetFilesystemBytes ?? null,
    },
  }
}

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
