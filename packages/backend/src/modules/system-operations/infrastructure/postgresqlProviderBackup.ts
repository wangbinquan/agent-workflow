// RFC-349 — PostgreSQL implementation of the provider-neutral platform backup.
// The active database contributes only logical chunks; the six archive-only
// tables are carried forward from the cutover operation's verified artifact.

import { join } from 'node:path'
import type { BackupKind } from '@/services/backupManifest'
import {
  createPortableBackupArchive,
  type PortableBackupApplicationAssets,
  type PortableBackupResult,
} from '@/services/portableBackupArchive'
import { readDatabaseGeneration } from '@/platform/persistence/generationStore'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/logicalDatabaseExport'
import {
  openPostgresqlLogicalSource,
  type PostgresqlLogicalSource,
} from '@/platform/persistence/postgresqlLogicalSource'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  buildLogicalSchemaContract,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import { openVerifiedLogicalDatabaseArtifactSource } from '@/platform/persistence/logicalDatabaseRestore'
import { createFileDatabaseMigrationStore } from './fileDatabaseMigrationStore'
import { createPostgresqlProviderBackupApplicationAssets } from './postgresqlProviderBackupApplicationAssets'

export class PostgresqlProviderBackupError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-backup-generation'
      | 'postgresql-backup-operation'
      | 'postgresql-backup-archive',
    message: string,
  ) {
    super(message)
    this.name = 'PostgresqlProviderBackupError'
  }
}

type PostgresqlLogicalSourceFactory = (input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly generationId: string
  readonly contract: LogicalSchemaContract
}) => Promise<PostgresqlLogicalSource>

export interface CreatePostgresqlProviderBackupOptions {
  readonly runtime: PostgresqlDatabaseRuntime
  /** Infrastructure test/embedding seam; production reads assets from the live provider. */
  readonly application?: PortableBackupApplicationAssets
  readonly maxWorktreeBytes?: number
  readonly appHome: string
  readonly operationsRoot?: string
  readonly generationPointerPath?: string
  readonly contract?: LogicalSchemaContract
  readonly kind?: BackupKind
  readonly includeWorktrees?: boolean
  readonly now?: number
  /** Infrastructure test seam; production always uses the repeatable-read source. */
  readonly openLogicalSource?: PostgresqlLogicalSourceFactory
}

function targetGenerationId(operationId: string): string {
  return `dbg_pg_${operationId.slice(4)}`
}

export async function createPostgresqlProviderBackup(
  options: CreatePostgresqlProviderBackupOptions,
): Promise<PortableBackupResult> {
  const contract = options.contract ?? buildLogicalSchemaContract()
  const operationsRoot = options.operationsRoot ?? join(options.appHome, 'database-migrations')
  const generation = readDatabaseGeneration({
    pointerPath: options.generationPointerPath ?? join(options.appHome, 'database-generation.json'),
    migrationsDir: operationsRoot,
    expectedSchemaDigest: contract.digest,
  }).payload
  if (
    generation.provider !== 'postgresql' ||
    generation.operationId === null ||
    generation.manifestDigest === null ||
    generation.generationId !== targetGenerationId(generation.operationId) ||
    options.runtime.provider !== 'postgresql' ||
    options.runtime.generationId !== generation.generationId
  ) {
    throw new PostgresqlProviderBackupError(
      'postgresql-backup-generation',
      'PostgreSQL backup requires the verified live PostgreSQL generation',
    )
  }

  const migration = createFileDatabaseMigrationStore({ root: operationsRoot }).read(
    generation.operationId,
  )
  if (
    migration === null ||
    !['accepting-writes', 'finalized'].includes(migration.payload.phase) ||
    migration.payload.failure !== null ||
    migration.payload.rolledBackAt !== null ||
    migration.payload.source.schemaDigest !== contract.digest ||
    migration.payload.logicalBackupDigest === null ||
    migration.payload.legacyArchiveDigest === null
  ) {
    throw new PostgresqlProviderBackupError(
      'postgresql-backup-operation',
      'PostgreSQL backup source migration is not a complete live operation',
    )
  }

  let preservedArchive: ReturnType<typeof openVerifiedLogicalDatabaseArtifactSource>
  try {
    preservedArchive = openVerifiedLogicalDatabaseArtifactSource({
      artifactRoot: join(operationsRoot, generation.operationId),
      expectedManifestDigest: migration.payload.logicalBackupDigest,
      expectedLegacyArchiveFileDigest: migration.payload.legacyArchiveDigest,
      contract,
    })
  } catch {
    throw new PostgresqlProviderBackupError(
      'postgresql-backup-archive',
      'PostgreSQL backup cannot verify the preserved SQLite legacy archive',
    )
  }

  const sourceFactory = options.openLogicalSource ?? openPostgresqlLogicalSource
  const application =
    options.application ??
    createPostgresqlProviderBackupApplicationAssets({
      runtime: options.runtime,
      ...(options.maxWorktreeBytes === undefined
        ? {}
        : { maxWorktreeBytes: options.maxWorktreeBytes }),
    })
  return await createPortableBackupArchive({
    appHome: options.appHome,
    kind: options.kind,
    includeWorktrees: options.includeWorktrees,
    now: options.now,
    application,
    async exportDatabase({ logicalArtifactRoot, operationId }) {
      const source = await sourceFactory({
        runtime: options.runtime,
        generationId: generation.generationId,
        contract,
      })
      let receipt: Awaited<ReturnType<typeof exportLogicalDatabaseArtifact>>
      try {
        const snapshot = await source.preflight()
        receipt = await exportLogicalDatabaseArtifact({
          operationId,
          sourceProvider: 'postgresql',
          sourceGenerationId: generation.generationId,
          source: {
            provider: 'postgresql',
            assertUnchanged: () => source.assertUnchanged(snapshot),
            readChunk: (table, afterKey, limit) => source.readChunk(table, afterKey, limit),
          },
          expectedTableRows: snapshot.tableRows,
          contract,
          artifactRoot: logicalArtifactRoot,
          preservedArchive,
          now: () => options.now ?? Date.now(),
        })
      } finally {
        await source.close()
      }
      return {
        // PostgreSQL restore is gated by the logical schema digest rather than
        // the immutable SQLite Drizzle migration-axis compatibility field.
        migration: { lastHash: null, lastCreatedAt: null },
        database: {
          format: 'agent-workflow-logical-database-v1',
          provider: 'postgresql',
          sourceGenerationId: generation.generationId,
          schemaDigest: contract.digest,
          logicalPath: 'database/logical',
          envelopeFileDigest: receipt.envelopeFileDigest,
          rawSqlitePath: null,
        },
      }
    },
  })
}
