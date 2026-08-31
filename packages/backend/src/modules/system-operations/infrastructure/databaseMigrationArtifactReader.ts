// RFC-349 — bounded, fail-closed reads for migration receipts and the six
// archive-only tables. Paths are derived from validated operation/table/kind
// values; callers never receive an arbitrary filesystem path.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { DatabaseMigrationControlPlane } from '../application/databaseMigrationControlPlane'
import type {
  DatabaseMigrationArtifactInput,
  DatabaseMigrationArtifactKind,
  DatabaseMigrationArtifactView,
  DatabaseMigrationLegacyChunkInput,
  DatabaseMigrationLegacyTableInput,
  DatabaseMigrationLegacyTableView,
} from '../public/types'
import type { DatabaseMigrationManifest } from '../domain/databaseMigration'
import { digestDatabaseArtifact } from '@/platform/persistence/generationStore'
import {
  logicalChunkPath,
  verifyLegacyArchiveManifest,
  verifyLogicalArtifactManifest,
  verifyLogicalTableChunk,
  type LegacyArchiveManifest,
  type LogicalDatabaseArtifactManifest,
  type LogicalTableArtifactEntry,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  canonicalSchemaJson,
  digestSchemaContract,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const operationIdSchema = z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/)
const generationIdSchema = z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/)

const verificationArtifactSchema = z
  .object({
    version: z.literal(1),
    operationId: operationIdSchema,
    sourceGenerationId: generationIdSchema,
    sourceFingerprint: z.string().min(1).max(256),
    targetFingerprint: z.string().min(1).max(256).nullable(),
    schemaDigest: digestSchema,
    logicalBackupDigest: digestSchema,
    legacyArchiveDigest: digestSchema,
    activeTableCount: z.number().int().nonnegative(),
    archiveOnlyTableCount: z.number().int().nonnegative(),
    verifiedAt: z.number().int().nonnegative(),
  })
  .strict()

const receiptArtifactSchema = z
  .object({
    version: z.literal(1),
    operationId: operationIdSchema,
    sourceGenerationId: generationIdSchema,
    targetGenerationId: generationIdSchema,
    schemaDigest: digestSchema,
    logicalBackupDigest: digestSchema,
    legacyArchiveDigest: digestSchema,
    verificationDigest: digestSchema,
    firstLiveWriteAt: z.number().int().nonnegative().nullable(),
    finalizedAt: z.number().int().nonnegative(),
  })
  .strict()

const rollbackReceiptArtifactSchema = z
  .object({
    version: z.literal(1),
    operationId: operationIdSchema,
    sourceGenerationId: generationIdSchema,
    retiredTargetGenerationId: generationIdSchema,
    schemaDigest: digestSchema,
    verificationDigest: digestSchema,
    firstLiveWriteAt: z.null(),
    rolledBackAt: z.number().int().nonnegative(),
  })
  .strict()

type ArtifactDigestField =
  | 'legacyArchiveDigest'
  | 'verificationDigest'
  | 'receiptDigest'
  | 'rollbackReceiptDigest'

interface RawArtifact {
  readonly body: string
  readonly fileDigest: string
}

export class DatabaseMigrationArtifactError extends Error {
  constructor(
    public readonly code:
      | 'database-migration-artifact-unavailable'
      | 'database-migration-artifact-corrupt'
      | 'database-migration-legacy-table-not-found'
      | 'database-migration-legacy-chunk-not-found',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseMigrationArtifactError'
  }
}

export interface DatabaseMigrationArtifactReader {
  readArtifact(input: DatabaseMigrationArtifactInput): DatabaseMigrationArtifactView
  inspectLegacyTable(input: DatabaseMigrationLegacyTableInput): DatabaseMigrationLegacyTableView
  readLegacyChunk(input: DatabaseMigrationLegacyChunkInput): DatabaseMigrationArtifactView
}

function readRaw(path: string): RawArtifact {
  try {
    const body = readFileSync(path, 'utf8')
    return Object.freeze({ body, fileDigest: digestDatabaseArtifact(body) })
  } catch {
    throw new DatabaseMigrationArtifactError(
      'database-migration-artifact-unavailable',
      'database migration artifact is not available',
    )
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw new DatabaseMigrationArtifactError(
      'database-migration-artifact-corrupt',
      'database migration artifact is not valid JSON',
    )
  }
}

function requireDigest(value: string | null, kind: string): string {
  if (value === null) {
    throw new DatabaseMigrationArtifactError(
      'database-migration-artifact-unavailable',
      `database migration ${kind} artifact has not been produced`,
    )
  }
  return value
}

function assertEqual(actual: unknown, expected: unknown, detail: string): void {
  if (actual !== expected) {
    throw new DatabaseMigrationArtifactError(
      'database-migration-artifact-corrupt',
      `database migration artifact mismatch: ${detail}`,
    )
  }
}

function projectKey(key: LogicalTableArtifactEntry['firstKey']): string[] | null {
  return key?.map((value) => JSON.stringify(value)) ?? null
}

export function createDatabaseMigrationArtifactReader(input: {
  readonly operationsRoot: string
  readonly controlPlane: DatabaseMigrationControlPlane
  readonly contract: LogicalSchemaContract
}): DatabaseMigrationArtifactReader {
  const operationRoot = (operationId: string): string => join(input.operationsRoot, operationId)
  const readControl = (operationId: string): DatabaseMigrationManifest =>
    input.controlPlane.readManifest(operationId)

  const readLogical = (
    operationId: string,
    control: DatabaseMigrationManifest,
  ): { readonly raw: RawArtifact; readonly manifest: LogicalDatabaseArtifactManifest } => {
    const expected = requireDigest(control.payload.logicalBackupDigest, 'logical-backup')
    const raw = readRaw(join(operationRoot(operationId), 'logical-manifest.json'))
    let manifest: LogicalDatabaseArtifactManifest
    try {
      manifest = verifyLogicalArtifactManifest(parseJson(raw.body))
    } catch (error) {
      if (error instanceof DatabaseMigrationArtifactError) throw error
      throw new DatabaseMigrationArtifactError(
        'database-migration-artifact-corrupt',
        'logical database manifest failed validation',
      )
    }
    assertEqual(manifest.digest, expected, 'logical manifest digest')
    assertEqual(manifest.payload.operationId, operationId, 'logical manifest operation')
    assertEqual(
      manifest.payload.sourceGenerationId,
      control.payload.source.generationId,
      'source generation',
    )
    assertEqual(manifest.payload.schemaDigest, input.contract.digest, 'logical schema digest')
    assertEqual(
      manifest.payload.activeTableCount,
      input.contract.activeTableCount,
      'active table count',
    )
    assertEqual(
      manifest.payload.archiveOnlyTableCount,
      input.contract.archiveOnlyTableCount,
      'archive-only table count',
    )
    assertEqual(raw.body, canonicalSchemaJson(manifest), 'logical manifest canonical bytes')

    const contractTables = new Map(input.contract.tables.map((table) => [table.id, table]))
    assertEqual(manifest.payload.tables.length, contractTables.size, 'logical table roster size')
    for (const entry of manifest.payload.tables) {
      const table = contractTables.get(entry.table)
      if (table === undefined) {
        throw new DatabaseMigrationArtifactError(
          'database-migration-artifact-corrupt',
          `logical database manifest contains an unknown table: ${entry.table}`,
        )
      }
      assertEqual(entry.disposition, table.disposition, `${entry.table} disposition`)
      assertEqual(entry.chunkDigests.length, entry.chunkCount, `${entry.table} chunk count`)
      assertEqual(
        entry.rootDigest,
        digestSchemaContract({
          table: entry.table,
          schemaDigest: entry.chunkCount === 0 ? null : input.contract.digest,
          rowCount: entry.rowCount,
          chunkDigests: entry.chunkDigests,
        }),
        `${entry.table} root digest`,
      )
      contractTables.delete(entry.table)
    }
    assertEqual(contractTables.size, 0, 'logical table roster completeness')
    return Object.freeze({ raw, manifest })
  }

  const readLegacy = (
    operationId: string,
    control: DatabaseMigrationManifest,
  ): { readonly raw: RawArtifact; readonly manifest: LegacyArchiveManifest } => {
    const expected = requireDigest(control.payload.legacyArchiveDigest, 'legacy-archive')
    const logical = readLogical(operationId, control)
    const raw = readRaw(join(operationRoot(operationId), 'legacy-archive', 'manifest.json'))
    assertEqual(raw.fileDigest, expected, 'legacy archive file digest')
    let manifest: LegacyArchiveManifest
    try {
      manifest = verifyLegacyArchiveManifest(parseJson(raw.body))
    } catch (error) {
      if (error instanceof DatabaseMigrationArtifactError) throw error
      throw new DatabaseMigrationArtifactError(
        'database-migration-artifact-corrupt',
        'legacy archive manifest failed validation',
      )
    }
    assertEqual(manifest.operationId, operationId, 'legacy archive operation')
    assertEqual(manifest.schemaDigest, input.contract.digest, 'legacy archive schema digest')
    assertEqual(raw.body, canonicalSchemaJson(manifest), 'legacy archive canonical bytes')
    const logicalArchive = logical.manifest.payload.tables.filter(
      (table) => table.disposition === 'ARCHIVE_THEN_OMIT',
    )
    assertEqual(
      canonicalSchemaJson(manifest.tables),
      canonicalSchemaJson(logicalArchive),
      'legacy archive/logical manifest table projection',
    )
    const expectedTables = input.contract.tables
      .filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT')
      .map((table) => table.id)
      .sort()
    assertEqual(
      canonicalSchemaJson(manifest.tables.map((table) => table.table).sort()),
      canonicalSchemaJson(expectedTables),
      'legacy archive roster',
    )
    return Object.freeze({ raw, manifest })
  }

  const readAnchoredJson = (
    operationId: string,
    control: DatabaseMigrationManifest,
    kind: Exclude<DatabaseMigrationArtifactKind, 'logical-backup' | 'legacy-archive'>,
    fileName: string,
    digestField: ArtifactDigestField,
  ): RawArtifact => {
    const expected = requireDigest(control.payload[digestField], kind)
    const raw = readRaw(join(operationRoot(operationId), fileName))
    assertEqual(raw.fileDigest, expected, `${kind} file digest`)
    const value = parseJson(raw.body)
    const assertBase = (parsed: {
      readonly operationId: string
      readonly sourceGenerationId: string
      readonly schemaDigest: string
    }) => {
      assertEqual(parsed.operationId, operationId, `${kind} operation`)
      assertEqual(
        parsed.sourceGenerationId,
        control.payload.source.generationId,
        `${kind} source generation`,
      )
      assertEqual(parsed.schemaDigest, input.contract.digest, `${kind} schema digest`)
    }
    if (kind === 'verification') {
      const parsed = verificationArtifactSchema.parse(value)
      assertBase(parsed)
      assertEqual(
        parsed.logicalBackupDigest,
        control.payload.logicalBackupDigest,
        `${kind} logical digest`,
      )
      assertEqual(
        parsed.legacyArchiveDigest,
        control.payload.legacyArchiveDigest,
        `${kind} archive digest`,
      )
    } else if (kind === 'receipt') {
      const parsed = receiptArtifactSchema.parse(value)
      assertBase(parsed)
      assertEqual(
        parsed.logicalBackupDigest,
        control.payload.logicalBackupDigest,
        `${kind} logical digest`,
      )
      assertEqual(
        parsed.legacyArchiveDigest,
        control.payload.legacyArchiveDigest,
        `${kind} archive digest`,
      )
      assertEqual(
        parsed.verificationDigest,
        control.payload.verificationDigest,
        `${kind} verification digest`,
      )
    } else {
      const parsed = rollbackReceiptArtifactSchema.parse(value)
      assertBase(parsed)
      assertEqual(
        parsed.verificationDigest,
        control.payload.verificationDigest,
        `${kind} verification digest`,
      )
    }
    return raw
  }

  const view = (value: {
    readonly operationId: string
    readonly kind: DatabaseMigrationArtifactView['kind']
    readonly fileName: string
    readonly digest: string
    readonly raw: RawArtifact
  }): DatabaseMigrationArtifactView =>
    Object.freeze({
      operationId: value.operationId,
      kind: value.kind,
      fileName: value.fileName,
      contentType: 'application/json; charset=utf-8' as const,
      byteLength: Buffer.byteLength(value.raw.body, 'utf8'),
      digest: value.digest,
      fileDigest: value.raw.fileDigest,
      json: value.raw.body,
    })

  const reader: DatabaseMigrationArtifactReader = {
    readArtifact(query) {
      const control = readControl(query.operationId)
      if (query.kind === 'logical-backup') {
        const artifact = readLogical(query.operationId, control)
        return view({
          operationId: query.operationId,
          kind: query.kind,
          fileName: `${query.operationId}-logical-backup.json`,
          digest: artifact.manifest.digest,
          raw: artifact.raw,
        })
      }
      if (query.kind === 'legacy-archive') {
        const artifact = readLegacy(query.operationId, control)
        return view({
          operationId: query.operationId,
          kind: query.kind,
          fileName: `${query.operationId}-legacy-archive.json`,
          digest: requireDigest(control.payload.legacyArchiveDigest, query.kind),
          raw: artifact.raw,
        })
      }
      const spec = {
        verification: {
          fileName: 'verification.json',
          digestField: 'verificationDigest',
        },
        receipt: { fileName: 'receipt.json', digestField: 'receiptDigest' },
        'rollback-receipt': {
          fileName: 'rollback-receipt.json',
          digestField: 'rollbackReceiptDigest',
        },
      } as const
      const selected = spec[query.kind]
      const raw = readAnchoredJson(
        query.operationId,
        control,
        query.kind,
        selected.fileName,
        selected.digestField,
      )
      return view({
        operationId: query.operationId,
        kind: query.kind,
        fileName: `${query.operationId}-${selected.fileName}`,
        digest: requireDigest(control.payload[selected.digestField], query.kind),
        raw,
      })
    },

    inspectLegacyTable(query) {
      const control = readControl(query.operationId)
      const artifact = readLegacy(query.operationId, control)
      const entry = artifact.manifest.tables.find((table) => table.table === query.table)
      if (entry === undefined) {
        throw new DatabaseMigrationArtifactError(
          'database-migration-legacy-table-not-found',
          `table is not present in the approved legacy archive: ${query.table}`,
        )
      }
      return Object.freeze({
        operationId: query.operationId,
        table: entry.table,
        disposition: 'ARCHIVE_THEN_OMIT' as const,
        rowCount: entry.rowCount,
        chunkCount: entry.chunkCount,
        firstKey: projectKey(entry.firstKey),
        lastKey: projectKey(entry.lastKey),
        rootDigest: entry.rootDigest,
        blobBytes: entry.blobBytes,
      })
    },

    readLegacyChunk(query) {
      const control = readControl(query.operationId)
      const artifact = readLegacy(query.operationId, control)
      const entry = artifact.manifest.tables.find((table) => table.table === query.table)
      if (entry === undefined) {
        throw new DatabaseMigrationArtifactError(
          'database-migration-legacy-table-not-found',
          `table is not present in the approved legacy archive: ${query.table}`,
        )
      }
      const expected = entry.chunkDigests[query.chunkIndex]
      if (expected === undefined || query.chunkIndex >= entry.chunkCount) {
        throw new DatabaseMigrationArtifactError(
          'database-migration-legacy-chunk-not-found',
          `legacy archive chunk does not exist: ${query.table}/${query.chunkIndex}`,
        )
      }
      const table = input.contract.tables.find((candidate) => candidate.id === query.table)
      if (table === undefined || table.disposition !== 'ARCHIVE_THEN_OMIT') {
        throw new DatabaseMigrationArtifactError(
          'database-migration-artifact-corrupt',
          `legacy archive table is absent from the schema contract: ${query.table}`,
        )
      }
      const raw = readRaw(
        logicalChunkPath(operationRoot(query.operationId), table, query.chunkIndex),
      )
      let chunk
      try {
        chunk = verifyLogicalTableChunk(parseJson(raw.body))
      } catch (error) {
        if (error instanceof DatabaseMigrationArtifactError) throw error
        throw new DatabaseMigrationArtifactError(
          'database-migration-artifact-corrupt',
          'legacy archive chunk failed validation',
        )
      }
      assertEqual(chunk.digest, expected, 'legacy chunk digest')
      assertEqual(chunk.payload.operationId, query.operationId, 'legacy chunk operation')
      assertEqual(chunk.payload.schemaDigest, input.contract.digest, 'legacy chunk schema digest')
      assertEqual(chunk.payload.table, query.table, 'legacy chunk table')
      assertEqual(chunk.payload.disposition, 'ARCHIVE_THEN_OMIT', 'legacy chunk disposition')
      assertEqual(chunk.payload.chunkIndex, query.chunkIndex, 'legacy chunk index')
      assertEqual(raw.body, canonicalSchemaJson(chunk), 'legacy chunk canonical bytes')
      return view({
        operationId: query.operationId,
        kind: 'legacy-archive-chunk',
        fileName: `${query.operationId}-${query.table}-chunk-${String(query.chunkIndex).padStart(8, '0')}.json`,
        digest: chunk.digest,
        raw,
      })
    },
  }
  return Object.freeze(reader)
}
