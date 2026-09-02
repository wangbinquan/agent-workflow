// RFC-349 — durable filesystem adapter for migration chunks, manifests and
// receipts. Application code never derives or reads these physical paths.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseMigrationArtifactStorePort } from '../application/ports/databaseMigrationArtifactStore'
import { digestDatabaseArtifact } from '@/platform/persistence/generationStore'
import {
  readLogicalTableChunk,
  writeDurableLogicalArtifact,
  writeLogicalArtifactManifest,
  writeLogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'

export function createFileDatabaseMigrationArtifactStore(input: {
  readonly operationsRoot: string
}): DatabaseMigrationArtifactStorePort {
  const operationRoot = (operationId: string): string => join(input.operationsRoot, operationId)

  const store: DatabaseMigrationArtifactStorePort = {
    operationRoot,
    manifestFileDigest(operationId) {
      return digestDatabaseArtifact(readFileSync(join(operationRoot(operationId), 'manifest.json')))
    },
    writeTableChunk(operationId, chunk) {
      const path = writeLogicalTableChunk(operationRoot(operationId), chunk)
      return { chunk: readLogicalTableChunk(path), bytes: statSync(path).size }
    },
    writeLogicalManifest(operationId, manifest) {
      writeLogicalArtifactManifest(operationRoot(operationId), manifest)
    },
    writeLegacyArchiveManifest(operationId, manifest) {
      return writeDurableLogicalArtifact(
        join(operationRoot(operationId), 'legacy-archive', 'manifest.json'),
        manifest,
      )
    },
    writeRollbackReceipt(operationId, receipt) {
      return writeDurableLogicalArtifact(
        join(operationRoot(operationId), 'rollback-receipt.json'),
        receipt,
      )
    },
    writeVerificationReceipt(operationId, receipt) {
      return writeDurableLogicalArtifact(
        join(operationRoot(operationId), 'verification.json'),
        receipt,
      )
    },
    writeFinalReceipt(operationId, receipt) {
      return writeDurableLogicalArtifact(join(operationRoot(operationId), 'receipt.json'), receipt)
    },
  }
  return Object.freeze(store)
}
