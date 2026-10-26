import type { HistorySession } from './session'
// RFC-395 II-b R2: shared epoch-2 admission policy; no epoch-1 runtime caller.
import { Database } from 'bun:sqlite'
import { unhandledDatabaseProvider } from '../../databaseProviders'
import { type HistoryConnection } from './connection'
import { assertHistoryRow, readSchemaHistoryRows } from './apply'
import { verifyHistoryVersion } from './artifacts'
import { isExpandOnlyEdge, deriveSchemaEdge, sameSchemaValue, sameHistoryVersion } from './edgeDiff'
import {
  type HistoryCatalogCache,
  assertHistoryCatalog,
  collectSqliteHistoryCatalog,
  collectPostgresqlHistoryCatalog,
  type HistoryCatalog,
  readPostgresqlMajor,
} from './catalog'
import { compileMetaTables, HISTORY_META_TABLES, type MetaTableDeclaration } from './meta'
import { targetSentinelStatements } from './markers'
import { digestSchemaContract } from '../canonical'
import { SchemaHistoryError, type HistoryVersion, type SchemaHistoryRow } from './types'

export function expandOnlySuccessorOf(
  binary: HistoryVersion,
  rows: readonly SchemaHistoryRow[],
): HistoryVersion | null {
  if (
    !rows.length ||
    rows[0]!.version !== binary.contract.version ||
    !sameHistoryVersion(rows[0]!.artifact, binary)
  )
    return null
  let previous = binary
  for (const row of rows.slice(1)) {
    assertHistoryRow(row)
    const next = row.artifact
    const edge = next.contract.edge
    if (
      next.contract.version !== previous.contract.version + 1 ||
      next.contract.previousDigest !== previous.contract.digest ||
      !edge ||
      !isExpandOnlyEdge(edge, next.contract.contract)
    )
      return null
    if (
      !sameSchemaValue(
        edge,
        deriveSchemaEdge(edge.kind, previous.contract.contract, next.contract.contract, edge),
      )
    )
      return null
    previous = next
  }
  return previous.contract.version > binary.contract.version ? previous : null
}
export interface HistoryAdmissionOptions {
  readonly binary: HistoryVersion
  readonly catalogCache: HistoryCatalogCache
  readonly metaTables?: readonly MetaTableDeclaration[]
}
async function admit(
  connection: HistoryConnection,
  actual: () => Promise<HistoryCatalog>,
  options: HistoryAdmissionOptions,
): Promise<HistoryVersion> {
  verifyHistoryVersion(options.binary)
  const rows = await readSchemaHistoryRows(connection, options.binary.contract.version)
  const last = rows.at(-1)
  if (!last)
    throw new SchemaHistoryError(
      'database-older-than-binary',
      'apply the declared history before admission',
    )
  for (const row of rows) assertHistoryRow(row)
  let head = last.artifact
  if (last.version === options.binary.contract.version) {
    if (!sameHistoryVersion(head, options.binary))
      throw new SchemaHistoryError('binary-contract-mismatch', String(last.version))
  } else {
    const successor = expandOnlySuccessorOf(options.binary, rows)
    if (!successor)
      throw new SchemaHistoryError(
        'non-expand-successor',
        `database version ${last.version} requires a newer epoch-2 binary`,
      )
    head = successor
  }
  let postgresqlMajor: number | undefined
  switch (connection.provider) {
    case 'sqlite':
      break
    case 'postgresql':
      postgresqlMajor = await readPostgresqlMajor(connection)
      break
    default:
      return unhandledDatabaseProvider(connection.provider)
  }
  const expected = await options.catalogCache.expected(
    head[connection.provider],
    options.metaTables,
    postgresqlMajor,
    head.postgresqlCatalog,
  )
  assertHistoryCatalog(expected, await actual())
  return head
}
export function admitHistory(
  session: HistorySession,
  options: HistoryAdmissionOptions,
): Promise<HistoryVersion> {
  return session.read((connection, actual) => admit(connection, actual, options))
}

/** Admit on a caller-owned snapshot, without opening a second transaction. */
export function admitPostgresqlHistoryConnection(
  connection: HistoryConnection,
  options: HistoryAdmissionOptions,
): Promise<HistoryVersion> {
  return admit(connection, () => collectPostgresqlHistoryCatalog(connection), options)
}

const sqliteCatalogs = new Map<string, HistoryCatalog>()
export function admitSqliteHistorySync(
  database: Database,
  options: Pick<HistoryAdmissionOptions, 'binary' | 'metaTables'>,
): HistoryVersion {
  verifyHistoryVersion(options.binary)
  if (!database.query("SELECT 1 FROM sqlite_schema WHERE name = 'aw_meta_schema_history'").get())
    throw new SchemaHistoryError(
      'not-epoch-2-database',
      'Run db migration plan and approve the epoch-1 conversion before starting.',
    )
  const rows: SchemaHistoryRow[] = (
    database
      .query('SELECT * FROM aw_meta_schema_history WHERE version >= ? ORDER BY version')
      .all(options.binary.contract.version) as Record<string, unknown>[]
  ).map((row) => ({
    version: Number(row.version),
    contractDigest: String(row.contract_digest),
    sqlitePlanDigest: String(row.sqlite_plan_digest),
    postgresqlPlanDigest: String(row.postgresql_plan_digest),
    appliedAt: Number(row.applied_at),
    artifact: JSON.parse(String(row.artifact_json)) as HistoryVersion,
  }))
  for (const row of rows) assertHistoryRow(row)
  const last = rows.at(-1)
  if (!last)
    throw new SchemaHistoryError(
      'database-older-than-binary',
      'Apply schema history before admission',
    )
  const head =
    last.version === options.binary.contract.version
      ? sameHistoryVersion(last.artifact, options.binary)
        ? last.artifact
        : null
      : expandOnlySuccessorOf(options.binary, rows)
  if (!head) throw new SchemaHistoryError('binary-contract-mismatch', String(last.version))
  const meta = options.metaTables ?? HISTORY_META_TABLES
  const key = digestSchemaContract([head.sqlite.digest, meta])
  let expected = sqliteCatalogs.get(key)
  if (!expected) {
    const reference = new Database(':memory:')
    try {
      for (const statement of [
        ...head.sqlite.head.map((entry) => entry.sql),
        ...compileMetaTables('sqlite', meta),
        ...targetSentinelStatements('sqlite'),
      ])
        reference.exec(statement)
      expected = collectSqliteHistoryCatalog(reference)
      sqliteCatalogs.set(key, expected)
    } finally {
      reference.close()
    }
  }
  assertHistoryCatalog(expected, collectSqliteHistoryCatalog(database))
  return head
}
