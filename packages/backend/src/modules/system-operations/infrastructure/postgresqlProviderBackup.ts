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

import { type LogicalSchemaContract } from '@/platform/persistence/schemaContract'

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
  readonly headContract: LogicalSchemaContract
  readonly runtime: PostgresqlDatabaseRuntime
  /**
   * RFC-359 W9：workflow / worktree 的行选择没有 provider 差异，由组合根注入的中立实现
   * （`portableApplicationAssets.ts`）提供，本模块不再自带一份手写 SQL 的副本。
   */
  readonly application: PortableBackupApplicationAssets
  readonly appHome: string
  readonly operationsRoot?: string
  readonly generationPointerPath?: string
  readonly contract: LogicalSchemaContract
  readonly kind?: BackupKind
  readonly includeWorktrees?: boolean
  readonly now?: number
  /** Infrastructure test seam; production always uses the repeatable-read source. */
  readonly openLogicalSource?: PostgresqlLogicalSourceFactory
}

export async function createPostgresqlProviderBackup(
  options: CreatePostgresqlProviderBackupOptions,
): Promise<PortableBackupResult> {
  const contract = options.contract
  const operationsRoot = options.operationsRoot ?? join(options.appHome, 'database-migrations')
  const generation = readDatabaseGeneration({
    pointerPath: options.generationPointerPath ?? join(options.appHome, 'database-generation.json'),
    migrationsDir: operationsRoot,
    expectedSchemaDigest: contract.digest,
  }).payload
  if (
    generation.provider !== options.runtime.provider ||
    options.runtime.generationId !== generation.generationId
  )
    throw new PostgresqlProviderBackupError(
      'postgresql-backup-generation',
      'backup requires the active PostgreSQL generation',
    )
  const sourceFactory = options.openLogicalSource ?? openPostgresqlLogicalSource
  return await createPortableBackupArchive({
    appHome: options.appHome,
    kind: options.kind,
    includeWorktrees: options.includeWorktrees,
    now: options.now,
    application: options.application,
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
            readMetadata: () => {
              if (!source.readMetadata) throw new Error('epoch2-metadata-source-required')
              return source.readMetadata()
            },
            assertUnchanged: () => source.assertUnchanged(snapshot),
            readChunk: (table, afterKey, limit) => source.readChunk(table, afterKey, limit),
          },
          expectedTableRows: snapshot.tableRows,
          contract,
          artifactRoot: logicalArtifactRoot,
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
