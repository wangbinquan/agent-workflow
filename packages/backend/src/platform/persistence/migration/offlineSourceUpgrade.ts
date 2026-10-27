import type { MigrationProgressCallback } from './run/progress'
// RFC-395 II-b V1: historical migrations run only in newly created offline copies.
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { vacuumSqliteInto } from './legacy/sqliteSnapshot'
import { applyFrozenSqliteMigrations } from './epoch1/sqliteChain'
import { assertSqliteIntegrity } from './rawSourceReader'
import {
  captureSourceDispositionRows,
  type SourceDispositionEvidence,
} from './sourceDispositionEvidence'
import { openEpoch1SqliteSource, type Epoch1SqliteSource } from './sqliteSourceReader'
import { openEpoch1PostgresqlSource } from './postgresqlSourceReader'
import {
  createLogicalTableChunk,
  type CanonicalLogicalValue,
} from './legacy/logicalDatabaseArtifact'
import { openPostgresqlLogicalTarget } from './legacy/postgresqlLogicalTarget'
import { migratePostgresqlSchema } from './legacy/postgresqlMigrator'
import type { PostgresqlDatabaseRuntime } from '../postgresqlRuntime'
import { canonicalSchemaJson } from '../schema/canonical'
import type { LogicalTargetTableVerification } from './legacy/logicalDatabaseRestore'
import { loadFrozenEpoch1History } from './epoch1/bundle'
import { collectSourceFingerprint } from './sourceCatalog'
import { identifySource, type SupportedSourceManifest } from './supportedSources'
import type { EmptyTableDecision } from './sourceDispositions'
import {
  SourceBlockedError,
  sourceFailure,
  type SourcePreflight,
  type SourceFingerprint,
  type VersionedSourceReader,
} from './sourceTypes'

// SQLite requires VACUUM/files/PRAGMAs; PostgreSQL requires a provisioned server
// and a logical load. The two upgrade mechanisms are intentionally dialect-specific.
async function upgradeFileCopy(input: {
  readonly source: Epoch1SqliteSource
  readonly expected: SourcePreflight
  readonly manifest: SupportedSourceManifest
  readonly operationRoot: string
  readonly progress?: MigrationProgressCallback
  readonly emptyTables?: readonly EmptyTableDecision[]
}): Promise<{
  readonly path: string
  readonly before: SourceFingerprint
  readonly after: SourceFingerprint
  readonly sourceWatermark: string
  readonly sourcePreflight: SourcePreflight
  readonly reader: Epoch1SqliteSource
  readonly sourceEvidence: readonly SourceDispositionEvidence[]
  close(): Promise<void>
}> {
  await input.source.assertUnchanged(input.expected)
  mkdirSync(input.operationRoot, { recursive: true })
  const directory = mkdtempSync(join(input.operationRoot, 'epoch1-upgrade-'))
  const path = join(directory, 'upgraded.sqlite')
  let copy: Database | undefined
  let reader: Epoch1SqliteSource | undefined
  try {
    const sourceEvidence = await captureSourceDispositionRows(
      input.source,
      input.expected,
      join(directory, 'pre-upgrade'),
    )
    await input.source.assertUnchanged(input.expected)
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
    assertSqliteIntegrity(copy)
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
    reader = openEpoch1SqliteSource({
      path,
      manifest: input.manifest,
      operationRoot: directory,
      emptyTables: input.emptyTables,
      sourceGenerationId: input.expected.sourceGenerationId,
    })
    await reader.preflight()
    const resultReader = reader
    return {
      path,
      before,
      after,
      sourceWatermark: input.expected.watermark,
      sourcePreflight: input.expected,
      reader,
      sourceEvidence,
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
async function upgradeDatabaseCopy(input: {
  readonly source: VersionedSourceReader
  readonly manifest: SupportedSourceManifest
  readonly operationRoot: string
  readonly progress?: MigrationProgressCallback
  readonly createEmptyDatabase: () => Promise<OfflinePostgresqlDatabase>
}): Promise<
  OfflinePostgresqlDatabase & {
    readonly sourceWatermark: string
    readonly sourcePreflight: SourcePreflight
    readonly contractDigest: string
    readonly reader: VersionedSourceReader
    readonly sourceEvidence: readonly SourceDispositionEvidence[]
  }
> {
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
  const sourceEvidence = await captureSourceDispositionRows(
    input.source,
    source,
    join(directory, 'pre-upgrade'),
  )
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
    })
    await target.prepare(Date.now())
    const tables: LogicalTargetTableVerification[] = []
    for (const table of version.contract.tables) {
      let afterKey: readonly CanonicalLogicalValue[] | null = null
      let rowCount = 0
      let chunkCount = 0
      // Archive-only data remains on the immutable source, never silently discarded.
      if (table.disposition !== 'ARCHIVE_THEN_OMIT') {
        for (;;) {
          const chunk = await input.source.readChunk(table.id, afterKey, 1000)
          if (!chunk.rows.length) break
          await target.copyChunk(
            table,
            createLogicalTableChunk({
              operationId,
              contract: version.contract,
              table,
              chunkIndex: chunkCount,
              rows: [...chunk.rows],
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
      tables.push({ table: table.id, disposition: table.disposition, rowCount, chunkCount })
    }
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
    reader = openEpoch1PostgresqlSource({
      runtime: copy.runtime,
      manifest: input.manifest,
      sourceGenerationId: source.sourceGenerationId,
      contentRoot: directory,
    })
    await reader.preflight()
    const resultReader = reader
    return {
      runtime: copy.runtime,
      reader,
      sourceEvidence,
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
