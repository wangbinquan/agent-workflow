// RFC-349 — durable filesystem adapter for migration chunks, manifests and
// receipts. Application code never derives or reads these physical paths.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseMigrationArtifactStorePort } from '../application/ports/databaseMigrationArtifactStore'
import { digestDatabaseArtifact } from '@/platform/persistence/generationStore'
import {
  persistLogicalTableChunk,
  writeDurableLogicalArtifact,
  writeLogicalArtifactManifest,
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
      // 不再写完再读回来：见 `persistLogicalTableChunk` 的说明——读回那一步是四成的同步
      // 耗时与同等比例的临时垃圾，却证明不了任何事（刚 fsync 完，读的是页缓存）。
      const persisted = persistLogicalTableChunk(operationRoot(operationId), chunk)
      return { chunk: persisted.chunk, bytes: persisted.bytes }
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
