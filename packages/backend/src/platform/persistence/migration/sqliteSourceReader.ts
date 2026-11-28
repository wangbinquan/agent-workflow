import { openSqliteForRead } from '@/platform/persistence/sqlite/openForRead'
// RFC-395 II-b V1: immutable VACUUM snapshot, restart-stable source watermark and raw archives.
// RFC-626 §4.1: the content identity of a database is computed once; whether the source has
// changed since is answered by `PRAGMA data_version` of a connection that stays open.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
import type { ConversionResolution } from './conversion/types'
import { createSourceWatch, type SourceWatch } from './freeze/sourceWatch'
import { baselineContent } from './sourceBaseline'
import { collectSourceFingerprint, quoteSourceIdentifier as quote } from './sourceCatalog'
import {
  identifySource,
  withLogicalCodecCorrections,
  type SupportedSourceManifest,
} from './supportedSources'
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
  type SourceMeasurementObserver,
  type SourcePreflight,
  type VersionedSourceReader,
} from './sourceTypes'

/** A freeze or a re-measurement that a concurrent commit interrupted is taken again this often. */
const SOURCE_ATTEMPTS = 3

/** What a reader knows about the copy it reads, once its preflight has run. */
export interface SqliteCopyState {
  /** Content identity of the database the copy was taken from (`sha256:…`). */
  readonly content: string
  /** Size of the copy. A copy this operation owns is recognised by it afterwards. */
  readonly bytes: number
  /** An existing copy was taken over with its recorded identity: nothing was copied or measured. */
  readonly reused: boolean
  /**
   * Rows whose foreign key dangles in the source. Null when the copy was reused: its integrity
   * was checked when it was made and is not read through again.
   */
  readonly foreignKeyViolations: number | null
}
/** The identity a copy was recorded with, and the size it had then. */
export interface SqliteCopyRecord {
  readonly content: string
  readonly bytes: number
}
/**
 * RFC-626 §4.2: the record of a frozen copy cannot be taken over. `copy`: the file is not the
 * one that was recorded. `source`: the database it was taken from has a different content
 * identity now. The reader never overwrites a recorded copy itself — the owner of the record
 * decides whether to freeze again or to report the change.
 */
export class FrozenCopyStaleError extends SourceBlockedError {
  constructor(
    readonly reason: 'copy' | 'source',
    message: string,
  ) {
    super(message)
    this.name = 'FrozenCopyStaleError'
  }
}

export interface Epoch1SqliteSource extends VersionedSourceReader {
  /** Read-only oracle connection may be opened on this operation-owned snapshot. */
  offlinePath(): string
  /** RFC-626: the copy behind the preflight; call it after the preflight. */
  copyState(): SqliteCopyState
}
export function openEpoch1SqliteSource(input: {
  readonly path: string
  readonly manifest: SupportedSourceManifest
  readonly operationRoot: string
  readonly emptyTables?: readonly EmptyTableDecision[]
  readonly sourceGenerationId?: string
  readonly generationPointerPath?: string
  readonly backupRoot?: string
  /**
   * RFC-626 §4.1: what the process remembers about this database between the times it opens
   * it. The reader borrows it and never closes it. Without one the reader keeps its own
   * connection for as long as it is open, and nothing carries over to the next reader.
   */
  readonly watch?: SourceWatch
  /**
   * `path` is a copy this operation made and only this operation writes (the work copy of an
   * offline upgrade, a plan snapshot). The reader reads it in place instead of copying it once
   * more, and leaves it where it is on close.
   */
  readonly privateCopy?: boolean
  /** `automatic`: rows whose foreign key dangles are counted, not refused (RFC-626 §3.3). */
  readonly resolution?: ConversionResolution
  /**
   * RFC-626 §4.2: keep the frozen copy of `path` at this place instead of a temporary
   * directory, and leave it there on close, so that a later handle can take it over.
   */
  readonly frozenCopy?: string
  /**
   * The record of the copy this reader would read — the private copy, or the one at
   * `frozenCopy`. A private copy of the recorded size is taken over with the recorded identity;
   * one of another size is measured. A frozen copy is taken over when it has the recorded size
   * and the source still has the recorded identity; otherwise the preflight fails with
   * `FrozenCopyStaleError` and leaves the copy alone. Not used for a backup directory.
   */
  readonly recorded?: SqliteCopyRecord
  /** RFC-626 §7: told each time the reader computes a whole-database content digest. */
  readonly onMeasure?: SourceMeasurementObserver
}): Epoch1SqliteSource {
  const kind = input.backupRoot ? 'sqlite-backup' : 'sqlite-file'
  const ownsFile = !input.privateCopy
  // A backup directory is covered byte for byte by its file digest, which every check below
  // repeats; a connection held on its database would also leave WAL sidecars inside it.
  const watched = ownsFile && !input.backupRoot
  const ownWatch = watched && !input.watch ? createSourceWatch() : undefined
  const watch = input.watch ?? ownWatch
  const watchKey = `sqlite:${resolve(input.path)}`
  let directory: string | undefined
  let copyPath: string
  if (input.privateCopy) copyPath = input.path
  else if (input.frozenCopy) {
    mkdirSync(dirname(input.frozenCopy), { recursive: true })
    copyPath = input.frozenCopy
  } else {
    mkdirSync(input.operationRoot, { recursive: true })
    directory = mkdtempSync(join(input.operationRoot, 'epoch1-source-'))
    copyPath = join(directory, 'source.sqlite')
  }
  let copy: Database | undefined
  let snapshot: SourcePreflight | undefined
  let pending: Promise<SourcePreflight> | undefined
  let observed = ''
  let state: SqliteCopyState | undefined
  /** `data_version` of the watch connection at which `observed` is known to be the content. */
  let baseline: number | undefined
  let pointerDigest: string | null = null
  let backupDigest: string | null = null
  let closed = false
  const assertOpen = () => {
    if (closed) throw new SourceBlockedError('Source reader is closed')
  }
  // RFC-398 allow-list: copyPath is a VACUUM INTO output of this operation, never a WAL file.
  const openCopy = () => new Database(copyPath, { readonly: true })
  const liveDigest = () => {
    const db = openSqliteForRead(input.path)
    try {
      return sqliteContentDigest(db, input.onMeasure)
    } finally {
      db.close()
    }
  }
  /** Null when the version cannot be read; the callers treat that as "may have changed". */
  const sourceVersion = (): number | null => {
    try {
      return watch!.sqliteDataVersion(input.path)
    } catch {
      return null
    }
  }
  /** What is known about the source goes to the watch, where the next reader finds it. */
  const remember = (content: string, version: number) =>
    watch!.remember(watchKey, { identity: { content }, evidence: String(version) })
  /** The content the watch vouches for at `version`, or null when it knows nothing of it. */
  const rememberedContent = (version: number) =>
    baselineContent(watch!.baseline(watchKey), String(version))
  /**
   * The content identity of the source itself, bracketed by two readings of the version: it is
   * only a baseline when nothing was committed while it was being computed. When no version can
   * be read at all the identity still answers whether the source is the one that was frozen
   * (§4.1: a check that does not pass falls back to the content identity), but nothing vouches
   * for the time after it: `version` is null and nothing is remembered.
   */
  const measureSource = (): { readonly content: string; readonly version: number | null } => {
    for (let attempt = 0; attempt < SOURCE_ATTEMPTS; attempt += 1) {
      const before = sourceVersion()
      const content = liveDigest()
      if (before === null) return { content, version: null }
      if (sourceVersion() === before) return { content, version: before }
    }
    throw new SourceBlockedError('Source changed while its content identity was being confirmed')
  }
  /** What is known after a measurement; a measurement without a version teaches nothing. */
  const settle = (measured: ReturnType<typeof measureSource>) => {
    // Also when it differs: the freeze that follows a change need not measure it again.
    if (measured.version !== null) remember(measured.content, measured.version)
  }
  /** Cheap first; the content identity decides only when the cheap evidence has moved. */
  const sourceUnchanged = (): boolean => {
    if (!watched) return true
    const version = sourceVersion()
    if (version !== null && version === baseline) return true
    // The version moved, could not be read, or comes from a connection that replaced one that
    // stopped reading the file: the content identity decides (RFC-626 §4.1).
    try {
      const measured = measureSource()
      settle(measured)
      if (measured.content !== observed) return false
      baseline = measured.version ?? undefined
      return true
    } catch {
      return false
    }
  }
  const copyUnchanged = (): boolean => {
    try {
      return statSync(copyPath).size === state?.bytes
    } catch {
      return false
    }
  }
  const removeCopy = () => {
    for (const suffix of ['', '-journal', '-wal', '-shm'])
      rmSync(`${copyPath}${suffix}`, { force: true })
  }
  /** `VACUUM INTO` between two equal readings of the version: the copy is the source as of both. */
  const freeze = (): number => {
    for (let attempt = 0; attempt < SOURCE_ATTEMPTS; attempt += 1) {
      const before = watch!.sqliteDataVersion(input.path)
      removeCopy()
      vacuumSqliteInto({ dbPath: input.path, dest: copyPath })
      if (sourceVersion() === before) return before
    }
    throw new SourceBlockedError(
      'Source changed while taking the final SQLite snapshot; freeze again',
    )
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
    copyState() {
      assertOpen()
      if (!snapshot || !state)
        throw new SourceBlockedError('Call source preflight before copyState')
      return state
    },
    async preflight() {
      assertOpen()
      if (snapshot) {
        await reader.assertUnchanged(snapshot)
        return snapshot
      }
      if (pending) return pending
      let created = false
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
        let reused = false
        if (!ownsFile) {
          // A copy this operation made: identified once, then recognised by its size.
          const bytes = statSync(copyPath).size
          copy = openCopy()
          reused = input.recorded?.bytes === bytes
          observed = reused ? input.recorded!.content : sqliteContentDigest(copy, input.onMeasure)
        } else if (input.recorded && watched) {
          if (!existsSync(copyPath) || statSync(copyPath).size !== input.recorded.bytes)
            throw new FrozenCopyStaleError('copy', 'Frozen SQLite copy differs from its record')
          // Within the process the held connection says whether anything was committed since
          // the identity was last confirmed. After a restart nothing is remembered and nothing
          // cheap can vouch for the time in between, so the source is measured once.
          const version = sourceVersion()
          const known = version === null ? null : rememberedContent(version)
          observed = input.recorded.content
          const stale = () =>
            new FrozenCopyStaleError(
              'source',
              'Source changed since it was frozen; a new freeze/plan is required',
            )
          if (known === observed) baseline = version!
          else if (known !== null) throw stale()
          else {
            const measured = measureSource()
            settle(measured)
            if (measured.content !== observed) throw stale()
            baseline = measured.version ?? undefined
          }
          copy = openCopy()
          reused = true
        } else if (watched) {
          created = true
          const version = freeze()
          copy = openCopy()
          // The identity is that of the copy; the source itself is not read a second time.
          // An unchanged version since the last confirmation means it is already known.
          const known = rememberedContent(version)
          observed = known ?? sqliteContentDigest(copy, input.onMeasure)
          if (!known) remember(observed, version)
          baseline = version
        } else {
          created = true
          removeCopy()
          vacuumSqliteInto({ dbPath: input.path, dest: copyPath })
          copy = openCopy()
          observed = sqliteContentDigest(copy, input.onMeasure)
        }
        const frozen = copy
        const integrity = reused
          ? null
          : assertSqliteIntegrity(frozen, {
              tolerateForeignKeys: input.resolution === 'automatic',
            })
        state = {
          content: observed,
          bytes: statSync(copyPath).size,
          reused,
          foreignKeyViolations: integrity?.foreignKeyViolations ?? null,
        }
        const fingerprint = collectSourceFingerprint(frozen)
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
                  if (!sourceUnchanged())
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
          identityHighWater: sqliteIdentityHighWater(frozen),
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
          state = undefined
          // Only a copy this preflight wrote is its to remove; a recorded copy and a private
          // copy belong to whoever handed them in.
          if (created) removeCopy()
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
        !sourceUnchanged() ||
        !copyUnchanged() ||
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
      const frozen = snapshot.contract.tables.find((entry) => entry.id === tableId)
      if (!frozen)
        throw new SourceBlockedError(
          `No frozen row codec for ${tableId}; use readRawChunk for its disposition`,
        )
      // An older contract decodes with the frozen history's later codec corrections.
      const table = withLogicalCodecCorrections(frozen, input.manifest.codecCorrections)
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
      // Only the reader's own connection: a borrowed watch outlives every handle, and a
      // version read from a reopened connection could not be compared with an earlier one.
      ownWatch?.close()
      // The temporary copy goes with the handle; a frozen copy and a private copy stay.
      if (directory) rmSync(directory, { recursive: true, force: true })
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
