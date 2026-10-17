// RFC-370 v3 V5 — build one hosted backup archive with the standalone
// provider-neutral backup format: `createPortableBackupArchive` writes the
// manifest v2 envelope and the workflow export, and the PostgreSQL logical
// artifact is exported from one repeatable-read snapshot exactly as the
// standalone PostgreSQL backup does. Hosted adds only its installation sidecar.
// Workspaces are never captured: they live on platform volumes (C10).
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/logicalDatabaseExport'
import type { PostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import {
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import {
  createPortableBackupArchive,
  type PortableBackupApplicationAssets,
} from '@/services/portableBackupArchive'
import type { HostedObjectContent } from './objectPublicationContract'
import {
  HOSTED_BACKUP_SIDECAR,
  HostedBackupSidecar,
  type HostedBackupContents,
} from './databaseBackupFormat'
import { createSha256DigestBuilder } from '@/util/hash'

export interface HostedBackupArchive {
  readonly path: string
  readonly sidecar: HostedBackupSidecar
  /** Removes the disposable working directory; the CS object is the backup. */
  dispose(): void
}

export async function hostedBackupFileContent(path: string): Promise<HostedObjectContent> {
  const hash = createSha256DigestBuilder()
  let size = 0
  for await (const part of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const bytes = part as Buffer
    size += bytes.byteLength
    hash.update(bytes)
  }
  return { sha256: hash.digestHex(), size, open: () => Bun.file(path).stream() }
}

export async function createHostedDatabaseBackupArchive(input: {
  readonly backupId: string
  readonly kind: 'manual' | 'scheduled'
  readonly createdAt: number
  readonly installation: string
  readonly objectSpaceId: string
  readonly keyFingerprint: string
  readonly contract: LogicalSchemaContract
  readonly source: PostgresqlLogicalSource
  readonly workflows: Pick<PortableBackupApplicationAssets, 'exportWorkflows'>
  readonly assertBornHosted: () => Promise<void>
  /** Checked before the snapshot and on every source consistency probe. */
  readonly assertAuthority: () => Promise<void>
  readonly workDirectory?: string
  readonly now?: () => number
}): Promise<HostedBackupArchive> {
  const now = input.now ?? Date.now
  const home = mkdtempSync(join(input.workDirectory ?? tmpdir(), 'aw-hosted-backup-'))
  let sidecar: HostedBackupSidecar | undefined
  try {
    const result = await createPortableBackupArchive({
      appHome: home,
      kind: input.kind,
      includeWorktrees: false,
      now: input.createdAt,
      application: {
        exportWorkflows: (destination) => input.workflows.exportWorkflows(destination),
        captureWorktrees: () => Promise.reject(new Error('hosted-backup-worktrees-unsupported')),
      },
      async exportDatabase({ stagingDirectory, logicalArtifactRoot, operationId }) {
        await input.assertAuthority()
        const snapshot = await input.source.preflight()
        // The horizon window closes only once the snapshot is established.
        const snapshotAt = now()
        const receipt = await exportLogicalDatabaseArtifact({
          operationId,
          sourceProvider: 'postgresql',
          sourceGenerationId: input.source.generationId,
          contract: input.contract,
          artifactRoot: logicalArtifactRoot,
          expectedTableRows: snapshot.tableRows,
          emptyArchive: { kind: 'born-hosted', assertProvenance: input.assertBornHosted },
          source: {
            provider: 'postgresql',
            async assertUnchanged() {
              await input.assertAuthority()
              await input.source.assertUnchanged(snapshot)
            },
            readChunk: (table, key, limit) => input.source.readChunk(table, key, limit),
          },
          now,
        })
        const contents: HostedBackupContents = {
          workflows: snapshot.tableRows.workflows ?? 0,
          skills: snapshot.tableRows.skills ?? 0,
        }
        sidecar = HostedBackupSidecar.parse({
          format: 'aw-hosted-database-backup-v2',
          backupId: input.backupId,
          kind: input.kind,
          installation: input.installation,
          objectSpaceId: input.objectSpaceId,
          keyFingerprint: input.keyFingerprint,
          createdAt: input.createdAt,
          snapshotAt,
          schemaDigest: input.contract.digest,
          sourceGenerationId: input.source.generationId,
          contents,
        })
        writeFileSync(join(stagingDirectory, HOSTED_BACKUP_SIDECAR), canonicalSchemaJson(sidecar))
        return {
          // PostgreSQL restore is gated by the logical schema digest rather than
          // the SQLite Drizzle migration axis.
          migration: { lastHash: null, lastCreatedAt: null },
          database: {
            format: 'agent-workflow-logical-database-v1',
            provider: 'postgresql',
            sourceGenerationId: input.source.generationId,
            schemaDigest: input.contract.digest,
            logicalPath: 'database/logical',
            envelopeFileDigest: receipt.envelopeFileDigest,
            rawSqlitePath: null,
          },
        }
      },
    })
    if (sidecar === undefined) throw new Error('hosted-backup-sidecar-missing')
    await input.assertAuthority()
    return {
      path: result.path,
      sidecar,
      dispose: () => rmSync(home, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  } finally {
    await input.source.close()
  }
}
