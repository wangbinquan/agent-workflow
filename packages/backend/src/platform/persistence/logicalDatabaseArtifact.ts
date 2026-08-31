// RFC-349 — provider-neutral logical row/chunk codec and durable artifact I/O.
//
// The format intentionally carries tagged scalar values instead of relying on
// JSON's number coercion. That keeps signed 64-bit integers, booleans, NULL,
// blobs and arbitrary JSON text byte-equivalent across SQLite and PostgreSQL.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { sha256Hex } from '@/util/hash'
import {
  canonicalSchemaJson,
  digestSchemaContract,
  type LogicalColumnContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from './schemaContract'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const OperationIdSchema = z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/)
const TableIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)

export const CanonicalLogicalValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('null') }).strict(),
  z.object({ type: z.literal('boolean'), value: z.boolean() }).strict(),
  z
    .object({ type: z.literal('integer'), value: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/) })
    .strict(),
  z
    .object({
      type: z.literal('real'),
      value: z.string().refine((value) => Number.isFinite(Number(value))),
    })
    .strict(),
  z.object({ type: z.literal('text'), value: z.string() }).strict(),
  z
    .object({
      type: z.literal('bytes'),
      value: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .strict(),
])

export type CanonicalLogicalValue = z.infer<typeof CanonicalLogicalValueSchema>

export const CanonicalLogicalRowSchema = z
  .object({
    key: z.array(CanonicalLogicalValueSchema).min(1),
    values: z.array(CanonicalLogicalValueSchema),
  })
  .strict()

export type CanonicalLogicalRow = z.infer<typeof CanonicalLogicalRowSchema>

const LogicalTableChunkPayloadSchema = z
  .object({
    version: z.literal(1),
    operationId: OperationIdSchema,
    schemaDigest: DigestSchema,
    table: TableIdSchema,
    disposition: z.enum(['KEEP', 'ARCHIVE_THEN_OMIT', 'DEFER']),
    chunkIndex: z.number().int().nonnegative(),
    columns: z.array(z.string()).min(1),
    migrationKey: z.array(z.string()).min(1),
    rows: z.array(CanonicalLogicalRowSchema),
  })
  .strict()

export type LogicalTableChunkPayload = z.infer<typeof LogicalTableChunkPayloadSchema>

const LogicalTableChunkSchema = z
  .object({ payload: LogicalTableChunkPayloadSchema, digest: DigestSchema })
  .strict()

export type LogicalTableChunk = z.infer<typeof LogicalTableChunkSchema>

const LogicalTableArtifactEntrySchema = z
  .object({
    table: TableIdSchema,
    disposition: z.enum(['KEEP', 'ARCHIVE_THEN_OMIT', 'DEFER']),
    rowCount: z.number().int().nonnegative(),
    chunkCount: z.number().int().nonnegative(),
    firstKey: z.array(CanonicalLogicalValueSchema).nullable(),
    lastKey: z.array(CanonicalLogicalValueSchema).nullable(),
    chunkDigests: z.array(DigestSchema),
    rootDigest: DigestSchema,
    blobBytes: z.number().int().nonnegative(),
  })
  .strict()

export type LogicalTableArtifactEntry = z.infer<typeof LogicalTableArtifactEntrySchema>

const LegacyArchiveManifestSchema = z
  .object({
    version: z.literal(1),
    operationId: OperationIdSchema,
    schemaDigest: DigestSchema,
    tables: z.array(LogicalTableArtifactEntrySchema),
    digest: DigestSchema,
  })
  .strict()

export type LegacyArchiveManifest = z.infer<typeof LegacyArchiveManifestSchema>

const LogicalDatabaseArtifactPayloadSchema = z
  .object({
    version: z.literal(1),
    format: z.literal('agent-workflow-logical-database-v1'),
    operationId: OperationIdSchema,
    sourceProvider: z.enum(['sqlite', 'postgresql']),
    sourceGenerationId: z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/),
    schemaDigest: DigestSchema,
    contractVersion: z.number().int().positive(),
    activeTableCount: z.number().int().nonnegative(),
    archiveOnlyTableCount: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    tables: z.array(LogicalTableArtifactEntrySchema),
  })
  .strict()

export type LogicalDatabaseArtifactPayload = z.infer<typeof LogicalDatabaseArtifactPayloadSchema>

const LogicalDatabaseArtifactManifestSchema = z
  .object({ payload: LogicalDatabaseArtifactPayloadSchema, digest: DigestSchema })
  .strict()

export type LogicalDatabaseArtifactManifest = z.infer<typeof LogicalDatabaseArtifactManifestSchema>

export class LogicalDatabaseCodecError extends Error {
  constructor(
    public readonly code:
      | 'logical-codec-type'
      | 'logical-codec-json'
      | 'logical-codec-row-shape'
      | 'logical-artifact-corrupt'
      | 'logical-artifact-conflict',
    message: string,
  ) {
    super(message)
    this.name = 'LogicalDatabaseCodecError'
  }
}

function integerString(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value)) return value
  return null
}

function codecFailure(table: string, column: string, detail: string): never {
  throw new LogicalDatabaseCodecError(
    'logical-codec-type',
    `logical database codec rejected ${table}.${column}: ${detail}`,
  )
}

export function encodeLogicalValue(
  table: string,
  column: LogicalColumnContract,
  value: unknown,
): CanonicalLogicalValue {
  if (value === null) {
    if (!column.nullable) codecFailure(table, column.name, 'unexpected NULL')
    return { type: 'null' }
  }
  switch (column.logicalCodec) {
    case 'boolean': {
      if (value === true || value === 1 || value === 1n) {
        return { type: 'boolean', value: true }
      }
      if (value === false || value === 0 || value === 0n) {
        return { type: 'boolean', value: false }
      }
      return codecFailure(table, column.name, 'expected SQLite 0/1 or boolean')
    }
    case 'epoch-milliseconds':
    case 'integer': {
      const encoded = integerString(value)
      if (encoded === null) {
        return codecFailure(table, column.name, 'expected a signed lossless integer')
      }
      return { type: 'integer', value: encoded }
    }
    case 'real': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return codecFailure(table, column.name, 'expected a finite real')
      }
      return { type: 'real', value: Object.is(value, -0) ? '0' : String(value) }
    }
    case 'json-text':
      if (typeof value !== 'string') return codecFailure(table, column.name, 'expected JSON text')
      try {
        JSON.parse(value)
      } catch {
        throw new LogicalDatabaseCodecError(
          'logical-codec-json',
          `logical database codec rejected invalid JSON at ${table}.${column.name}`,
        )
      }
      return { type: 'text', value }
    case 'text':
    case 'text-identity':
      if (typeof value !== 'string') return codecFailure(table, column.name, 'expected text')
      return { type: 'text', value }
    case 'opaque-bytes':
      if (!(value instanceof Uint8Array)) {
        return codecFailure(table, column.name, 'expected bytes')
      }
      return { type: 'bytes', value: Buffer.from(value).toString('base64') }
  }
}

export function decodeLogicalValue(value: CanonicalLogicalValue): unknown {
  switch (value.type) {
    case 'null':
      return null
    case 'boolean':
      return value.value
    case 'integer': {
      const parsed = BigInt(value.value)
      return parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(parsed)
        : parsed
    }
    case 'real':
      return Number(value.value)
    case 'text':
      return value.value
    case 'bytes':
      return Buffer.from(value.value, 'base64')
  }
}

export function compareCanonicalLogicalKeys(
  left: readonly CanonicalLogicalValue[],
  right: readonly CanonicalLogicalValue[],
): number {
  if (left.length !== right.length) {
    throw new LogicalDatabaseCodecError(
      'logical-codec-row-shape',
      'logical database migration keys have different shapes',
    )
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!
    const rightValue = right[index]!
    if (
      leftValue.type !== rightValue.type ||
      leftValue.type === 'null' ||
      rightValue.type === 'null'
    ) {
      throw new LogicalDatabaseCodecError(
        'logical-codec-row-shape',
        'logical database migration keys have incompatible scalar types',
      )
    }
    let compared = 0
    switch (leftValue.type) {
      case 'boolean':
        compared = Number(leftValue.value) - Number((rightValue as typeof leftValue).value)
        break
      case 'integer': {
        const leftInteger = BigInt(leftValue.value)
        const rightInteger = BigInt((rightValue as typeof leftValue).value)
        compared = leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0
        break
      }
      case 'real': {
        const leftReal = Number(leftValue.value)
        const rightReal = Number((rightValue as typeof leftValue).value)
        compared = leftReal < rightReal ? -1 : leftReal > rightReal ? 1 : 0
        break
      }
      case 'text':
        compared = Buffer.compare(
          Buffer.from(leftValue.value, 'utf8'),
          Buffer.from((rightValue as typeof leftValue).value, 'utf8'),
        )
        break
      case 'bytes':
        compared = Buffer.compare(
          Buffer.from(leftValue.value, 'base64'),
          Buffer.from((rightValue as typeof leftValue).value, 'base64'),
        )
        break
    }
    if (compared !== 0) return compared < 0 ? -1 : 1
  }
  return 0
}

export function encodeLogicalRow(
  table: LogicalTableContract,
  row: Readonly<Record<string, unknown>>,
): CanonicalLogicalRow {
  const values = table.columns.map((column) => {
    if (!(column.name in row)) {
      throw new LogicalDatabaseCodecError(
        'logical-codec-row-shape',
        `logical database row is missing ${table.id}.${column.name}`,
      )
    }
    return encodeLogicalValue(table.id, column, row[column.name])
  })
  const byColumn = new Map(table.columns.map((column, index) => [column.name, values[index]!]))
  return {
    key: table.migrationKey.map((column) => {
      const value = byColumn.get(column)
      if (value === undefined || value.type === 'null') {
        throw new LogicalDatabaseCodecError(
          'logical-codec-row-shape',
          `logical database migration key is NULL or missing at ${table.id}.${column}`,
        )
      }
      return value
    }),
    values,
  }
}

export function decodeLogicalRow(
  table: LogicalTableContract,
  row: CanonicalLogicalRow,
): Readonly<Record<string, unknown>> {
  if (row.values.length !== table.columns.length || row.key.length !== table.migrationKey.length) {
    throw new LogicalDatabaseCodecError(
      'logical-codec-row-shape',
      `logical database row shape does not match ${table.id}`,
    )
  }
  return Object.fromEntries(
    table.columns.map((column, index) => [column.name, decodeLogicalValue(row.values[index]!)]),
  )
}

export function logicalChunkDigest(payload: LogicalTableChunkPayload): string {
  return digestSchemaContract(payload)
}

export function createLogicalTableChunk(input: {
  readonly operationId: string
  readonly contract: LogicalSchemaContract
  readonly table: LogicalTableContract
  readonly chunkIndex: number
  readonly rows: readonly CanonicalLogicalRow[]
}): LogicalTableChunk {
  const payload = LogicalTableChunkPayloadSchema.parse({
    version: 1,
    operationId: input.operationId,
    schemaDigest: input.contract.digest,
    table: input.table.id,
    disposition: input.table.disposition,
    chunkIndex: input.chunkIndex,
    columns: input.table.columns.map((column) => column.name),
    migrationKey: input.table.migrationKey,
    rows: input.rows,
  })
  return { payload, digest: logicalChunkDigest(payload) }
}

export function verifyLogicalTableChunk(value: unknown): LogicalTableChunk {
  const parsed = LogicalTableChunkSchema.safeParse(value)
  if (!parsed.success || logicalChunkDigest(parsed.data.payload) !== parsed.data.digest) {
    throw new LogicalDatabaseCodecError(
      'logical-artifact-corrupt',
      'logical database chunk failed validation or digest verification',
    )
  }
  return parsed.data
}

function fsyncDirectory(path: string): void {
  try {
    const handle = openSync(path, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    // Directory fsync is unavailable on some Windows/filesystem combinations.
  }
}

function durableWriteOnce(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === body) return
    throw new LogicalDatabaseCodecError(
      'logical-artifact-conflict',
      `logical database artifact conflicts with an existing checkpoint: ${path}`,
    )
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`
  let installed = false
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = openSync(temporary, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, path)
    installed = true
    fsyncDirectory(dirname(path))
  } finally {
    if (!installed && existsSync(temporary)) unlinkSync(temporary)
  }
}

export function writeDurableLogicalArtifact(path: string, value: unknown): string {
  const body = canonicalSchemaJson(value)
  durableWriteOnce(path, body)
  return `sha256:${sha256Hex(body)}`
}

export function logicalChunkPath(
  operationRoot: string,
  table: LogicalTableContract,
  chunkIndex: number,
): string {
  const area = table.disposition === 'ARCHIVE_THEN_OMIT' ? 'legacy-archive' : 'chunks'
  return join(operationRoot, area, table.id, `chunk-${String(chunkIndex).padStart(8, '0')}.json`)
}

export function writeLogicalTableChunk(operationRoot: string, chunk: LogicalTableChunk): string {
  const table = TableIdSchema.parse(chunk.payload.table)
  const area = chunk.payload.disposition === 'ARCHIVE_THEN_OMIT' ? 'legacy-archive' : 'chunks'
  const path = join(
    operationRoot,
    area,
    table,
    `chunk-${String(chunk.payload.chunkIndex).padStart(8, '0')}.json`,
  )
  durableWriteOnce(path, canonicalSchemaJson(verifyLogicalTableChunk(chunk)))
  return path
}

export function readLogicalTableChunk(path: string): LogicalTableChunk {
  try {
    return verifyLogicalTableChunk(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof LogicalDatabaseCodecError) throw error
    throw new LogicalDatabaseCodecError(
      'logical-artifact-corrupt',
      `logical database chunk is unreadable: ${path}`,
    )
  }
}

export function createLogicalArtifactManifest(input: {
  readonly operationId: string
  readonly sourceProvider: 'sqlite' | 'postgresql'
  readonly sourceGenerationId: string
  readonly contract: LogicalSchemaContract
  readonly createdAt: number
  readonly tables: readonly LogicalTableArtifactEntry[]
}): LogicalDatabaseArtifactManifest {
  const payload = LogicalDatabaseArtifactPayloadSchema.parse({
    version: 1,
    format: 'agent-workflow-logical-database-v1',
    operationId: input.operationId,
    sourceProvider: input.sourceProvider,
    sourceGenerationId: input.sourceGenerationId,
    schemaDigest: input.contract.digest,
    contractVersion: input.contract.contractVersion,
    activeTableCount: input.contract.activeTableCount,
    archiveOnlyTableCount: input.contract.archiveOnlyTableCount,
    createdAt: input.createdAt,
    tables: [...input.tables].sort((left, right) => left.table.localeCompare(right.table)),
  })
  return { payload, digest: digestSchemaContract(payload) }
}

export function verifyLogicalArtifactManifest(value: unknown): LogicalDatabaseArtifactManifest {
  const parsed = LogicalDatabaseArtifactManifestSchema.safeParse(value)
  if (!parsed.success || digestSchemaContract(parsed.data.payload) !== parsed.data.digest) {
    throw new LogicalDatabaseCodecError(
      'logical-artifact-corrupt',
      'logical database manifest failed validation or digest verification',
    )
  }
  return parsed.data
}

export function writeLogicalArtifactManifest(
  operationRoot: string,
  manifest: LogicalDatabaseArtifactManifest,
): string {
  const path = join(operationRoot, 'logical-manifest.json')
  durableWriteOnce(path, canonicalSchemaJson(verifyLogicalArtifactManifest(manifest)))
  return path
}

export function readLogicalArtifactManifest(path: string): LogicalDatabaseArtifactManifest {
  try {
    return verifyLogicalArtifactManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof LogicalDatabaseCodecError) throw error
    throw new LogicalDatabaseCodecError(
      'logical-artifact-corrupt',
      `logical database manifest is unreadable: ${path}`,
    )
  }
}

export function createLegacyArchiveManifest(input: {
  readonly operationId: string
  readonly schemaDigest: string
  readonly tables: readonly LogicalTableArtifactEntry[]
}): LegacyArchiveManifest {
  const tables = [...input.tables].sort((left, right) => left.table.localeCompare(right.table))
  if (tables.some((table) => table.disposition !== 'ARCHIVE_THEN_OMIT')) {
    throw new LogicalDatabaseCodecError(
      'logical-artifact-corrupt',
      'legacy archive manifest can only contain ARCHIVE_THEN_OMIT tables',
    )
  }
  return LegacyArchiveManifestSchema.parse({
    version: 1,
    operationId: input.operationId,
    schemaDigest: input.schemaDigest,
    tables,
    digest: digestSchemaContract(tables),
  })
}

export function verifyLegacyArchiveManifest(value: unknown): LegacyArchiveManifest {
  const parsed = LegacyArchiveManifestSchema.safeParse(value)
  if (
    !parsed.success ||
    parsed.data.tables.some((table) => table.disposition !== 'ARCHIVE_THEN_OMIT') ||
    digestSchemaContract(parsed.data.tables) !== parsed.data.digest
  ) {
    throw new LogicalDatabaseCodecError(
      'logical-artifact-corrupt',
      'legacy archive manifest failed validation or digest verification',
    )
  }
  return parsed.data
}

export function readLegacyArchiveManifest(path: string): LegacyArchiveManifest {
  try {
    return verifyLegacyArchiveManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof LogicalDatabaseCodecError) throw error
    throw new LogicalDatabaseCodecError(
      'logical-artifact-corrupt',
      `legacy archive manifest is unreadable: ${path}`,
    )
  }
}

export function summarizeLogicalTableChunks(input: {
  readonly table: LogicalTableContract
  readonly chunks: readonly LogicalTableChunk[]
}): LogicalTableArtifactEntry {
  const chunks = [...input.chunks].sort(
    (left, right) => left.payload.chunkIndex - right.payload.chunkIndex,
  )
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.payload.table !== input.table.id || chunk.payload.chunkIndex !== index) {
      throw new LogicalDatabaseCodecError(
        'logical-artifact-corrupt',
        `logical database chunk sequence is not contiguous for ${input.table.id}`,
      )
    }
  }
  const rows = chunks.flatMap((chunk) => chunk.payload.rows)
  const blobBytes = rows.reduce(
    (total, row) =>
      total +
      row.values.reduce(
        (rowTotal, value) =>
          rowTotal + (value.type === 'bytes' ? Buffer.byteLength(value.value, 'base64') : 0),
        0,
      ),
    0,
  )
  const chunkDigests = chunks.map((chunk) => chunk.digest)
  return LogicalTableArtifactEntrySchema.parse({
    table: input.table.id,
    disposition: input.table.disposition,
    rowCount: rows.length,
    chunkCount: chunks.length,
    firstKey: rows[0]?.key ?? null,
    lastKey: rows.at(-1)?.key ?? null,
    chunkDigests,
    rootDigest: digestSchemaContract({
      table: input.table.id,
      schemaDigest: chunks[0]?.payload.schemaDigest ?? null,
      rowCount: rows.length,
      chunkDigests,
    }),
    blobBytes,
  })
}

export function logicalArtifactFileDigest(path: string): string {
  return `sha256:${sha256Hex(readFileSync(path))}`
}
