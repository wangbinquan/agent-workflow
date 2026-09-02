// RFC-349 — application-facing persistence contract for one-click migration
// artifacts. Physical paths and durable filesystem mechanics stay behind the
// infrastructure adapter; the runner only names operation-scoped artifacts.

import type {
  LegacyArchiveManifest,
  LogicalDatabaseArtifactManifest,
  LogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'

export interface DatabaseMigrationRollbackReceipt {
  readonly version: 1
  readonly operationId: string
  readonly sourceGenerationId: string
  readonly retiredTargetGenerationId: string
  readonly schemaDigest: string
  readonly verificationDigest: string | null
  readonly firstLiveWriteAt: null
  readonly rolledBackAt: number
}

export interface DatabaseMigrationVerificationReceipt {
  readonly version: 1
  readonly operationId: string
  readonly sourceGenerationId: string
  readonly sourceFingerprint: string
  readonly targetFingerprint: string | null
  readonly schemaDigest: string
  readonly logicalBackupDigest: string | null
  readonly legacyArchiveDigest: string | null
  readonly activeTableCount: number
  readonly archiveOnlyTableCount: number
  readonly verifiedAt: number
}

export interface DatabaseMigrationFinalReceipt {
  readonly version: 1
  readonly operationId: string
  readonly sourceGenerationId: string
  readonly targetGenerationId: string
  readonly schemaDigest: string
  readonly logicalBackupDigest: string | null
  readonly legacyArchiveDigest: string | null
  readonly verificationDigest: string | null
  readonly firstLiveWriteAt: number | null
  readonly finalizedAt: number
}

export interface LogicalTableChunkReceipt {
  readonly chunk: LogicalTableChunk
  readonly bytes: number
}

export interface DatabaseMigrationArtifactStorePort {
  /** Physical root is passed only to the infrastructure-owned safety backup. */
  operationRoot(operationId: string): string
  manifestFileDigest(operationId: string): string
  /**
   * RFC-349: the receipt carries the bytes the store actually wrote. The copy
   * loop needs that number for progress, and asking it here is the difference
   * between counting bytes and serializing the whole dataset a second time
   * just to measure it.
   */
  writeTableChunk(operationId: string, chunk: LogicalTableChunk): LogicalTableChunkReceipt
  writeLogicalManifest(operationId: string, manifest: LogicalDatabaseArtifactManifest): void
  writeLegacyArchiveManifest(operationId: string, manifest: LegacyArchiveManifest): string
  writeRollbackReceipt(operationId: string, receipt: DatabaseMigrationRollbackReceipt): string
  writeVerificationReceipt(
    operationId: string,
    receipt: DatabaseMigrationVerificationReceipt,
  ): string
  writeFinalReceipt(operationId: string, receipt: DatabaseMigrationFinalReceipt): string
}
