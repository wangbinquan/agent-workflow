import {
  type EpochMetadataSnapshot,
  verifyEpochMetadataSnapshot,
} from './schema/history/metadataSnapshot'
// RFC-349 — one bounded exporter for SQLite and PostgreSQL logical backups.
// PostgreSQL has no active copies of the six archive-only tables, so their
// already-verified chunks are re-bound from the preserved legacy artifact while
// all active tables are read from one provider snapshot.

import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  createLegacyArchiveManifest,
  compareCanonicalLogicalKeys,
  createLogicalArtifactManifest,
  createLogicalTableChunk,
  logicalArtifactFileDigest,
  readLogicalTableChunk,
  writeDurableLogicalArtifact,
  writeLogicalArtifactManifest,
  writeLogicalTableChunk,
  type CanonicalLogicalRow,
  type CanonicalLogicalValue,
  type LogicalDatabaseArtifactManifest,
  type LogicalTableArtifactEntry,
  type LogicalTableChunk,
} from './logicalDatabaseArtifact'
import type { VerifiedLogicalDatabaseArtifactSource } from './logicalDatabaseRestore'
import {
  canonicalSchemaJson,
  digestSchemaContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from './schemaContract'

export interface LogicalDatabaseExportSource {
  readonly provider: DatabaseProvider
  readMetadata?(): Promise<EpochMetadataSnapshot>
  assertUnchanged(): Promise<void>
  readChunk(
    table: LogicalTableContract,
    afterKey: readonly CanonicalLogicalValue[] | null,
    limit: number,
  ): Promise<readonly CanonicalLogicalRow[]>
}

export interface LogicalDatabaseExportProgress {
  readonly operationId: string
  readonly table: string
  readonly chunk: number
  readonly tablesCompleted: number
  readonly tablesTotal: number
  readonly rowsExported: number
  readonly bytesExported: number
}

export interface LogicalDatabaseExportReceipt {
  readonly manifest: LogicalDatabaseArtifactManifest
  readonly legacyArchiveFileDigest: string
  readonly envelope: LogicalDatabaseBackupEnvelope
  readonly envelopeFileDigest: string
  readonly activeRows: number
  readonly archiveRows: number
  readonly chunks: number
  readonly bytes: number
}

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const OperationIdSchema = z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/)
const GenerationIdSchema = z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/)
const LogicalDatabaseBackupEnvelopePayloadSchema = z
  .object({
    version: z.literal(1),
    operationId: OperationIdSchema,
    sourceProvider: z.enum(['sqlite', 'postgresql']),
    sourceGenerationId: GenerationIdSchema,
    schemaDigest: DigestSchema,
    logicalManifestDigest: DigestSchema,
    legacyArchiveFileDigest: DigestSchema,
    activeTableCount: z.number().int().nonnegative(),
    archiveOnlyTableCount: z.number().int().nonnegative(),
    activeRows: z.number().int().nonnegative(),
    archiveRows: z.number().int().nonnegative(),
    chunks: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    epoch2MetadataFileDigest: DigestSchema.optional(),
  })
  .strict()

const LogicalDatabaseBackupEnvelopeSchema = z
  .object({
    payload: LogicalDatabaseBackupEnvelopePayloadSchema,
    digest: DigestSchema,
  })
  .strict()

export type LogicalDatabaseBackupEnvelope = z.infer<typeof LogicalDatabaseBackupEnvelopeSchema>

export const LOGICAL_DATABASE_BACKUP_ENVELOPE = 'logical-backup.json'

export class LogicalDatabaseExportError extends Error {
  constructor(
    public readonly code:
      | 'logical-export-source-provider'
      | 'logical-export-row-census'
      | 'logical-export-archive-required'
      | 'logical-export-source-order'
      | 'logical-export-envelope-corrupt',
    message: string,
  ) {
    super(message)
    this.name = 'LogicalDatabaseExportError'
  }
}

export function verifyLogicalDatabaseBackupEnvelope(value: unknown): LogicalDatabaseBackupEnvelope {
  let envelope: LogicalDatabaseBackupEnvelope
  try {
    envelope = LogicalDatabaseBackupEnvelopeSchema.parse(value)
  } catch {
    throw new LogicalDatabaseExportError(
      'logical-export-envelope-corrupt',
      'logical database backup envelope failed schema validation',
    )
  }
  if (digestSchemaContract(envelope.payload) !== envelope.digest) {
    throw new LogicalDatabaseExportError(
      'logical-export-envelope-corrupt',
      'logical database backup envelope digest mismatch',
    )
  }
  return envelope
}

export function readLogicalDatabaseBackupEnvelope(input: {
  readonly artifactRoot: string
  readonly expectedFileDigest: string
}): LogicalDatabaseBackupEnvelope {
  const path = join(input.artifactRoot, LOGICAL_DATABASE_BACKUP_ENVELOPE)
  let raw: string
  let value: unknown
  try {
    raw = readFileSync(path, 'utf8')
    value = JSON.parse(raw)
  } catch {
    throw new LogicalDatabaseExportError(
      'logical-export-envelope-corrupt',
      'logical database backup envelope is missing or unreadable',
    )
  }
  if (
    raw !== canonicalSchemaJson(value) ||
    logicalArtifactFileDigest(path) !== input.expectedFileDigest
  ) {
    throw new LogicalDatabaseExportError(
      'logical-export-envelope-corrupt',
      'logical database backup envelope file digest mismatch',
    )
  }
  return verifyLogicalDatabaseBackupEnvelope(value)
}

function expectedRoster(input: {
  readonly provider: DatabaseProvider
  readonly contract: LogicalSchemaContract
}): string[] {
  return (
    input.contract.tables
      // Only the migration SOURCE still physically holds the archived tables.
      .filter((table) => table.providerTables[input.provider] !== undefined)
      .map((table) => table.id)
      .sort()
  )
}

function createTableEntryAccumulator(input: {
  readonly table: LogicalTableContract
  readonly contract: LogicalSchemaContract
}): {
  add(chunk: LogicalTableChunk): void
  finish(): LogicalTableArtifactEntry
  count(): number
} {
  let rowCount = 0
  let blobBytes = 0
  let firstKey: CanonicalLogicalRow['key'] | null = null
  let lastKey: CanonicalLogicalRow['key'] | null = null
  const chunkDigests: string[] = []
  return {
    add(chunk) {
      if (
        chunk.payload.chunkIndex !== chunkDigests.length ||
        chunk.payload.table !== input.table.id
      ) {
        throw new LogicalDatabaseExportError(
          'logical-export-source-order',
          `logical export chunk sequence differs for ${input.table.id}`,
        )
      }
      chunkDigests.push(chunk.digest)
      rowCount += chunk.payload.rows.length
      for (const row of chunk.payload.rows) {
        firstKey ??= row.key
        lastKey = row.key
        for (const value of row.values) {
          if (value.type === 'bytes') blobBytes += Buffer.byteLength(value.value, 'base64')
        }
      }
    },
    finish() {
      return Object.freeze({
        table: input.table.id,
        disposition: input.table.disposition,
        rowCount,
        chunkCount: chunkDigests.length,
        firstKey,
        lastKey,
        chunkDigests: [...chunkDigests],
        rootDigest: digestSchemaContract({
          table: input.table.id,
          schemaDigest: chunkDigests.length === 0 ? null : input.contract.digest,
          rowCount,
          chunkDigests,
        }),
        blobBytes,
      })
    },
    count() {
      return chunkDigests.length
    },
  }
}

export async function exportLogicalDatabaseArtifact(input: {
  readonly operationId: string
  readonly sourceProvider: DatabaseProvider
  readonly sourceGenerationId: string
  readonly source: LogicalDatabaseExportSource
  readonly expectedTableRows: Readonly<Record<string, number>>
  readonly contract: LogicalSchemaContract
  readonly artifactRoot: string
  readonly preservedArchive?: VerifiedLogicalDatabaseArtifactSource
  /** A fresh hosted PostgreSQL has never held the retired SQLite tables.
   * Its adapter must prove the hosted installation marker, rather than silently
   * replacing a migrated installation's historical archive with empty rows. */
  readonly emptyArchive?: {
    readonly kind: 'born-hosted'
    assertProvenance(): Promise<void>
  }
  readonly chunkRows?: number
  readonly now?: () => number
  readonly onProgress?: (progress: LogicalDatabaseExportProgress) => void
}): Promise<LogicalDatabaseExportReceipt> {
  if (input.source.provider !== input.sourceProvider) {
    throw new LogicalDatabaseExportError(
      'logical-export-source-provider',
      'logical export source provider differs from the requested artifact provider',
    )
  }
  const expectedIds = expectedRoster({ provider: input.sourceProvider, contract: input.contract })
  if (
    canonicalSchemaJson(Object.keys(input.expectedTableRows).sort()) !==
    canonicalSchemaJson(expectedIds)
  ) {
    throw new LogicalDatabaseExportError(
      'logical-export-row-census',
      'logical export source row census does not match the provider table roster',
    )
  }
  if (
    input.sourceProvider === 'postgresql' &&
    input.contract.archiveOnlyTableCount > 0 &&
    input.preservedArchive === undefined &&
    input.emptyArchive === undefined
  ) {
    throw new LogicalDatabaseExportError(
      'logical-export-archive-required',
      'PostgreSQL logical backup requires the preserved legacy archive',
    )
  }
  if (input.emptyArchive !== undefined) {
    if (input.sourceProvider !== 'postgresql' || input.preservedArchive !== undefined)
      throw new LogicalDatabaseExportError(
        'logical-export-archive-required',
        'empty hosted archive provenance cannot replace a preserved archive',
      )
    await input.emptyArchive.assertProvenance()
  }
  const chunkRows = input.chunkRows ?? 250
  if (!Number.isSafeInteger(chunkRows) || chunkRows < 1 || chunkRows > 10_000) {
    throw new LogicalDatabaseExportError(
      'logical-export-row-census',
      'logical export chunk size must be between 1 and 10000',
    )
  }
  const now = input.now ?? Date.now
  const entries: LogicalTableArtifactEntry[] = []
  let activeRows = 0
  let archiveRows = 0
  let chunksWritten = 0
  let bytesWritten = 0
  let tablesCompleted = 0

  const persist = (
    table: LogicalTableContract,
    rows: readonly CanonicalLogicalRow[],
    index: number,
  ) => {
    const chunk = createLogicalTableChunk({
      operationId: input.operationId,
      contract: input.contract,
      table,
      chunkIndex: index,
      rows,
    })
    const path = writeLogicalTableChunk(input.artifactRoot, chunk)
    const persisted = readLogicalTableChunk(path)
    chunksWritten += 1
    bytesWritten += Buffer.byteLength(canonicalSchemaJson(persisted), 'utf8')
    return persisted
  }

  for (const table of input.contract.tables) {
    const accumulator = createTableEntryAccumulator({ table, contract: input.contract })
    if (table.disposition === 'ARCHIVE_THEN_OMIT' && input.sourceProvider === 'postgresql') {
      if (input.emptyArchive === undefined) {
        const preserved = input.preservedArchive!
        const entry = preserved.verification.manifest.payload.tables.find(
          (candidate) => candidate.table === table.id,
        )
        if (entry === undefined || entry.disposition !== 'ARCHIVE_THEN_OMIT') {
          throw new LogicalDatabaseExportError(
            'logical-export-archive-required',
            `preserved logical archive is missing ${table.id}`,
          )
        }
        for (let index = 0; index < entry.chunkCount; index += 1) {
          const sourceChunk = preserved.readChunk(table, index)
          accumulator.add(persist(table, sourceChunk.payload.rows, index))
        }
      }
    } else {
      let afterKey: readonly CanonicalLogicalValue[] | null = null
      let previousKey: readonly CanonicalLogicalValue[] | null = null
      let tableRowsRead = 0
      const expectedProviderRows = input.expectedTableRows[table.id]!
      while (true) {
        await input.source.assertUnchanged()
        const rows = await input.source.readChunk(table, afterKey, chunkRows)
        if (rows.length === 0) break
        if (rows.length > chunkRows) {
          throw new LogicalDatabaseExportError(
            'logical-export-source-order',
            `logical export source exceeded the chunk bound for ${table.id}`,
          )
        }
        tableRowsRead += rows.length
        if (tableRowsRead > expectedProviderRows) {
          throw new LogicalDatabaseExportError(
            'logical-export-source-order',
            `logical export source exceeded the frozen row census for ${table.id}`,
          )
        }
        for (const row of rows) {
          if (previousKey !== null && compareCanonicalLogicalKeys(previousKey, row.key) >= 0) {
            throw new LogicalDatabaseExportError(
              'logical-export-source-order',
              `logical export source did not advance in stable order for ${table.id}`,
            )
          }
          previousKey = row.key
        }
        accumulator.add(persist(table, rows, accumulator.count()))
        afterKey = rows.at(-1)!.key
        if (rows.length < chunkRows) break
      }
    }
    const entry = accumulator.finish()
    const expectedRows =
      table.disposition === 'ARCHIVE_THEN_OMIT' && input.sourceProvider === 'postgresql'
        ? input.emptyArchive !== undefined
          ? 0
          : input.preservedArchive!.verification.manifest.payload.tables.find(
              (candidate) => candidate.table === table.id,
            )?.rowCount
        : input.expectedTableRows[table.id]
    if (entry.rowCount !== expectedRows) {
      throw new LogicalDatabaseExportError(
        'logical-export-row-census',
        `logical export row census differs for ${table.id}`,
      )
    }
    entries.push(entry)
    if (table.disposition === 'ARCHIVE_THEN_OMIT') archiveRows += entry.rowCount
    else activeRows += entry.rowCount
    tablesCompleted += 1
    input.onProgress?.({
      operationId: input.operationId,
      table: table.id,
      chunk: entry.chunkCount,
      tablesCompleted,
      tablesTotal: input.contract.tables.length,
      rowsExported: activeRows + archiveRows,
      bytesExported: bytesWritten,
    })
  }
  await input.source.assertUnchanged()
  await input.emptyArchive?.assertProvenance()
  const manifest = createLogicalArtifactManifest({
    operationId: input.operationId,
    sourceProvider: input.sourceProvider,
    sourceGenerationId: input.sourceGenerationId,
    contract: input.contract,
    createdAt: now(),
    tables: entries,
  })
  writeLogicalArtifactManifest(input.artifactRoot, manifest)
  const legacyArchiveFileDigest = writeDurableLogicalArtifact(
    join(input.artifactRoot, 'legacy-archive', 'manifest.json'),
    createLegacyArchiveManifest({
      operationId: input.operationId,
      schemaDigest: input.contract.digest,
      tables: entries.filter((entry) => entry.disposition === 'ARCHIVE_THEN_OMIT'),
    }),
  )
  const metadata = await input.source.readMetadata?.()
  if ('schemaEpoch' in input.contract && input.contract.schemaEpoch === 2 && !metadata)
    throw new Error('epoch2-metadata-source-required')
  const epoch2MetadataFileDigest = metadata
    ? writeDurableLogicalArtifact(
        join(input.artifactRoot, 'epoch2-metadata.json'),
        verifyEpochMetadataSnapshot(metadata),
      )
    : undefined
  await input.source.assertUnchanged()
  const envelopePayload = LogicalDatabaseBackupEnvelopePayloadSchema.parse({
    version: 1,
    operationId: input.operationId,
    sourceProvider: input.sourceProvider,
    sourceGenerationId: input.sourceGenerationId,
    schemaDigest: input.contract.digest,
    logicalManifestDigest: manifest.digest,
    legacyArchiveFileDigest,
    activeTableCount: input.contract.activeTableCount,
    archiveOnlyTableCount: input.contract.archiveOnlyTableCount,
    activeRows,
    archiveRows,
    chunks: chunksWritten,
    bytes: bytesWritten,
    completedAt: now(),
    ...(epoch2MetadataFileDigest ? { epoch2MetadataFileDigest } : {}),
  })
  const envelope = LogicalDatabaseBackupEnvelopeSchema.parse({
    payload: envelopePayload,
    digest: digestSchemaContract(envelopePayload),
  })
  const envelopeFileDigest = writeDurableLogicalArtifact(
    join(input.artifactRoot, LOGICAL_DATABASE_BACKUP_ENVELOPE),
    envelope,
  )
  return Object.freeze({
    manifest,
    legacyArchiveFileDigest,
    envelope,
    envelopeFileDigest,
    activeRows,
    archiveRows,
    chunks: chunksWritten,
    bytes: bytesWritten,
  })
}
