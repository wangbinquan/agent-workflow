// RFC-395 II-b V1: legacy logical/hosted backups keep their original version and row bytes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareCanonicalLogicalKeys,
  logicalArtifactFileDigest,
  verifyLogicalArtifactManifest,
  type CanonicalLogicalRow,
} from './legacy/logicalDatabaseArtifact'
import { readLogicalDatabaseBackupEnvelope } from './legacy/logicalDatabaseExport'
import {
  openVerifiedLogicalDatabaseArtifactSource,
  type VerifiedLogicalDatabaseArtifactSource,
} from './legacy/logicalDatabaseRestore'
import { readManifest } from './legacy/backupManifest'
import { canonicalSchemaJson } from '../schema/canonical'
import { loadFrozenEpoch1History } from './epoch1/bundle'
import {
  readEpoch1ExportEvidence,
  readEpoch1RawArtifactChunk,
  type Epoch1ExportEvidence,
} from './postgresqlSourceExport'
import { rawSourceChunk } from './rawSourceReader'
import { identifySource, type SupportedSourceManifest } from './supportedSources'
import { makeSourceFingerprint } from './sourceCatalog'
import { sourceTableDispositions, tableCatalogDigest } from './sourceDispositions'
import {
  assertSourceChunkRequest,
  sourceChunk,
  sourceContentPresence,
  sourceFilesDigest,
} from './sourceReader'
import {
  SourceBlockedError,
  sourceFailure,
  type SourcePreflight,
  type RawSourceRow,
  type VersionedSourceReader,
} from './sourceTypes'

export type Epoch1LogicalArtifactInput = {
  readonly artifactRoot: string
  readonly supportedSources?: SupportedSourceManifest
  readonly hosted?: boolean
} & (
  | {
      readonly envelopeFileDigest: string
      readonly backupRoot?: string
      readonly manifestDigest?: never
      readonly legacyArchiveFileDigest?: never
    }
  | {
      readonly envelopeFileDigest?: never
      readonly manifestDigest: string
      readonly backupRoot?: never
      readonly legacyArchiveFileDigest: string
    }
)
export function openEpoch1LogicalArtifactSource(
  input: Epoch1LogicalArtifactInput,
): VersionedSourceReader {
  const kind = input.hosted
    ? 'hosted-backup'
    : input.backupRoot
      ? 'logical-backup'
      : 'logical-artifact'
  let snapshot: SourcePreflight | undefined
  let verified: VerifiedLogicalDatabaseArtifactSource | undefined
  let evidence: Epoch1ExportEvidence | null = null
  let pending: Promise<SourcePreflight> | undefined
  let closed = false
  const root = input.backupRoot ?? input.artifactRoot
  const assertOpen = () => {
    if (closed) throw new SourceBlockedError('Source reader is closed')
  }
  const reader: VersionedSourceReader = {
    kind,
    async preflight() {
      assertOpen()
      if (snapshot) {
        await reader.assertUnchanged(snapshot)
        return snapshot
      }
      if (pending) return pending
      pending = (async () => {
        const watermark = await sourceFilesDigest(root)
        const envelope =
          input.envelopeFileDigest !== undefined
            ? readLogicalDatabaseBackupEnvelope({
                artifactRoot: input.artifactRoot,
                expectedFileDigest: input.envelopeFileDigest,
              })
            : (() => {
                const manifest = verifyLogicalArtifactManifest(
                  JSON.parse(
                    readFileSync(join(input.artifactRoot, 'logical-manifest.json'), 'utf8'),
                  ),
                )
                if (manifest.digest !== input.manifestDigest)
                  throw new SourceBlockedError('Logical-copy manifest digest differs')
                return {
                  payload: {
                    ...manifest.payload,
                    logicalManifestDigest: manifest.digest,
                    legacyArchiveFileDigest: input.legacyArchiveFileDigest,
                  },
                }
              })()
        const history = await loadFrozenEpoch1History()
        const version = history.postgresql.versions.find(
          (entry) => entry.contract.digest === envelope.payload.schemaDigest,
        )
        if (!version)
          throw new SourceBlockedError(
            `Unsupported logical source contract: ${envelope.payload.schemaDigest}`,
          )
        if (input.backupRoot) {
          const backup = readManifest(input.backupRoot)
          if (
            backup?.manifestVersion !== 2 ||
            backup.database.envelopeFileDigest !== input.envelopeFileDigest ||
            backup.database.schemaDigest !== envelope.payload.schemaDigest ||
            backup.database.sourceGenerationId !== envelope.payload.sourceGenerationId ||
            backup.database.provider !== envelope.payload.sourceProvider
          )
            throw new SourceBlockedError('Backup manifest v2 and logical envelope differ')
          if (input.hosted) {
            // Installation/object access is still owned by the existing hosted adapter (V3).
            const sidecar = JSON.parse(
              readFileSync(join(input.backupRoot, 'hosted-backup.json'), 'utf8'),
            ) as { format?: string; schemaDigest?: string; sourceGenerationId?: string }
            if (
              sidecar.format !== 'aw-hosted-database-backup-v2' ||
              sidecar.schemaDigest !== envelope.payload.schemaDigest ||
              sidecar.sourceGenerationId !== envelope.payload.sourceGenerationId
            )
              throw new SourceBlockedError('Hosted backup sidecar and logical envelope differ')
          }
        }
        verified = openVerifiedLogicalDatabaseArtifactSource({
          artifactRoot: input.artifactRoot,
          contract: version.contract,
          expectedManifestDigest: envelope.payload.logicalManifestDigest,
          expectedLegacyArchiveFileDigest: envelope.payload.legacyArchiveFileDigest,
        })
        const tableRows = Object.fromEntries(
          verified.verification.manifest.payload.tables.map((table) => [
            table.table,
            table.rowCount,
          ]),
        )
        // Epoch-1 artifacts did not export a physical catalog/journal. Do not invent one.
        const catalog = version.contract.tables.map((table) => ({
          kind: 'logical-artifact-table',
          relation: table.id,
          name: table.id,
          definition: canonicalSchemaJson(table),
        }))
        const fingerprint = makeSourceFingerprint(
          envelope.payload.sourceProvider,
          catalog,
          [],
          tableRows,
          'legacy-logical-artifact',
        )
        evidence = input.envelopeFileDigest
          ? readEpoch1ExportEvidence(input.artifactRoot, input.envelopeFileDigest)
          : null
        if (evidence) {
          if (!input.supportedSources)
            throw new SourceBlockedError(
              'Bound PostgreSQL export requires the supported-source manifest',
            )
          identifySource({
            fingerprint: evidence.preflight.fingerprint,
            manifest: input.supportedSources,
            postgresqlMajor: evidence.preflight.fingerprint.postgresqlMajor,
            emptyTables: evidence.preflight.tables
              .filter((table) => table.rows === 0 && table.disposition === 'archived')
              .map((table) => ({
                table: table.physicalTable,
                catalogDigest: tableCatalogDigest(
                  evidence!.preflight.fingerprint,
                  table.physicalTable,
                ),
                disposition: 'archived',
                reason: table.reason,
              })),
          })
          if (
            evidence.preflight.sourceGenerationId !== envelope.payload.sourceGenerationId ||
            evidence.preflight.contract?.digest !== version.contract.digest
          )
            throw new SourceBlockedError('Export binding and logical envelope differ')
        }
        if ((await sourceFilesDigest(root)) !== watermark)
          throw new SourceBlockedError('Logical source changed during preflight')
        const logicalTables = sourceTableDispositions({
          source: fingerprint,
          contract: version.contract,
        })
        // Physical export evidence accounts for active tables and metadata. The
        // RFC-349 archive-only rows live in this verified artifact, not in the
        // PostgreSQL catalog; replacing its census with the physical one loses them.
        const tables = evidence
          ? [
              ...evidence.preflight.tables,
              ...logicalTables.filter(
                (table) =>
                  version.contract.tables.some(
                    (entry) =>
                      entry.id === table.table && entry.disposition === 'ARCHIVE_THEN_OMIT',
                  ) && !evidence!.preflight.tables.some((entry) => entry.table === table.table),
              ),
            ]
          : logicalTables
        snapshot = {
          version: 1,
          kind,
          sourceVersion: `logical:${version.contract.digest}`,
          contract: version.contract,
          fingerprint: evidence?.preflight.fingerprint ?? fingerprint,
          sourceGenerationId: envelope.payload.sourceGenerationId,
          identityHighWater: evidence?.preflight.identityHighWater ?? [],
          identityEvidence: evidence ? 'physical' : 'not-recorded-by-epoch1-artifact',
          watermark,
          requiresOfflineUpgrade:
            version.contract.digest !== history.postgresql.head.contract.digest,
          tables,
          expectedAbsent: history.postgresql.head.contract.tables
            .filter((table) => !tables.some((entry) => entry.table === table.id))
            .map((table) => table.id),
          content: sourceContentPresence({ root, kind }),
        }
        return snapshot
      })()
        .catch((error: unknown) => {
          snapshot = undefined
          verified = undefined
          throw sourceFailure(error)
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    },
    async assertUnchanged(expected) {
      assertOpen()
      if (
        !snapshot ||
        snapshot.watermark !== expected.watermark ||
        snapshot.sourceGenerationId !== expected.sourceGenerationId ||
        snapshot.fingerprint.digest !== expected.fingerprint.digest ||
        (await sourceFilesDigest(root)) !== snapshot.watermark
      )
        throw new SourceBlockedError(
          'Logical source changed after preflight; a new freeze/plan is required',
        )
    },
    async readChunk(tableId, afterKey, limit) {
      assertOpen()
      if (!snapshot || !verified)
        throw new SourceBlockedError('Call source preflight before readChunk')
      const table = snapshot.contract!.tables.find((entry) => entry.id === tableId)
      if (!table) throw new SourceBlockedError(`Unknown logical source table ${tableId}`)
      assertSourceChunkRequest(table, afterKey, limit)
      const entry = verified.verification.manifest.payload.tables.find(
        (item) => item.table === tableId,
      )!
      const rows: CanonicalLogicalRow[] = []
      let start = 0
      let end = entry.chunkCount
      if (afterKey !== null) {
        while (start < end) {
          const middle = Math.floor((start + end) / 2)
          const last = verified.readChunk(table, middle).payload.rows.at(-1)
          if (last && compareCanonicalLogicalKeys(last.key, afterKey) <= 0) start = middle + 1
          else end = middle
        }
      }
      for (let index = start; index < entry.chunkCount && rows.length < limit; index += 1) {
        for (const row of verified.readChunk(table, index).payload.rows) {
          if (afterKey !== null && compareCanonicalLogicalKeys(row.key, afterKey) <= 0) continue
          rows.push(row)
          if (rows.length === limit) break
        }
      }
      return sourceChunk({ sourceVersion: snapshot.sourceVersion, table, afterKey, rows })
    },
    async readRawChunk(tableId, afterKey, limit) {
      assertOpen()
      if (!snapshot || !verified)
        throw new SourceBlockedError('Call source preflight before readRawChunk')
      const digests = evidence?.rawChunks[tableId]
      if (digests) {
        const migrationKey = digests[0]
          ? readEpoch1RawArtifactChunk(input.artifactRoot, digests[0]).migrationKey
          : ['$ordinal']
        assertSourceChunkRequest({ id: tableId, migrationKey }, afterKey, limit)
        const rows: RawSourceRow[] = []
        for (const digest of digests) {
          const chunk = readEpoch1RawArtifactChunk(input.artifactRoot, digest)
          for (const row of chunk.rows) {
            if (afterKey !== null && compareCanonicalLogicalKeys(row.key, afterKey) <= 0) continue
            rows.push(row)
            if (rows.length === limit) break
          }
          if (rows.length === limit) break
        }
        return rawSourceChunk({
          sourceVersion: snapshot.sourceVersion,
          table: tableId,
          migrationKey,
          afterKey,
          rows,
        })
      }
      const chunk = await reader.readChunk(tableId, afterKey, limit)
      return rawSourceChunk({
        sourceVersion: chunk.sourceVersion,
        table: tableId,
        migrationKey: chunk.migrationKey,
        afterKey,
        rows: chunk.rows.map((row) => ({
          key: row.key,
          cells: Object.fromEntries(
            row.values.map((value, index) => [
              snapshot!.contract!.tables.find((table) => table.id === tableId)!.columns[index]!
                .name,
              { storageClass: `logical:${value.type}`, value },
            ]),
          ),
        })),
      })
    },
    async close() {
      closed = true
    },
  }
  return reader
}
export function openEpoch1HostedBackupSource(input: {
  readonly backupRoot: string
  readonly supportedSources?: SupportedSourceManifest
}): VersionedSourceReader {
  const artifactRoot = join(input.backupRoot, 'database/logical')
  return openEpoch1LogicalArtifactSource({
    ...input,
    artifactRoot,
    hosted: true,
    envelopeFileDigest: logicalArtifactFileDigest(join(artifactRoot, 'logical-backup.json')),
  })
}
