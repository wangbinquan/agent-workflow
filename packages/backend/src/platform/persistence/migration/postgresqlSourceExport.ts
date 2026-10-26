// RFC-395: exports cannot omit unidentified PostgreSQL tables or sequence state.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson, digestSchemaContract } from '../schema/canonical'
import {
  exportLogicalDatabaseArtifact,
  type LogicalDatabaseExportReceipt,
} from './legacy/logicalDatabaseExport'
import { pinnedSnapshotReader } from './freeze/liveSnapshot'
import type { CanonicalLogicalValue } from './legacy/logicalDatabaseArtifact'
import {
  SourceBlockedError,
  type RawSourceChunk,
  type SourcePreflight,
  type VersionedSourceReader,
} from './sourceTypes'

export interface Epoch1ExportEvidence {
  readonly version: 1
  readonly preflight: SourcePreflight
  readonly envelopeFileDigest: string
  readonly rawChunks: Readonly<Record<string, readonly string[]>>
  readonly digest: string
}
export async function exportEpoch1PostgresqlSource(input: {
  readonly source: VersionedSourceReader
  readonly artifactRoot: string
  readonly operationId: string
  readonly chunkRows: number
  readonly preservedArchive?: Parameters<
    typeof exportLogicalDatabaseArtifact
  >[0]['preservedArchive']
  readonly emptyArchive?: Parameters<typeof exportLogicalDatabaseArtifact>[0]['emptyArchive']
}): Promise<LogicalDatabaseExportReceipt & { readonly evidence: Epoch1ExportEvidence }> {
  const preflight = await input.source.preflight()
  if (
    preflight.kind !== 'postgresql-database' ||
    preflight.fingerprint.evidence !== 'physical-catalog-and-journal' ||
    !preflight.contract ||
    preflight.tables.some((table) => table.disposition === 'blocked')
  )
    throw new SourceBlockedError('PostgreSQL export requires an identified physical source')
  await input.source.assertUnchanged(preflight)
  // The physical reader holds one repeatable-read transaction. Rechecking it
  // per chunk restarts that transaction and rescans the whole database (including
  // for empty tables). Keep this snapshot through logical and raw export, then
  // perform the full physical watermark check before publishing its binding.
  const snapshot = pinnedSnapshotReader(input.source, preflight)
  const receipt = await exportLogicalDatabaseArtifact({
    ...input,
    sourceProvider: preflight.fingerprint.provider,
    sourceGenerationId: preflight.sourceGenerationId,
    contract: preflight.contract,
    expectedTableRows: Object.fromEntries(
      preflight.tables
        .filter((table) => preflight.contract!.tables.some((entry) => entry.id === table.table))
        .map((table) => [table.table, table.rows]),
    ),
    source: {
      provider: preflight.fingerprint.provider,
      assertUnchanged: () => snapshot.assertUnchanged(preflight),
      async readChunk(table, afterKey, limit) {
        return (await input.source.readChunk(table.id, afterKey, limit)).rows
      },
    },
  })
  const rawChunks: Record<string, string[]> = {}
  const directory = join(input.artifactRoot, 'source-evidence')
  mkdirSync(directory, { recursive: true })
  for (const table of preflight.tables.filter(
    (table) => table.disposition === 'metadata' || table.disposition === 'archived',
  )) {
    const chunks: string[] = []
    let afterKey: readonly CanonicalLogicalValue[] | null = null
    for (;;) {
      const chunk = await input.source.readRawChunk(table.table, afterKey, input.chunkRows)
      if (!chunk.rows.length) break
      writeFileSync(
        join(directory, `${chunk.sourceDigest.slice(7)}.json`),
        canonicalSchemaJson(chunk),
      )
      chunks.push(chunk.sourceDigest)
      afterKey = chunk.lastKey
    }
    rawChunks[table.table] = chunks
  }
  await input.source.assertUnchanged(preflight)
  const payload = {
    version: 1 as const,
    preflight,
    envelopeFileDigest: receipt.envelopeFileDigest,
    rawChunks,
  }
  const evidence = { ...payload, digest: digestSchemaContract(payload) }
  writeFileSync(join(directory, 'binding.json'), canonicalSchemaJson(evidence))
  return { ...receipt, evidence }
}
export function readEpoch1ExportEvidence(
  artifactRoot: string,
  envelopeFileDigest: string,
): Epoch1ExportEvidence | null {
  const path = join(artifactRoot, 'source-evidence/binding.json')
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8')) as Epoch1ExportEvidence
  const { digest, ...payload } = value
  if (
    digestSchemaContract(payload) !== digest ||
    value.envelopeFileDigest !== envelopeFileDigest ||
    value.preflight.fingerprint.evidence !== 'physical-catalog-and-journal'
  )
    throw new SourceBlockedError('PostgreSQL export fingerprint binding differs')
  for (const [table, digests] of Object.entries(value.rawChunks)) {
    let rows = 0
    for (const digest of digests)
      rows += readEpoch1RawArtifactChunk(artifactRoot, digest).rows.length
    if (rows !== value.preflight.tables.find((entry) => entry.table === table)?.rows)
      throw new SourceBlockedError(`Raw export census differs: ${table}`)
  }
  return value
}
export function readEpoch1RawArtifactChunk(artifactRoot: string, digest: string): RawSourceChunk {
  const value = JSON.parse(
    readFileSync(join(artifactRoot, 'source-evidence', `${digest.slice(7)}.json`), 'utf8'),
  ) as RawSourceChunk
  const { sourceDigest, ...payload } = value
  if (sourceDigest !== digest || digestSchemaContract(payload) !== digest)
    throw new SourceBlockedError('Raw export chunk digest differs')
  return value
}
