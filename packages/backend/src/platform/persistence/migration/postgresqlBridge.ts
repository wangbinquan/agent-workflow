// RFC-398 §3.8: lossless original-contract load; conversion rules remain untouched.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { createSha256DigestBuilder } from '@/util/hash'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalSchemaJson, digestSchemaContract } from '../schema/canonical'
import { collectSqliteHistoryCatalog } from '../schema/history/catalog'
import { loadFrozenEpoch1History } from './epoch1/bundle'
import { createFrozenSqliteJournal, applyFrozenSqliteMigrations } from './epoch1/sqliteChain'
import type { ReleasedPostgresqlSource } from './epoch1/releasedPostgresql'
import {
  decodeLogicalRow,
  encodeLogicalRow,
  writeDurableLogicalArtifact,
  type CanonicalLogicalRow,
  type CanonicalLogicalValue,
} from './legacy/logicalDatabaseArtifact'
import type { VerifiedLogicalDatabaseArtifactSource } from './legacy/logicalDatabaseRestore'
import type { SupportedSourceContract, SupportedSourceManifest } from './supportedSources'
import { unhandledDatabaseProvider } from '../databaseProviders'
import { openEpoch1SqliteSource } from './sqliteSourceReader'
import { quoteSourceIdentifier as quote } from './sourceCatalog'
import { SourceBlockedError, type SourcePreflight, type VersionedSourceReader } from './sourceTypes'
import { sourceChunk } from './sourceReader'
import { rawSourceChunk } from './rawSourceReader'

export interface PostgresqlBridgeRowBlock {
  readonly table: string
  readonly key: readonly CanonicalLogicalValue[] | null
  readonly row: CanonicalLogicalRow | null
  readonly constraint: string
}
export class PostgresqlBridgeBlockedError extends SourceBlockedError {
  constructor(readonly blocks: readonly PostgresqlBridgeRowBlock[]) {
    super(
      'postgresql-logical-bridge-sqlite-constraint',
      blocks.map((block) => ({
        path: `${block.table}:${canonicalSchemaJson(block.key)}`,
        expected: 'SQLite@0223 constraints',
        actual: block.constraint,
      })),
    )
  }
}
export interface PostgresqlBridgeReceipt {
  readonly version: 1
  readonly release: string
  readonly sourceFingerprint: string
  readonly sourceWatermark: string
  readonly sourceGenerationId: string
  readonly contractDigest: string
  readonly archiveDigest: string | null
  readonly sqliteCatalogDigest: string
  readonly tables: readonly {
    table: string
    origin: 'active' | 'archive'
    rows: number
    sourceDigest: string
    sqliteDigest: string
  }[]
}

export async function bridgeReleasedPostgresql(input: {
  readonly release: ReleasedPostgresqlSource
  readonly source: VersionedSourceReader
  readonly expected: SourcePreflight
  readonly manifest: SupportedSourceManifest
  readonly path: string
  readonly archive?: VerifiedLogicalDatabaseArtifactSource
  readonly archiveDigest: string | null
  /** A verified logical backup already contains the original archive rows. */
  readonly archiveReader?: VersionedSourceReader
}) {
  const { release, expected } = input
  await input.source.assertUnchanged(expected)
  if (
    input.archive &&
    input.archive.verification.manifest.payload.schemaDigest !== release.contract.digest
  )
    throw new SourceBlockedError('postgresql-bridge-archive-contract-mismatch')
  const history = await loadFrozenEpoch1History()
  const migrations = release.sqliteMigrations.map((receipt, index) => {
    const migration = history.sqlite[index]
    if (
      !migration ||
      migration.folderMillis !== receipt.folderMillis ||
      migration.hash !== receipt.hash ||
      history.sqliteTags[index] !== receipt.tag
    )
      throw new SourceBlockedError(`Released SQLite receipt differs at ${release.tag}:${index}`)
    return migration
  })
  mkdirSync(dirname(input.path), { recursive: true })
  const db = new Database(input.path, { create: true, strict: true })
  const blocks: PostgresqlBridgeRowBlock[] = []
  const measurements: {
    table: string
    origin: 'active' | 'archive'
    rows: number
    sourceDigest: string
    sqliteDigest: string
  }[] = []
  try {
    // 1. Install the exact released prefix and its real receipts.
    createFrozenSqliteJournal(db)
    applyFrozenSqliteMigrations(db, migrations)
    // 2. Prevent AFTER INSERT lineage triggers and migration seeds from changing source values.
    const triggers = db
      .query("SELECT name, sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
      .all() as { name: string; sql: string }[]
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN')
    try {
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`)
      for (const table of db
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name <> '__drizzle_migrations'",
        )
        .all() as { name: string }[])
        db.exec(`DELETE FROM ${quote(table.name)}`)
      // 3. Decode with this release's contract, including its six archive-only tables.
      for (const table of release.contract.tables) {
        const archived = table.disposition === 'ARCHIVE_THEN_OMIT'
        const digest = createSha256DigestBuilder()
        let rows = 0
        const insert = db.query(
          `INSERT INTO ${quote(table.sourceTable)} (${table.columns.map((column) => quote(column.name)).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`,
        )
        const load = (row: CanonicalLogicalRow) => {
          digest.update(canonicalSchemaJson(row) + '\n')
          rows += 1
          try {
            const decoded = decodeLogicalRow(table, row)
            insert.run(
              ...table.columns.map((column) => {
                const value = decoded[column.name]
                return (typeof value === 'boolean' ? Number(value) : value) as SQLQueryBindings
              }),
            )
          } catch (error) {
            const code = String((error as { code?: unknown }).code ?? '')
            if (!code.startsWith('SQLITE_CONSTRAINT')) throw error
            blocks.push({ table: table.id, key: row.key, row, constraint: String(error) })
          }
        }
        if (archived && input.archive) {
          const entry = input.archive.verification.manifest.payload.tables.find(
            (entry) => entry.table === table.id,
          )!
          for (let index = 0; index < entry.chunkCount; index++)
            for (const row of input.archive.readChunk(table, index).payload.rows) load(row)
        } else if (!archived || input.archiveReader) {
          const reader = archived ? input.archiveReader! : input.source
          let after: readonly CanonicalLogicalValue[] | null = null
          for (;;) {
            const chunk = await reader.readChunk(table.id, after, 1000)
            if (!chunk.rows.length) break
            for (const row of chunk.rows) load(row)
            after = chunk.lastKey
          }
        }
        const expectedRows =
          archived && input.archive
            ? input.archive.verification.manifest.payload.tables.find(
                (entry) => entry.table === table.id,
              )!.rowCount
            : (expected.tables.find((entry) => entry.table === table.id)?.rows ?? 0)
        if (rows !== expectedRows)
          throw new SourceBlockedError(`postgresql-bridge-source-row-count:${table.id}`)
        measurements.push({
          table: table.id,
          origin: archived ? 'archive' : 'active',
          rows,
          sourceDigest: `sha256:${digest.digestHex()}`,
          sqliteDigest: '',
        })
      }
      // 4. Restore the identical DDL before integrity and catalog equality checks.
      for (const trigger of triggers) db.exec(trigger.sql)
      const foreignKeys = db.query('PRAGMA foreign_key_check').all() as {
        table: string
        rowid: number | null
        parent: string
        fkid: number
      }[]
      for (const failure of foreignKeys) {
        const table = release.contract.tables.find((table) => table.sourceTable === failure.table)
        const query = db.query(`SELECT * FROM ${quote(failure.table)} WHERE rowid = ?`)
        ;(query as typeof query & { safeIntegers(value: boolean): void }).safeIntegers(true)
        const value = query.get(failure.rowid) as Record<string, unknown> | null
        const row = table && value ? encodeLogicalRow(table, value) : null
        blocks.push({
          table: table?.id ?? failure.table,
          key: row?.key ?? null,
          row,
          constraint: `foreign-key:${failure.fkid}:${failure.parent}`,
        })
      }
      if (blocks.length) throw new PostgresqlBridgeBlockedError(blocks)
      const check = db.query('PRAGMA quick_check').all() as { quick_check: string }[]
      if (check.length !== 1 || check[0]?.quick_check !== 'ok')
        throw new SourceBlockedError('postgresql-bridge-quick-check-failed')
      if (
        canonicalSchemaJson(collectSqliteHistoryCatalog(db)) !==
        canonicalSchemaJson(release.sqliteCatalog)
      )
        throw new SourceBlockedError('postgresql-bridge-catalog-mismatch')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } catch (error) {
    if (error instanceof PostgresqlBridgeBlockedError)
      writeDurableLogicalArtifact(join(dirname(input.path), 'bridge-blocks.json'), {
        sourceFingerprint: expected.fingerprint.digest,
        sourceWatermark: expected.watermark,
        blocks: error.blocks,
      })
    throw error
  } finally {
    db.close()
  }

  // Give this private SQLite prefix the release's codecs without globally relabelling SQLite sources.
  const manifest: SupportedSourceManifest = {
    ...input.manifest,
    sources: input.manifest.sources.map((source) =>
      isPrivateSqlitePrefix(source, migrations.length)
        ? { ...source, contract: release.contract, readMode: 'frozen-codec' }
        : source,
    ),
  }
  const physical = openEpoch1SqliteSource({
    path: input.path,
    manifest,
    operationRoot: dirname(input.path),
    sourceGenerationId: expected.sourceGenerationId,
  })
  try {
    const sqlite = await physical.preflight()
    // 5. Chunk-independent canonical logical digests and counts, including archived rows.
    for (const measurement of measurements) {
      const digest = createSha256DigestBuilder()
      let count = 0
      let after: readonly CanonicalLogicalValue[] | null = null
      for (;;) {
        const chunk = await physical.readChunk(measurement.table, after, 1000)
        if (!chunk.rows.length) break
        for (const row of chunk.rows) {
          digest.update(canonicalSchemaJson(row) + '\n')
          count++
        }
        after = chunk.lastKey
      }
      measurement.sqliteDigest = `sha256:${digest.digestHex()}`
      if (count !== measurement.rows || measurement.sqliteDigest !== measurement.sourceDigest)
        throw new SourceBlockedError(`postgresql-bridge-logical-mismatch:${measurement.table}`)
    }
    await input.source.assertUnchanged(expected)
    const receipt: PostgresqlBridgeReceipt = {
      version: 1,
      release: release.tag,
      sourceFingerprint: expected.fingerprint.digest,
      sourceWatermark: expected.watermark,
      sourceGenerationId: expected.sourceGenerationId,
      contractDigest: release.contract.digest,
      archiveDigest: input.archiveDigest,
      sqliteCatalogDigest: digestSchemaContract(release.sqliteCatalog),
      tables: measurements,
    }
    const extra = expected.tables.filter(
      (table) => !sqlite.tables.some((candidate) => candidate.table === table.table),
    )
    const metadata = new Set(extra.map((table) => table.table))
    const preflight: SourcePreflight = {
      ...expected,
      tables: [...sqlite.tables, ...extra],
      expectedAbsent: sqlite.expectedAbsent,
    }
    // Identity and metadata stay PostgreSQL; actual business/archive reads use the SQLite copy.
    const reader: VersionedSourceReader = {
      kind: expected.kind,
      preflight: async () => {
        await reader.assertUnchanged(preflight)
        return preflight
      },
      async assertUnchanged(value) {
        if (canonicalSchemaJson(value) !== canonicalSchemaJson(preflight))
          throw new SourceBlockedError('postgresql-bridge-binding-mismatch')
        await input.source.assertUnchanged(expected)
        await physical.assertUnchanged(sqlite)
      },
      async readChunk(table, afterKey, limit) {
        if (metadata.has(table)) return input.source.readChunk(table, afterKey, limit)
        const chunk = await physical.readChunk(table, afterKey, limit)
        return sourceChunk({
          ...chunk,
          table: release.contract.tables.find((entry) => entry.id === table)!,
          sourceVersion: expected.sourceVersion,
        })
      },
      async readRawChunk(table, afterKey, limit) {
        if (metadata.has(table)) return input.source.readRawChunk(table, afterKey, limit)
        const chunk = await physical.readRawChunk(table, afterKey, limit)
        return rawSourceChunk({
          table: chunk.table,
          migrationKey: chunk.migrationKey,
          afterKey: chunk.afterKey,
          rows: chunk.rows,
          sourceVersion: expected.sourceVersion,
        })
      },
      close: () => physical.close(),
    }
    return { physical, reader, preflight, receipt, manifest }
  } catch (error) {
    await physical.close()
    throw error
  }
}

/** The manifest entry for the private SQLite prefix this bridge builds (SQLite at `through`). */
function isPrivateSqlitePrefix(source: SupportedSourceContract, through: number): boolean {
  switch (source.provider) {
    case 'sqlite':
      return source.sqliteThrough === through
    case 'postgresql':
      return false
    default:
      return unhandledDatabaseProvider(source.provider)
  }
}
