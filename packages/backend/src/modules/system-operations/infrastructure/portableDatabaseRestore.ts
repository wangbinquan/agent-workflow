// RFC-349 — provider-neutral logical restore from a V2 platform backup.
// The target remains inactive: generation-pointer activation is a separate
// coordinator checkpoint after database and filesystem application both pass.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  readLogicalDatabaseBackupEnvelope,
  type LogicalDatabaseBackupEnvelope,
} from '@/platform/persistence/logicalDatabaseExport'
import {
  restoreLogicalDatabaseBackup,
  type LogicalDatabaseRestoreProgress,
  type LogicalDatabaseRestoreReceipt,
  type LogicalDatabaseRestoreTarget,
} from '@/platform/persistence/logicalDatabaseRestore'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { readManifest, type BackupManifestV2 } from '@/services/backupManifest'
import { extractTarGz } from '@/util/archive'

export class PortableDatabaseRestoreError extends Error {
  constructor(
    public readonly code:
      | 'portable-restore-manifest'
      | 'portable-restore-schema'
      | 'portable-restore-envelope',
    message: string,
  ) {
    super(message)
    this.name = 'PortableDatabaseRestoreError'
  }
}

export interface PortableRestoreFilesystemAssets {
  apply(input: {
    readonly stagingDirectory: string
    readonly manifest: BackupManifestV2
  }): Promise<void>
}

export interface RestorePortableDatabaseBackupOptions {
  readonly tarballPath: string
  readonly appHome: string
  readonly restoreOperationId: string
  readonly contract: LogicalSchemaContract
  readonly target: LogicalDatabaseRestoreTarget
  readonly filesystem: PortableRestoreFilesystemAssets
  readonly now?: () => number
  readonly onProgress?: (progress: LogicalDatabaseRestoreProgress) => void
}

export interface PortableDatabaseRestoreResult {
  readonly manifest: BackupManifestV2
  readonly envelope: LogicalDatabaseBackupEnvelope
  readonly receipt: LogicalDatabaseRestoreReceipt
}

function validateEnvelope(
  manifest: BackupManifestV2,
  envelope: LogicalDatabaseBackupEnvelope,
  contract: LogicalSchemaContract,
): void {
  if (
    manifest.database.schemaDigest !== contract.digest ||
    envelope.payload.schemaDigest !== contract.digest
  ) {
    throw new PortableDatabaseRestoreError(
      'portable-restore-schema',
      'portable database restore schema does not match this binary',
    )
  }
  if (
    manifest.database.provider !== envelope.payload.sourceProvider ||
    manifest.database.sourceGenerationId !== envelope.payload.sourceGenerationId ||
    manifest.database.schemaDigest !== envelope.payload.schemaDigest ||
    envelope.payload.activeTableCount !== contract.activeTableCount ||
    envelope.payload.archiveOnlyTableCount !== contract.archiveOnlyTableCount ||
    (manifest.database.provider === 'postgresql' && manifest.database.rawSqlitePath !== null)
  ) {
    throw new PortableDatabaseRestoreError(
      'portable-restore-envelope',
      'portable database restore manifest and logical envelope differ',
    )
  }
}

export async function restorePortableDatabaseBackup(
  options: RestorePortableDatabaseBackupOptions,
): Promise<PortableDatabaseRestoreResult> {
  const stagingDirectory = join(
    options.appHome,
    'backups',
    `.logical-restore-${options.restoreOperationId}`,
  )
  if (existsSync(stagingDirectory)) {
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
  mkdirSync(stagingDirectory, { recursive: true })
  try {
    await extractTarGz(options.tarballPath, stagingDirectory)
    const manifest = readManifest(stagingDirectory)
    if (manifest?.manifestVersion !== 2) {
      throw new PortableDatabaseRestoreError(
        'portable-restore-manifest',
        'portable database restore requires a valid V2 backup manifest',
      )
    }
    let envelope: LogicalDatabaseBackupEnvelope
    try {
      envelope = readLogicalDatabaseBackupEnvelope({
        artifactRoot: join(stagingDirectory, manifest.database.logicalPath),
        expectedFileDigest: manifest.database.envelopeFileDigest,
      })
    } catch {
      throw new PortableDatabaseRestoreError(
        'portable-restore-envelope',
        'portable database restore logical envelope is corrupt',
      )
    }
    validateEnvelope(manifest, envelope, options.contract)

    const receipt = await restoreLogicalDatabaseBackup({
      artifactRoot: join(stagingDirectory, manifest.database.logicalPath),
      expectedEnvelopeFileDigest: manifest.database.envelopeFileDigest,
      restoreOperationId: options.restoreOperationId,
      contract: options.contract,
      target: options.target,
      now: options.now,
      onProgress: options.onProgress,
    })
    await options.filesystem.apply({ stagingDirectory, manifest })
    return Object.freeze({ manifest, envelope, receipt })
  } finally {
    if (existsSync(stagingDirectory)) {
      rmSync(stagingDirectory, { recursive: true, force: true })
    }
  }
}
