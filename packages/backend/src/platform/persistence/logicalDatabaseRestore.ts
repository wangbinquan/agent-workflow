// RFC-349 — bounded verification and replay of a provider-neutral logical
// database artifact. The verifier makes a complete pass before target prepare,
// so corrupt active or archive-only data cannot create a partially restored
// target. Replay makes a second digest-checked pass to close the file TOCTOU
// window and relies on the provider target's per-chunk idempotency receipts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createLogicalTableChunk,
  compareCanonicalLogicalKeys,
  decodeLogicalRow,
  encodeLogicalRow,
  logicalArtifactFileDigest,
  logicalChunkPath,
  verifyLegacyArchiveManifest,
  verifyLogicalArtifactManifest,
  verifyLogicalTableChunk,
  type CanonicalLogicalRow,
  type LegacyArchiveManifest,
  type LogicalDatabaseArtifactManifest,
  type LogicalTableArtifactEntry,
  type LogicalTableChunk,
} from './logicalDatabaseArtifact'
import {
  readLogicalDatabaseBackupEnvelope,
  type LogicalDatabaseExportSource,
  type LogicalDatabaseBackupEnvelope,
} from './logicalDatabaseExport'
import {
  canonicalSchemaJson,
  digestSchemaContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from './schemaContract'

export interface LogicalDatabaseRestoreTarget {
  readonly provider: 'sqlite' | 'postgresql'
  readonly operationId: string
  prepare(now: number): Promise<void>
  copyChunk(table: LogicalTableContract, chunk: LogicalTableChunk, now: number): Promise<void>
  finalizeSchema(now: number): Promise<void>
}

export interface LogicalDatabaseArtifactVerification {
  readonly manifest: LogicalDatabaseArtifactManifest
  readonly legacyArchive: LegacyArchiveManifest
  readonly activeRows: number
  readonly archiveRows: number
  readonly activeChunks: number
  readonly archiveChunks: number
}

export interface VerifiedLogicalDatabaseArtifactSource {
  readonly verification: LogicalDatabaseArtifactVerification
  readChunk(table: LogicalTableContract, chunkIndex: number): LogicalTableChunk
}

export interface LogicalDatabaseRestoreProgress {
  readonly operationId: string
  readonly table: string
  readonly chunk: number
  readonly chunksRestored: number
  readonly chunksTotal: number
  readonly rowsRestored: number
}

export interface LogicalDatabaseRestoreReceipt {
  readonly version: 1
  readonly operationId: string
  readonly sourceOperationId: string
  readonly sourceProvider: 'sqlite' | 'postgresql'
  readonly sourceGenerationId: string
  readonly targetProvider: 'sqlite' | 'postgresql'
  readonly schemaDigest: string
  readonly logicalManifestDigest: string
  readonly legacyArchiveFileDigest: string
  readonly activeTablesRestored: number
  readonly archiveTablesPreserved: number
  readonly rowsRestored: number
  readonly archiveRowsPreserved: number
  readonly chunksRestored: number
  readonly completedAt: number
}

export class LogicalDatabaseRestoreError extends Error {
  constructor(
    public readonly code:
      | 'logical-restore-artifact-corrupt'
      | 'logical-restore-target-operation-mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'LogicalDatabaseRestoreError'
  }
}

function corrupt(detail: string): never {
  throw new LogicalDatabaseRestoreError(
    'logical-restore-artifact-corrupt',
    `logical database restore artifact is corrupt: ${detail}`,
  )
}

function assertExact(actual: unknown, expected: unknown, detail: string): void {
  if (canonicalSchemaJson(actual) !== canonicalSchemaJson(expected)) corrupt(detail)
}

function readCanonicalJson(path: string, detail: string): unknown {
  let raw: string
  let value: unknown
  try {
    raw = readFileSync(path, 'utf8')
    value = JSON.parse(raw)
  } catch {
    return corrupt(`${detail} is missing or unreadable`)
  }
  if (raw !== canonicalSchemaJson(value)) corrupt(`${detail} is not canonical JSON`)
  return value
}

function readManifest(input: {
  readonly artifactRoot: string
  readonly expectedManifestDigest: string
  readonly contract: LogicalSchemaContract
}): LogicalDatabaseArtifactManifest {
  let manifest: LogicalDatabaseArtifactManifest
  try {
    manifest = verifyLogicalArtifactManifest(
      readCanonicalJson(join(input.artifactRoot, 'logical-manifest.json'), 'logical manifest'),
    )
  } catch (error) {
    if (error instanceof LogicalDatabaseRestoreError) throw error
    return corrupt('logical manifest failed schema or digest verification')
  }
  if (manifest.digest !== input.expectedManifestDigest) {
    corrupt('logical manifest digest does not match its trusted envelope')
  }
  if (
    manifest.payload.schemaDigest !== input.contract.digest ||
    manifest.payload.contractVersion !== input.contract.contractVersion ||
    manifest.payload.activeTableCount !== input.contract.activeTableCount ||
    manifest.payload.archiveOnlyTableCount !== input.contract.archiveOnlyTableCount
  ) {
    corrupt('logical manifest schema contract identity does not match the restore target')
  }
  const expectedOrder = [...input.contract.tables].map((table) => table.id).sort()
  const actualOrder = manifest.payload.tables.map((table) => table.table)
  assertExact(actualOrder, expectedOrder, 'logical manifest table roster/order differs')
  return manifest
}

function readLegacyArchive(input: {
  readonly artifactRoot: string
  readonly expectedLegacyArchiveFileDigest: string
  readonly manifest: LogicalDatabaseArtifactManifest
  readonly contract: LogicalSchemaContract
}): LegacyArchiveManifest {
  const path = join(input.artifactRoot, 'legacy-archive', 'manifest.json')
  let manifest: LegacyArchiveManifest
  try {
    manifest = verifyLegacyArchiveManifest(readCanonicalJson(path, 'legacy archive manifest'))
  } catch (error) {
    if (error instanceof LogicalDatabaseRestoreError) throw error
    return corrupt('legacy archive manifest failed schema or digest verification')
  }
  if (logicalArtifactFileDigest(path) !== input.expectedLegacyArchiveFileDigest) {
    corrupt('legacy archive file digest does not match its trusted envelope')
  }
  if (
    manifest.operationId !== input.manifest.payload.operationId ||
    manifest.schemaDigest !== input.contract.digest
  ) {
    corrupt('legacy archive operation or schema identity differs')
  }
  const expected = input.manifest.payload.tables.filter(
    (table) => table.disposition === 'ARCHIVE_THEN_OMIT',
  )
  assertExact(manifest.tables, expected, 'legacy archive projection differs from logical manifest')
  return manifest
}

function normalizedRow(table: LogicalTableContract, row: CanonicalLogicalRow): CanonicalLogicalRow {
  try {
    return encodeLogicalRow(table, decodeLogicalRow(table, row))
  } catch {
    return corrupt(`row shape/value does not match ${table.id}`)
  }
}

function readVerifiedChunk(input: {
  readonly artifactRoot: string
  readonly sourceOperationId: string
  readonly contract: LogicalSchemaContract
  readonly table: LogicalTableContract
  readonly entry: LogicalTableArtifactEntry
  readonly chunkIndex: number
}): LogicalTableChunk {
  const path = logicalChunkPath(input.artifactRoot, input.table, input.chunkIndex)
  let raw: string
  let chunk: LogicalTableChunk
  try {
    raw = readFileSync(path, 'utf8')
    chunk = verifyLogicalTableChunk(JSON.parse(raw))
  } catch {
    return corrupt(`${input.table.id} chunk ${input.chunkIndex} is missing or unreadable`)
  }
  if (raw !== canonicalSchemaJson(chunk)) {
    corrupt(`${input.table.id} chunk ${input.chunkIndex} is not canonical JSON`)
  }
  if (chunk.digest !== input.entry.chunkDigests[input.chunkIndex]) {
    corrupt(`${input.table.id} chunk ${input.chunkIndex} digest differs from the manifest`)
  }
  const payload = chunk.payload
  if (
    payload.operationId !== input.sourceOperationId ||
    payload.schemaDigest !== input.contract.digest ||
    payload.table !== input.table.id ||
    payload.disposition !== input.table.disposition ||
    payload.chunkIndex !== input.chunkIndex
  ) {
    corrupt(`${input.table.id} chunk ${input.chunkIndex} identity differs from the manifest`)
  }
  assertExact(
    payload.columns,
    input.table.columns.map((column) => column.name),
    `${input.table.id} chunk ${input.chunkIndex} column projection differs`,
  )
  assertExact(
    payload.migrationKey,
    input.table.migrationKey,
    `${input.table.id} chunk ${input.chunkIndex} migration key differs`,
  )
  if (payload.rows.length === 0) {
    corrupt(`${input.table.id} chunk ${input.chunkIndex} is empty instead of being omitted`)
  }
  for (const row of payload.rows) {
    assertExact(normalizedRow(input.table, row), row, `${input.table.id} row key/value mismatch`)
  }
  return chunk
}

function verifyEntry(input: {
  readonly artifactRoot: string
  readonly sourceOperationId: string
  readonly contract: LogicalSchemaContract
  readonly table: LogicalTableContract
  readonly entry: LogicalTableArtifactEntry
}): Readonly<{ rows: number; chunks: number }> {
  if (
    input.entry.table !== input.table.id ||
    input.entry.disposition !== input.table.disposition ||
    input.entry.chunkCount !== input.entry.chunkDigests.length
  ) {
    corrupt(`${input.table.id} manifest entry identity/count differs`)
  }
  let rows = 0
  let blobBytes = 0
  let firstKey: CanonicalLogicalRow['key'] | null = null
  let lastKey: CanonicalLogicalRow['key'] | null = null
  let previousKey: CanonicalLogicalRow['key'] | null = null
  const chunkDigests: string[] = []
  for (let chunkIndex = 0; chunkIndex < input.entry.chunkCount; chunkIndex += 1) {
    const chunk = readVerifiedChunk({ ...input, chunkIndex })
    chunkDigests.push(chunk.digest)
    rows += chunk.payload.rows.length
    for (const row of chunk.payload.rows) {
      if (previousKey !== null && compareCanonicalLogicalKeys(previousKey, row.key) >= 0) {
        corrupt(`${input.table.id} migration keys are duplicated or out of stable order`)
      }
      previousKey = row.key
      firstKey ??= row.key
      lastKey = row.key
      for (const value of row.values) {
        if (value.type === 'bytes') blobBytes += Buffer.byteLength(value.value, 'base64')
      }
    }
  }
  const actual: LogicalTableArtifactEntry = {
    table: input.table.id,
    disposition: input.table.disposition,
    rowCount: rows,
    chunkCount: chunkDigests.length,
    firstKey,
    lastKey,
    chunkDigests,
    rootDigest: digestSchemaContract({
      table: input.table.id,
      schemaDigest: chunkDigests.length === 0 ? null : input.contract.digest,
      rowCount: rows,
      chunkDigests,
    }),
    blobBytes,
  }
  assertExact(actual, input.entry, `${input.table.id} manifest summary differs from its chunks`)
  return Object.freeze({ rows, chunks: chunkDigests.length })
}

export function verifyLogicalDatabaseArtifactTree(input: {
  readonly artifactRoot: string
  readonly expectedManifestDigest: string
  readonly expectedLegacyArchiveFileDigest: string
  readonly contract: LogicalSchemaContract
}): LogicalDatabaseArtifactVerification {
  const manifest = readManifest(input)
  const legacyArchive = readLegacyArchive({ ...input, manifest })
  const entries = new Map(manifest.payload.tables.map((entry) => [entry.table, entry]))
  if (entries.size !== manifest.payload.tables.length) corrupt('logical manifest repeats a table')
  let activeRows = 0
  let archiveRows = 0
  let activeChunks = 0
  let archiveChunks = 0
  for (const table of input.contract.tables) {
    const entry = entries.get(table.id)
    if (entry === undefined) corrupt(`logical manifest is missing ${table.id}`)
    const verified = verifyEntry({
      artifactRoot: input.artifactRoot,
      sourceOperationId: manifest.payload.operationId,
      contract: input.contract,
      table,
      entry,
    })
    if (table.disposition === 'ARCHIVE_THEN_OMIT') {
      archiveRows += verified.rows
      archiveChunks += verified.chunks
    } else {
      activeRows += verified.rows
      activeChunks += verified.chunks
    }
  }
  return Object.freeze({
    manifest,
    legacyArchive,
    activeRows,
    archiveRows,
    activeChunks,
    archiveChunks,
  })
}

export function openVerifiedLogicalDatabaseArtifactSource(input: {
  readonly artifactRoot: string
  readonly expectedManifestDigest: string
  readonly expectedLegacyArchiveFileDigest: string
  readonly contract: LogicalSchemaContract
}): VerifiedLogicalDatabaseArtifactSource {
  const verification = verifyLogicalDatabaseArtifactTree(input)
  const entries = new Map(
    verification.manifest.payload.tables.map((entry) => [entry.table, entry] as const),
  )
  return Object.freeze({
    verification,
    readChunk(table: LogicalTableContract, chunkIndex: number) {
      const contractTable = input.contract.tables.find((candidate) => candidate.id === table.id)
      const entry = entries.get(table.id)
      if (
        contractTable === undefined ||
        entry === undefined ||
        !Number.isSafeInteger(chunkIndex) ||
        chunkIndex < 0 ||
        chunkIndex >= entry.chunkCount
      ) {
        return corrupt(`logical artifact chunk request is outside ${table.id}`)
      }
      assertExact(contractTable, table, `logical artifact table contract differs for ${table.id}`)
      return readVerifiedChunk({
        artifactRoot: input.artifactRoot,
        sourceOperationId: verification.manifest.payload.operationId,
        contract: input.contract,
        table: contractTable,
        entry,
        chunkIndex,
      })
    },
  })
}

export async function verifyLogicalDatabaseSourceMatchesArtifact(input: {
  readonly artifactRoot: string
  readonly expectedManifestDigest: string
  readonly expectedLegacyArchiveFileDigest: string
  readonly contract: LogicalSchemaContract
  readonly source: LogicalDatabaseExportSource
  readonly expectedTableRows: Readonly<Record<string, number>>
}): Promise<LogicalDatabaseArtifactVerification> {
  const expectedRoster = input.contract.tables.map((table) => table.id).sort()
  if (
    canonicalSchemaJson(Object.keys(input.expectedTableRows).sort()) !==
    canonicalSchemaJson(expectedRoster)
  ) {
    return corrupt('verification source row census does not match the logical table roster')
  }
  const source = openVerifiedLogicalDatabaseArtifactSource(input)
  for (const table of input.contract.tables) {
    const entry = source.verification.manifest.payload.tables.find(
      (candidate) => candidate.table === table.id,
    )
    if (entry === undefined || input.expectedTableRows[table.id] !== entry.rowCount) {
      return corrupt(`verification source row census differs for ${table.id}`)
    }
    let afterKey: CanonicalLogicalRow['key'] | null = null
    for (let chunkIndex = 0; chunkIndex < entry.chunkCount; chunkIndex += 1) {
      await input.source.assertUnchanged()
      const expectedChunk = source.readChunk(table, chunkIndex)
      const rows = await input.source.readChunk(table, afterKey, expectedChunk.payload.rows.length)
      const actualChunk = createLogicalTableChunk({
        operationId: source.verification.manifest.payload.operationId,
        contract: input.contract,
        table,
        chunkIndex,
        rows,
      })
      assertExact(actualChunk, expectedChunk, `${table.id} raw/logical snapshot differs`)
      afterKey = rows.at(-1)?.key ?? afterKey
    }
    if (entry.chunkCount === 0) {
      await input.source.assertUnchanged()
      if ((await input.source.readChunk(table, null, 1)).length !== 0) {
        return corrupt(`${table.id} raw snapshot contains an unmanifested row`)
      }
    }
  }
  await input.source.assertUnchanged()
  return source.verification
}

export async function restoreLogicalDatabaseArtifact(input: {
  readonly artifactRoot: string
  readonly expectedManifestDigest: string
  readonly expectedLegacyArchiveFileDigest: string
  readonly restoreOperationId: string
  readonly contract: LogicalSchemaContract
  readonly target: LogicalDatabaseRestoreTarget
  readonly envelope?: LogicalDatabaseBackupEnvelope
  readonly now?: () => number
  readonly onProgress?: (progress: LogicalDatabaseRestoreProgress) => void
}): Promise<LogicalDatabaseRestoreReceipt> {
  if (input.target.operationId !== input.restoreOperationId) {
    throw new LogicalDatabaseRestoreError(
      'logical-restore-target-operation-mismatch',
      'logical database restore target belongs to another operation',
    )
  }
  const verified = verifyLogicalDatabaseArtifactTree(input)
  if (input.envelope !== undefined) {
    const expected = input.envelope.payload
    if (
      expected.operationId !== verified.manifest.payload.operationId ||
      expected.sourceProvider !== verified.manifest.payload.sourceProvider ||
      expected.sourceGenerationId !== verified.manifest.payload.sourceGenerationId ||
      expected.schemaDigest !== input.contract.digest ||
      expected.logicalManifestDigest !== verified.manifest.digest ||
      expected.legacyArchiveFileDigest !== input.expectedLegacyArchiveFileDigest ||
      expected.activeTableCount !== input.contract.activeTableCount ||
      expected.archiveOnlyTableCount !== input.contract.archiveOnlyTableCount ||
      expected.activeRows !== verified.activeRows ||
      expected.archiveRows !== verified.archiveRows ||
      expected.chunks !== verified.activeChunks + verified.archiveChunks
    ) {
      corrupt('logical backup envelope differs from its manifest, chunks, or schema contract')
    }
  }
  const now = input.now ?? Date.now
  await input.target.prepare(now())
  let chunksRestored = 0
  let rowsRestored = 0
  for (const table of input.contract.tables) {
    if (table.disposition === 'ARCHIVE_THEN_OMIT') continue
    const entry = verified.manifest.payload.tables.find((candidate) => candidate.table === table.id)
    if (entry === undefined) corrupt(`logical manifest is missing ${table.id}`)
    for (let chunkIndex = 0; chunkIndex < entry.chunkCount; chunkIndex += 1) {
      const sourceChunk = readVerifiedChunk({
        artifactRoot: input.artifactRoot,
        sourceOperationId: verified.manifest.payload.operationId,
        contract: input.contract,
        table,
        entry,
        chunkIndex,
      })
      const targetChunk = createLogicalTableChunk({
        operationId: input.restoreOperationId,
        contract: input.contract,
        table,
        chunkIndex,
        rows: sourceChunk.payload.rows,
      })
      await input.target.copyChunk(table, targetChunk, now())
      chunksRestored += 1
      rowsRestored += targetChunk.payload.rows.length
      input.onProgress?.({
        operationId: input.restoreOperationId,
        table: table.id,
        chunk: chunkIndex + 1,
        chunksRestored,
        chunksTotal: verified.activeChunks,
        rowsRestored,
      })
    }
  }
  await input.target.finalizeSchema(now())
  return Object.freeze({
    version: 1,
    operationId: input.restoreOperationId,
    sourceOperationId: verified.manifest.payload.operationId,
    sourceProvider: verified.manifest.payload.sourceProvider,
    sourceGenerationId: verified.manifest.payload.sourceGenerationId,
    targetProvider: input.target.provider,
    schemaDigest: input.contract.digest,
    logicalManifestDigest: verified.manifest.digest,
    legacyArchiveFileDigest: input.expectedLegacyArchiveFileDigest,
    activeTablesRestored: input.contract.activeTableCount,
    archiveTablesPreserved: input.contract.archiveOnlyTableCount,
    rowsRestored,
    archiveRowsPreserved: verified.archiveRows,
    chunksRestored,
    completedAt: now(),
  })
}

export async function restoreLogicalDatabaseBackup(input: {
  readonly artifactRoot: string
  readonly expectedEnvelopeFileDigest: string
  readonly restoreOperationId: string
  readonly contract: LogicalSchemaContract
  readonly target: LogicalDatabaseRestoreTarget
  readonly now?: () => number
  readonly onProgress?: (progress: LogicalDatabaseRestoreProgress) => void
}): Promise<LogicalDatabaseRestoreReceipt> {
  let envelope: LogicalDatabaseBackupEnvelope
  try {
    envelope = readLogicalDatabaseBackupEnvelope({
      artifactRoot: input.artifactRoot,
      expectedFileDigest: input.expectedEnvelopeFileDigest,
    })
  } catch {
    return corrupt('logical backup envelope failed trusted file verification')
  }
  return await restoreLogicalDatabaseArtifact({
    ...input,
    expectedManifestDigest: envelope.payload.logicalManifestDigest,
    expectedLegacyArchiveFileDigest: envelope.payload.legacyArchiveFileDigest,
    envelope,
  })
}
