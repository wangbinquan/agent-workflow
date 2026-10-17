// RFC-370 v3 V5 — open one hosted backup archive for restore. The restore Job
// downloads the single archive object (the object client verifies its size and
// SHA-256 while streaming), extracts the standalone backup envelope and verifies
// the complete logical artifact tree before any target write. Replay uses the
// standalone PostgreSQL logical import path unchanged.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import { readLogicalDatabaseBackupEnvelope } from '@/platform/persistence/logicalDatabaseExport'
import {
  openVerifiedLogicalDatabaseArtifactSource,
  restoreLogicalDatabaseBackup,
  type LogicalDatabaseRestoreTarget,
} from '@/platform/persistence/logicalDatabaseRestore'
import {
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import { readManifest, type BackupManifestV2 } from '@/services/backupManifest'
import { extractTarGz } from '@/util/archive'
import {
  HOSTED_BACKUP_SIDECAR,
  HostedBackupSidecar,
  hostedBackupMarker,
  hostedRestoreCopyOperationId,
  parseHostedBackupReference,
} from './databaseBackupFormat'

// A hosted restore accepts exactly the logical archive a hosted backup writes:
// a PostgreSQL source with no raw SQLite file, no worktrees and no archive rows.
const HostedRestorableManifest = z
  .object({
    database: z
      .object({ provider: z.literal('postgresql'), rawSqlitePath: z.null() })
      .passthrough(),
    includesWorktrees: z.literal(false),
  })
  .passthrough()
const HostedRestorableEnvelope = z
  .object({ sourceProvider: z.literal('postgresql'), archiveRows: z.literal(0) })
  .passthrough()

export class HostedRestoreArtifactError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'HostedRestoreArtifactError'
  }
}

async function download(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  const file = await openFile(path, 'wx', 0o600)
  const reader = stream.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      let offset = 0
      while (offset < chunk.value.byteLength) {
        const { bytesWritten } = await file.write(
          chunk.value,
          offset,
          chunk.value.byteLength - offset,
        )
        if (bytesWritten === 0)
          throw new HostedRestoreArtifactError('hosted-restore-file-write-stalled')
        offset += bytesWritten
      }
    }
    await file.sync()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await file.close()
  }
}

export interface HostedRestoreArtifact {
  readonly object: HostedStoredObject
  readonly sidecar: HostedBackupSidecar
  readonly manifest: BackupManifestV2
  /** The logical copy operation restoring exactly this archive. */
  readonly copyOperationId: string
  /** The generation source marker of a database restored from this backup. */
  readonly marker: string
  /** The verified logical census of every restored table. */
  readonly tables: readonly {
    readonly table: string
    readonly disposition: LogicalSchemaContract['tables'][number]['disposition']
    readonly rowCount: number
    readonly chunkCount: number
  }[]
  replay(target: LogicalDatabaseRestoreTarget): Promise<unknown>
  close(): void
}

export async function openHostedDatabaseBackupArchive(input: {
  readonly reference: string
  readonly installation: string
  readonly objectSpaceId: string
  readonly keyFingerprint: string
  readonly contract: LogicalSchemaContract
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly workDirectory?: string
}): Promise<HostedRestoreArtifact> {
  const object = parseHostedBackupReference(input.reference)
  const directory = mkdtempSync(join(input.workDirectory ?? tmpdir(), 'aw-hosted-restore-'))
  try {
    const archivePath = join(directory, 'backup.tar.gz')
    await download(await input.objects.open(object), archivePath)
    const staging = join(directory, 'archive')
    mkdirSync(staging)
    await extractTarGz(archivePath, staging)
    rmSync(archivePath, { force: true })
    const manifest = readManifest(staging)
    if (manifest?.manifestVersion !== 2)
      throw new HostedRestoreArtifactError('hosted-restore-manifest-invalid')
    let sidecarText: string
    try {
      sidecarText = readFileSync(join(staging, HOSTED_BACKUP_SIDECAR), 'utf8')
    } catch {
      throw new HostedRestoreArtifactError('hosted-restore-sidecar-missing')
    }
    const sidecar = HostedBackupSidecar.parse(JSON.parse(sidecarText))
    if (sidecarText !== canonicalSchemaJson(sidecar))
      throw new HostedRestoreArtifactError('hosted-restore-sidecar-not-canonical')
    if (
      sidecar.installation !== input.installation ||
      sidecar.objectSpaceId !== input.objectSpaceId
    )
      throw new HostedRestoreArtifactError('hosted-restore-installation-mismatch')
    if (sidecar.keyFingerprint !== input.keyFingerprint)
      throw new HostedRestoreArtifactError('hosted-restore-encryption-key-mismatch')
    if (
      sidecar.schemaDigest !== input.contract.digest ||
      manifest.database.schemaDigest !== input.contract.digest
    )
      throw new HostedRestoreArtifactError('hosted-restore-schema-mismatch')
    if (
      !HostedRestorableManifest.safeParse(manifest).success ||
      manifest.database.sourceGenerationId !== sidecar.sourceGenerationId
    )
      throw new HostedRestoreArtifactError('hosted-restore-manifest-mismatch')
    const artifactRoot = join(staging, manifest.database.logicalPath)
    const envelope = readLogicalDatabaseBackupEnvelope({
      artifactRoot,
      expectedFileDigest: manifest.database.envelopeFileDigest,
    })
    if (
      !HostedRestorableEnvelope.safeParse(envelope.payload).success ||
      envelope.payload.sourceGenerationId !== sidecar.sourceGenerationId ||
      envelope.payload.schemaDigest !== sidecar.schemaDigest
    )
      throw new HostedRestoreArtifactError('hosted-restore-envelope-mismatch')
    const source = openVerifiedLogicalDatabaseArtifactSource({
      artifactRoot,
      expectedManifestDigest: envelope.payload.logicalManifestDigest,
      expectedLegacyArchiveFileDigest: envelope.payload.legacyArchiveFileDigest,
      contract: input.contract,
    })
    if (source.verification.archiveRows !== 0)
      throw new HostedRestoreArtifactError('hosted-restore-legacy-archive-not-empty')
    const copyOperationId = hostedRestoreCopyOperationId(object)
    let closed = false
    return {
      object,
      sidecar,
      manifest,
      copyOperationId,
      marker: hostedBackupMarker(sidecar.backupId),
      tables: source.verification.manifest.payload.tables.map((table) => ({
        table: table.table,
        disposition: table.disposition,
        rowCount: table.rowCount,
        chunkCount: table.chunkCount,
      })),
      async replay(target) {
        if (closed) throw new HostedRestoreArtifactError('hosted-restore-artifact-closed')
        return restoreLogicalDatabaseBackup({
          artifactRoot,
          expectedEnvelopeFileDigest: manifest.database.envelopeFileDigest,
          restoreOperationId: copyOperationId,
          contract: input.contract,
          target,
        })
      },
      close() {
        if (!closed) {
          closed = true
          rmSync(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
