// RFC-395 II-b V1: immutable VACUUM snapshot, restart-stable source watermark and raw archives.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { vacuumSqliteInto } from './legacy/sqliteSnapshot'
import { readManifest } from './legacy/backupManifest'
import { readLogicalDatabaseBackupEnvelope } from './legacy/logicalDatabaseExport'
import { verifyLogicalDatabaseSourceMatchesArtifact } from './legacy/logicalDatabaseRestore'
import {
  decodeLogicalValue,
  encodeLogicalRow,
  type CanonicalLogicalValue,
} from './legacy/logicalDatabaseArtifact'
import type { LogicalTableContract } from '../schema/contractTypes'
import { digestSchemaContract } from '../schema/canonical'
import { collectSourceFingerprint, quoteSourceIdentifier as quote } from './sourceCatalog'
import { identifySource, type SupportedSourceManifest } from './supportedSources'
import { type EmptyTableDecision } from './sourceDispositions'
import {
  assertSourceChunkRequest,
  sourceChunk,
  sourceContentPresence,
  sourceFilesDigest,
} from './sourceReader'
import {
  assertSqliteIntegrity,
  readSqliteRawChunk,
  sqliteContentDigest,
  sqliteIdentityHighWater,
} from './rawSourceReader'
import {
  SourceBlockedError,
  sourceFailure,
  type SourcePreflight,
  type VersionedSourceReader,
} from './sourceTypes'

export interface Epoch1SqliteSource extends VersionedSourceReader {
  /** Read-only oracle connection may be opened on this operation-owned snapshot. */
  offlinePath(): string
}
export function openEpoch1SqliteSource(input: {
  readonly path: string
  readonly manifest: SupportedSourceManifest
  readonly operationRoot: string
  readonly emptyTables?: readonly EmptyTableDecision[]
  readonly sourceGenerationId?: string
  readonly generationPointerPath?: string
  readonly backupRoot?: string
}): Epoch1SqliteSource {
  const kind = input.backupRoot ? 'sqlite-backup' : 'sqlite-file'
  mkdirSync(input.operationRoot, { recursive: true })
  const directory = mkdtempSync(join(input.operationRoot, 'epoch1-source-'))
  const copyPath = join(directory, 'source.sqlite')
  let copy: Database | undefined
  let snapshot: SourcePreflight | undefined
  let pending: Promise<SourcePreflight> | undefined
  let observed = ''
  let pointerDigest: string | null = null
  let backupDigest: string | null = null
  let closed = false
  const assertOpen = () => {
    if (closed) throw new SourceBlockedError('Source reader is closed')
  }
  const liveDigest = () => {
    const db = new Database(input.path, { readonly: true })
    try {
      return sqliteContentDigest(db)
    } finally {
      db.close()
    }
  }
  const pointer = () => {
    if (!input.generationPointerPath) return null
    const bytes = readFileSync(input.generationPointerPath, 'utf8')
    const value = JSON.parse(bytes) as {
      payload: { version: number; generationId: string; provider: string }
      digest: string
    }
    if (
      value.payload.version !== 1 ||
      value.payload.provider !== 'sqlite' ||
      !/^dbg_[A-Za-z0-9_-]{8,128}$/.test(value.payload.generationId) ||
      digestSchemaContract(value.payload) !== value.digest
    )
      throw new SourceBlockedError('Expected a valid epoch-1 SQLite generation pointer')
    return value
  }
  const reader: Epoch1SqliteSource = {
    kind,
    offlinePath() {
      assertOpen()
      if (!snapshot) throw new SourceBlockedError('Call source preflight before offlinePath')
      return copyPath
    },
    async preflight() {
      assertOpen()
      if (snapshot) {
        await reader.assertUnchanged(snapshot)
        return snapshot
      }
      if (pending) return pending
      pending = (async () => {
        const backup = input.backupRoot ? readManifest(input.backupRoot) : null
        if (
          input.backupRoot &&
          ((!backup && existsSync(join(input.backupRoot, 'manifest.json'))) ||
            (backup?.manifestVersion === 2 &&
              (backup.database.rawSqlitePath !== 'db.sqlite' ||
                backup.database.provider !== 'sqlite')))
        )
          throw new SourceBlockedError('Expected a valid epoch-1 SQLite backup manifest')
        backupDigest = input.backupRoot ? await sourceFilesDigest(input.backupRoot) : null
        const generation = pointer()
        pointerDigest = generation?.digest ?? null
        observed = liveDigest()
        vacuumSqliteInto({ dbPath: input.path, dest: copyPath })
        copy = new Database(copyPath, { readonly: true })
        if (sqliteContentDigest(copy) !== observed || liveDigest() !== observed)
          throw new SourceBlockedError(
            'Source changed while taking the final SQLite snapshot; freeze again',
          )
        assertSqliteIntegrity(copy)
        const fingerprint = collectSourceFingerprint(copy)
        const identified = identifySource({
          fingerprint,
          manifest: input.manifest,
          emptyTables: input.emptyTables,
        })
        const contract = identified.source.contract
        const sourceGenerationId =
          backup?.manifestVersion === 2
            ? backup.database.sourceGenerationId
            : (generation?.payload.generationId ??
              input.sourceGenerationId ??
              `dbg_epoch1_${observed.slice(7, 31)}`)
        if (input.sourceGenerationId && input.sourceGenerationId !== sourceGenerationId)
          throw new SourceBlockedError('SQLite source generation differs from the plan')
        let logicalBackupVerification: SourcePreflight['logicalBackupVerification'] =
          input.backupRoot ? 'raw-sqlite-only' : undefined
        if (backup) {
          const last = fingerprint.journal.at(-1)
          if (
            !last ||
            String(backup.migration.lastCreatedAt) !== last.identity ||
            backup.migration.lastHash !== last.digest
          )
            throw new SourceBlockedError('SQLite backup manifest and raw migration identity differ')
        }
        if (backup?.manifestVersion === 2) {
          if (!contract) {
            // v0.18.18/19 predate the PostgreSQL baseline rewrite. Raw db.sqlite
            // has the complete physical proof; its old logical companion is not verified.
            logicalBackupVerification = 'raw-sqlite-only'
          } else {
            if (backup.database.schemaDigest !== contract.digest)
              throw new SourceBlockedError('SQLite snapshot and backup contract differ')
            const artifactRoot = join(input.backupRoot!, backup.database.logicalPath)
            const envelope = readLogicalDatabaseBackupEnvelope({
              artifactRoot,
              expectedFileDigest: backup.database.envelopeFileDigest,
            })
            if (
              envelope.payload.sourceGenerationId !== sourceGenerationId ||
              envelope.payload.sourceProvider !== 'sqlite'
            )
              throw new SourceBlockedError('SQLite backup envelope and generation differ')
            await verifyLogicalDatabaseSourceMatchesArtifact({
              artifactRoot,
              expectedManifestDigest: envelope.payload.logicalManifestDigest,
              expectedLegacyArchiveFileDigest: envelope.payload.legacyArchiveFileDigest,
              contract,
              expectedTableRows: Object.fromEntries(
                contract.tables.map((table) => [table.id, fingerprint.tableRows[table.id]!]),
              ),
              source: {
                provider: 'sqlite',
                async assertUnchanged() {
                  if (liveDigest() !== observed)
                    throw new SourceBlockedError('Source changed during backup verification')
                },
                async readChunk(table, afterKey, limit) {
                  return readRows(table, afterKey, limit)
                },
              },
            })
            logicalBackupVerification = 'verified'
          }
        }
        const result: SourcePreflight = {
          version: 1,
          kind,
          sourceVersion: identified.source.id,
          contract,
          fingerprint,
          sourceGenerationId,
          identityHighWater: sqliteIdentityHighWater(copy),
          identityEvidence: 'physical',
          ...(logicalBackupVerification ? { logicalBackupVerification } : {}),
          watermark: digestSchemaContract({
            content: observed,
            sourceGenerationId,
            pointerDigest,
            backupDigest,
          }),
          requiresOfflineUpgrade: !contract || contract.digest !== input.manifest.headDigest,
          tables: identified.tables,
          expectedAbsent: identified.source.expectedAbsent,
          content: sourceContentPresence({ root: input.backupRoot ?? dirname(input.path), kind }),
        }
        if (input.backupRoot && (await sourceFilesDigest(input.backupRoot)) !== backupDigest)
          throw new SourceBlockedError('Backup changed during preflight')
        snapshot = result
        return result
      })()
        .catch((error: unknown) => {
          copy?.close()
          copy = undefined
          rmSync(copyPath, { force: true })
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
        !copy ||
        expected.watermark !== snapshot.watermark ||
        expected.sourceGenerationId !== snapshot.sourceGenerationId ||
        expected.fingerprint.digest !== snapshot.fingerprint.digest ||
        liveDigest() !== observed ||
        sqliteContentDigest(copy) !== observed ||
        (pointer()?.digest ?? null) !== pointerDigest ||
        (input.backupRoot && (await sourceFilesDigest(input.backupRoot)) !== backupDigest)
      )
        throw new SourceBlockedError(
          'Source changed after preflight; a new freeze/plan is required',
        )
    },
    async readChunk(tableId, afterKey, limit) {
      assertOpen()
      if (!snapshot || !copy) throw new SourceBlockedError('Call source preflight before readChunk')
      if (!snapshot.contract)
        throw new SourceBlockedError(
          'Upgrade-only SQLite source requires an offline upgrade before codec reads',
        )
      const table = snapshot.contract.tables.find((entry) => entry.id === tableId)
      if (!table)
        throw new SourceBlockedError(
          `No frozen row codec for ${tableId}; use readRawChunk for its disposition`,
        )
      try {
        return sourceChunk({
          sourceVersion: snapshot.sourceVersion,
          table,
          afterKey,
          rows: readRows(table, afterKey, limit),
        })
      } catch (error) {
        throw sourceFailure(error)
      }
    },
    async readRawChunk(tableId, afterKey, limit) {
      assertOpen()
      if (!snapshot || !copy)
        throw new SourceBlockedError('Call source preflight before readRawChunk')
      if (
        !snapshot.tables.some((table) => table.table === tableId && table.disposition !== 'blocked')
      )
        throw new SourceBlockedError(`No admitted raw source table ${tableId}`)
      try {
        return readSqliteRawChunk({
          database: copy,
          sourceVersion: snapshot.sourceVersion,
          table: tableId,
          afterKey,
          limit,
        })
      } catch (error) {
        throw sourceFailure(error)
      }
    },
    async close() {
      if (closed) return
      try {
        await pending
      } catch {
        /* failed preflight already cleaned its connection */
      }
      closed = true
      copy?.close()
      copy = undefined
      rmSync(directory, { recursive: true, force: true })
    },
  }
  const readRows = (
    table: LogicalTableContract,
    afterKey: readonly CanonicalLogicalValue[] | null,
    limit: number,
  ) => {
    assertSourceChunkRequest(table, afterKey, limit)
    const order = table.migrationKey.map(quote).join(', ')
    const where =
      afterKey === null ? '' : ` WHERE (${order}) > (${afterKey.map(() => '?').join(', ')})`
    const query = copy!.query(
      `SELECT ${table.columns.map((column) => quote(column.name)).join(', ')} FROM ${quote(table.sourceTable)}${where} ORDER BY ${order} LIMIT ${limit}`,
    )
    ;(query as typeof query & { safeIntegers(enabled: boolean): void }).safeIntegers(true)
    return (
      query.all(
        ...(afterKey?.map((value) => {
          const decoded = decodeLogicalValue(value)
          return (typeof decoded === 'boolean' ? Number(decoded) : decoded) as SQLQueryBindings
        }) ?? []),
      ) as Record<string, unknown>[]
    ).map((row) => encodeLogicalRow(table, row))
  }
  return reader
}
export function openEpoch1SqliteBackupSource(
  input: Omit<Parameters<typeof openEpoch1SqliteSource>[0], 'path' | 'backupRoot'> & {
    readonly backupRoot: string
  },
): Epoch1SqliteSource {
  return openEpoch1SqliteSource({ ...input, path: join(input.backupRoot, 'db.sqlite') })
}
