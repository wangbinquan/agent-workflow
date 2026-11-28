import type { MigrationProgressCallback } from './run/progress'
// RFC-395 II-b V1: historical migrations run only in newly created offline copies.
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { vacuumSqliteInto } from './legacy/sqliteSnapshot'
import { applyFrozenSqliteMigrations } from './epoch1/sqliteChain'
import { assertSqliteIntegrity } from './rawSourceReader'
import { openEpoch1SqliteSource, type Epoch1SqliteSource } from './sqliteSourceReader'
import { openEpoch1PostgresqlSource } from './postgresqlSourceReader'
import type { SourceWatch } from './freeze/sourceWatch'
import {
  createLogicalTableChunk,
  type CanonicalLogicalValue,
  type LogicalValueRule,
} from './legacy/logicalDatabaseArtifact'
import {
  openPostgresqlLogicalTarget,
  postgresqlCopyBatchRows,
  type PostgresqlLogicalTarget,
} from './legacy/postgresqlLogicalTarget'
import { migratePostgresqlSchema } from './legacy/postgresqlMigrator'
import type { PostgresqlDatabaseRuntime } from '../postgresqlRuntime'
import { canonicalSchemaJson } from '../schema/canonical'
import type { LogicalSchemaContract, LogicalTableContract } from '../schema/contractTypes'
import type { LogicalTargetTableVerification } from './legacy/logicalDatabaseRestore'
import { loadFrozenEpoch1History } from './epoch1/bundle'
import { collectSourceFingerprint } from './sourceCatalog'
import {
  identifySource,
  withLogicalCodecCorrections,
  type SupportedSourceManifest,
} from './supportedSources'
import type { EmptyTableDecision } from './sourceDispositions'
import type { ConversionResolution } from './conversion/types'
import { readChunkForTransport } from './sourceTransport'
import {
  SourceBlockedError,
  sourceFailure,
  type SourcePreflight,
  type SourceFingerprint,
  type SourceMeasurementObserver,
  type VersionedSourceReader,
} from './sourceTypes'

// RFC-626 §4.1: the rows a retired or metadata table holds are captured by the caller (the
// source access) before it upgrades a copy; the capture this module used to make as well went
// unread. The SQLite copy's reader is preflighted by whoever reads it — the preflight this
// module ran on it was discarded, and its main caller only takes the file.

// SQLite requires VACUUM/files/PRAGMAs; PostgreSQL requires a provisioned server
// and a logical load. The two upgrade mechanisms are intentionally dialect-specific.
async function upgradeFileCopy(input: {
  readonly source: Epoch1SqliteSource
  readonly expected: SourcePreflight
  readonly manifest: SupportedSourceManifest
  readonly operationRoot: string
  readonly progress?: MigrationProgressCallback
  readonly emptyTables?: readonly EmptyTableDecision[]
  /**
   * RFC-626 §3.3: `automatic` counts rows whose foreign key dangles after the remaining
   * migrations instead of refusing them; the conversion and the target's finalization deal with
   * such rows. A damaged file (`quick_check`) is refused either way.
   */
  readonly resolution?: ConversionResolution
  /** RFC-626 §7: handed to the reader of the upgraded copy. */
  readonly onMeasure?: SourceMeasurementObserver
}): Promise<{
  readonly path: string
  readonly before: SourceFingerprint
  readonly after: SourceFingerprint
  readonly sourceWatermark: string
  readonly sourcePreflight: SourcePreflight
  readonly reader: Epoch1SqliteSource
  close(): Promise<void>
}> {
  await input.source.assertUnchanged(input.expected)
  mkdirSync(input.operationRoot, { recursive: true })
  const directory = mkdtempSync(join(input.operationRoot, 'epoch1-upgrade-'))
  const path = join(directory, 'upgraded.sqlite')
  let copy: Database | undefined
  let reader: Epoch1SqliteSource | undefined
  try {
    vacuumSqliteInto({ dbPath: input.source.offlinePath(), dest: path })
    copy = new Database(path)
    const before = collectSourceFingerprint(copy)
    if (before.digest !== input.expected.fingerprint.digest)
      throw new SourceBlockedError('Offline copy differs from the planned source fingerprint')
    const identified = identifySource({
      fingerprint: before,
      manifest: input.manifest,
      emptyTables: input.emptyTables,
    })
    const history = await loadFrozenEpoch1History()
    applyFrozenSqliteMigrations(copy, history.sqlite.slice(identified.source.sqliteThrough))
    assertSqliteIntegrity(copy, { tolerateForeignKeys: input.resolution === 'automatic' })
    const after = collectSourceFingerprint(copy)
    const result = identifySource({
      fingerprint: after,
      manifest: input.manifest,
      emptyTables: input.emptyTables,
    })
    if (result.source.contract?.digest !== input.manifest.headDigest)
      throw new SourceBlockedError('Offline SQLite migration did not reach the frozen head')
    copy.close()
    copy = undefined
    await input.source.assertUnchanged(input.expected)
    // The upgraded file is this operation's own: read in place, not copied once more, and
    // preflighted by whoever reads it.
    reader = openEpoch1SqliteSource({
      path,
      manifest: input.manifest,
      operationRoot: directory,
      emptyTables: input.emptyTables,
      sourceGenerationId: input.expected.sourceGenerationId,
      privateCopy: true,
      resolution: input.resolution,
      onMeasure: input.onMeasure,
    })
    const resultReader = reader
    return {
      path,
      before,
      after,
      sourceWatermark: input.expected.watermark,
      sourcePreflight: input.expected,
      reader,
      async close() {
        await resultReader.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    copy?.close()
    await reader?.close()
    rmSync(directory, { recursive: true, force: true })
    throw sourceFailure(error)
  }
}

/** V3 owns database provisioning. This callback must create a new, empty offline
 * database; the operation receives no live PostgreSQL source connection. */
export interface OfflinePostgresqlDatabase {
  readonly runtime: PostgresqlDatabaseRuntime
  close(): Promise<void>
}

/**
 * Copies one table of the source into the scratch target, chunk by chunk. RFC-626 §4.6: a
 * chunk holds `postgresqlCopyBatchRows(columns)` rows — at most 1000, fewer for a table so wide
 * that 1000 rows would exceed the protocol's parameter ceiling in one INSERT (`tasks`, 70
 * columns: 857). Every chunk is still written, read back row by row and receipted as one unit.
 */
export async function copyTableToScratch(input: {
  readonly source: VersionedSourceReader
  readonly target: Pick<PostgresqlLogicalTarget, 'copyChunk'>
  readonly operationId: string
  readonly contract: LogicalSchemaContract
  readonly table: LogicalTableContract
  readonly valueRule: LogicalValueRule
  readonly progress?: MigrationProgressCallback
}): Promise<LogicalTargetTableVerification> {
  const { table } = input
  let afterKey: readonly CanonicalLogicalValue[] | null = null
  let rowCount = 0
  let chunkCount = 0
  // Archive-only data remains on the immutable source, never silently discarded.
  if (table.disposition !== 'ARCHIVE_THEN_OMIT') {
    const limit = postgresqlCopyBatchRows(table.columns.length)
    for (;;) {
      const chunk = await readChunkForTransport(
        input.source,
        input.valueRule,
        table.id,
        afterKey,
        limit,
      )
      if (!chunk.rows.length) break
      await input.target.copyChunk(
        table,
        createLogicalTableChunk({
          operationId: input.operationId,
          contract: input.contract,
          table,
          chunkIndex: chunkCount,
          rows: [...chunk.rows],
          ...(input.valueRule === 'transport' ? { valueRule: input.valueRule } : {}),
        }),
        Date.now(),
      )
      rowCount += chunk.rows.length
      input.progress?.({
        phase: 'offline-upgrade',
        detail: table.id,
        completed: rowCount,
        unit: 'rows',
      })
      chunkCount += 1
      afterKey = chunk.lastKey
    }
  }
  return { table: table.id, disposition: table.disposition, rowCount, chunkCount }
}

async function upgradeDatabaseCopy(input: {
  readonly source: VersionedSourceReader
  readonly manifest: SupportedSourceManifest
  readonly operationRoot: string
  readonly progress?: MigrationProgressCallback
  readonly createEmptyDatabase: () => Promise<OfflinePostgresqlDatabase>
  /**
   * RFC-626 §3.3: `automatic` moves the rows into the scratch database under the transport
   * value rule (the source must be read through a reader opened for the automatic upgrade) and
   * does not hold the copy to the cross-table business oracle; indexes and constraints are
   * installed as always. A manual upgrade copies as before.
   */
  readonly resolution?: ConversionResolution
  /** RFC-626 §7: handed to the reader of the scratch copy. */
  readonly onMeasure?: SourceMeasurementObserver
  /**
   * RFC-626 §4.1: borrowed by the reader of the scratch copy, which remembers there the identity
   * it measures. A later reader of the same copy in this process borrowing the same watch (the
   * execution step of the automatic upgrade) adopts it instead of reading the copy again. The
   * caller scopes it to this very copy; without one the identity lives as long as the reader.
   */
  readonly watch?: SourceWatch
}): Promise<
  OfflinePostgresqlDatabase & {
    readonly sourceWatermark: string
    readonly sourcePreflight: SourcePreflight
    readonly contractDigest: string
    readonly reader: VersionedSourceReader
  }
> {
  const automatic = input.resolution === 'automatic'
  const valueRule: LogicalValueRule = automatic ? 'transport' : 'strict'
  const source = await input.source.preflight()
  const history = await loadFrozenEpoch1History()
  const version = history.postgresql.versions.find(
    (entry) => entry.contract.digest === source.contract?.digest,
  )
  if (!version || canonicalSchemaJson(version.contract) !== canonicalSchemaJson(source.contract))
    throw new SourceBlockedError(
      'No original PostgreSQL migration version for this source; upgrade its SQLite copy first',
    )
  await input.source.assertUnchanged(source)
  mkdirSync(input.operationRoot, { recursive: true })
  const directory = mkdtempSync(join(input.operationRoot, 'epoch1-pg-upgrade-'))
  const copy = await input.createEmptyDatabase()
  const operationId = `dbm_epoch1_offline_${crypto.randomUUID().replaceAll('-', '')}`
  let reader: VersionedSourceReader | undefined
  let target: Awaited<ReturnType<typeof openPostgresqlLogicalTarget>> | undefined
  try {
    const existing = await copy.runtime
      .providerPool()
      .unsafe(
        "SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_workflow','agent_workflow_meta')",
      )
    if (existing.length) throw new SourceBlockedError('Offline PostgreSQL copy must start empty')
    target = await openPostgresqlLogicalTarget({
      runtime: copy.runtime,
      operationId,
      sourceGenerationId: source.sourceGenerationId,
      headContract: history.postgresql.head.contract,
      contract: version.contract,
      plan: version.plan,
      async verifyMigrationHistory(plan) {
        if (canonicalSchemaJson(plan) !== canonicalSchemaJson(version.plan))
          throw new SourceBlockedError('Offline PostgreSQL plan differs from frozen history')
      },
      ...(automatic ? { valueRule, businessInvariants: false } : {}),
    })
    await target.prepare(Date.now())
    const tables: LogicalTargetTableVerification[] = []
    for (const frozen of version.contract.tables)
      tables.push(
        await copyTableToScratch({
          source: input.source,
          target,
          operationId,
          contract: version.contract,
          // The copy decodes and re-verifies rows with the same corrected codecs as the reader.
          table: withLogicalCodecCorrections(frozen, input.manifest.codecCorrections),
          valueRule,
          progress: input.progress,
        }),
      )
    await input.source.assertUnchanged(source)
    await target.finalizeSchema(Date.now(), tables)
    await target.close()
    target = undefined
    await migratePostgresqlSchema({
      runtime: copy.runtime,
      headContract: history.postgresql.head.contract,
      history: history.postgresql,
    })
    await input.source.assertUnchanged(source)
    // The conversion reads the copy under the strict rule. The reader is handed out
    // preflighted; a later preflight of the same reader only compares the cheap evidence.
    reader = openEpoch1PostgresqlSource({
      runtime: copy.runtime,
      manifest: input.manifest,
      sourceGenerationId: source.sourceGenerationId,
      contentRoot: directory,
      ...(input.watch ? { watch: input.watch } : {}),
      resolution: input.resolution,
      onMeasure: input.onMeasure,
    })
    await reader.preflight()
    const resultReader = reader
    return {
      runtime: copy.runtime,
      reader,
      async close() {
        await resultReader.close()
        await copy.close()
        rmSync(directory, { recursive: true, force: true })
      },
      sourceWatermark: source.watermark,
      sourcePreflight: source,
      contractDigest: history.postgresql.head.contract.digest,
    }
  } catch (error) {
    await reader?.close()
    await target?.close()
    await copy.close()
    rmSync(directory, { recursive: true, force: true })
    throw sourceFailure(error)
  }
}

export function upgradeEpoch1Copy(
  input: Parameters<typeof upgradeFileCopy>[0],
): ReturnType<typeof upgradeFileCopy>
export function upgradeEpoch1Copy(
  input: Parameters<typeof upgradeDatabaseCopy>[0],
): ReturnType<typeof upgradeDatabaseCopy>
export function upgradeEpoch1Copy(
  input: Parameters<typeof upgradeFileCopy>[0] | Parameters<typeof upgradeDatabaseCopy>[0],
): ReturnType<typeof upgradeFileCopy> | ReturnType<typeof upgradeDatabaseCopy> {
  return 'createEmptyDatabase' in input ? upgradeDatabaseCopy(input) : upgradeFileCopy(input)
}
