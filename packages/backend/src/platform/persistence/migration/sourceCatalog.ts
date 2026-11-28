// RFC-395 II-b V1: inspect actual engines, including constraints, indexes and triggers.
import type { Database } from 'bun:sqlite'
import { sortHistoryCatalog } from '../schema/history/catalogModel'
import { canonicalSchemaJson, digestSchemaContract } from '../schema/canonical'
import {
  collectSqliteHistoryCatalog,
  collectPostgresqlHistoryCatalog,
  readPostgresqlMajor,
  type HistoryCatalog,
} from '../schema/history/catalog'
import type { HistoryConnection } from '../schema/history/connection'
import type { DatabaseProvider } from '../databaseProviders'
import type { SourceDifference, SourceFingerprint, SourceJournalEntry } from './sourceTypes'

export const quoteSourceIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`
export function makeSourceFingerprint(
  provider: DatabaseProvider,
  catalog: HistoryCatalog,
  journal: readonly SourceJournalEntry[],
  tableRows: Readonly<Record<string, number>>,
  evidence: SourceFingerprint['evidence'] = 'physical-catalog-and-journal',
): SourceFingerprint {
  const payload = { version: 1 as const, evidence, provider, catalog, journal, tableRows }
  return {
    ...payload,
    catalogDigest: digestSchemaContract(catalog),
    journalEntryCount: journal.length,
    digest: digestSchemaContract(payload),
  }
}

const fileTables = (db: Database): string[] =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
    .map((table) => table.name)
function fileJournal(db: Database, tables: readonly string[]): SourceJournalEntry[] {
  return tables.includes('__drizzle_migrations')
    ? (
        db
          .query('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, hash')
          .all() as {
          hash: string
          created_at: number
        }[]
      ).map((row) => ({ identity: String(row.created_at), digest: row.hash }))
    : []
}
function collectFileFingerprint(db: Database): SourceFingerprint {
  const catalog = collectSqliteHistoryCatalog(db)
  const tables = fileTables(db)
  const tableRows: Record<string, number> = {}
  for (const name of tables) {
    const count = db.query(`SELECT count(*) AS n FROM ${quoteSourceIdentifier(name)}`).get() as {
      n: number
    }
    tableRows[name] = count.n
  }
  return makeSourceFingerprint('sqlite', catalog, fileJournal(db, tables), tableRows)
}
function collectFileStructure(db: Database): SourceFingerprint {
  const catalog = collectSqliteHistoryCatalog(db)
  const tables = fileTables(db)
  const tableRows: Record<string, number> = {}
  for (const name of tables)
    tableRows[name] = db
      .query(`SELECT 1 AS present FROM ${quoteSourceIdentifier(name)} LIMIT 1`)
      .get()
      ? 1
      : 0
  return makeSourceFingerprint('sqlite', catalog, fileJournal(db, tables), tableRows)
}

const qualifiedRelation = (relation: string): string =>
  relation.split('.').map(quoteSourceIdentifier).join('.')
const databaseTables = (catalog: HistoryCatalog) =>
  catalog.filter((row) => row.kind === 'relation' && ['r', 'p'].includes(row.definition))
async function databaseJournal(
  connection: HistoryConnection,
  tableRows: Readonly<Record<string, number>>,
): Promise<SourceJournalEntry[]> {
  return Object.hasOwn(tableRows, 'agent_workflow_meta.schema_migrations')
    ? (
        await connection.execute(
          'SELECT baseline_id, contract_digest, plan_digest FROM agent_workflow_meta.schema_migrations ORDER BY baseline_id',
        )
      ).map((row) => ({
        identity: String(row.baseline_id),
        digest: String(row.contract_digest),
        planDigest: String(row.plan_digest),
      }))
    : []
}
async function collectDatabaseFingerprint(
  connection: HistoryConnection,
): Promise<SourceFingerprint> {
  const catalog = await collectEpoch1PostgresqlCatalog(connection)
  const tableRows: Record<string, number> = {}
  const tables = databaseTables(catalog)
  // Counts share the caller's snapshot. Bound SQL size while avoiding one network trip per table.
  for (let offset = 0; offset < tables.length; offset += 64) {
    const batch = tables.slice(offset, offset + 64)
    const rows = await connection.execute(
      batch
        .map(
          (table, index) =>
            `SELECT $${index + 1}::text AS relation, count(*) AS n FROM ${qualifiedRelation(table.relation)}`,
        )
        .join(' UNION ALL '),
      batch.map((table) => table.relation),
    )
    const counts = new Map(rows.map((row) => [String(row.relation), row.n]))
    for (const table of batch) {
      const count = Number(counts.get(table.relation))
      if (!Number.isSafeInteger(count))
        throw new Error(
          `source row count exceeds safe integer: ${qualifiedRelation(table.relation)}`,
        )
      tableRows[table.relation] = count
    }
  }
  return {
    ...makeSourceFingerprint(
      'postgresql',
      catalog,
      await databaseJournal(connection, tableRows),
      tableRows,
    ),
    postgresqlMajor: await readPostgresqlMajor(connection),
  }
}
async function collectDatabaseStructure(connection: HistoryConnection): Promise<SourceFingerprint> {
  const catalog = await collectEpoch1PostgresqlCatalog(connection)
  const tableRows: Record<string, number> = {}
  const tables = databaseTables(catalog)
  for (let offset = 0; offset < tables.length; offset += 64) {
    const batch = tables.slice(offset, offset + 64)
    const rows = await connection.execute(
      batch
        .map(
          (table, index) =>
            `SELECT $${index + 1}::text AS relation, EXISTS (SELECT 1 FROM ${qualifiedRelation(table.relation)}) AS present`,
        )
        .join(' UNION ALL '),
      batch.map((table) => table.relation),
    )
    const present = new Map(rows.map((row) => [String(row.relation), row.present]))
    for (const table of batch) {
      const value = present.get(table.relation)
      if (typeof value !== 'boolean')
        throw new Error(`source table could not be probed: ${qualifiedRelation(table.relation)}`)
      tableRows[table.relation] = Number(value)
    }
  }
  return {
    ...makeSourceFingerprint(
      'postgresql',
      catalog,
      await databaseJournal(connection, tableRows),
      tableRows,
    ),
    postgresqlMajor: await readPostgresqlMajor(connection),
  }
}

export function collectSourceFingerprint(connection: Database): SourceFingerprint
export function collectSourceFingerprint(connection: HistoryConnection): Promise<SourceFingerprint>
export function collectSourceFingerprint(
  connection: Database | HistoryConnection,
): SourceFingerprint | Promise<SourceFingerprint> {
  return 'query' in connection
    ? collectFileFingerprint(connection)
    : collectDatabaseFingerprint(connection)
}

/**
 * RFC-626 §3.5: the structure of a source without its row counts. Only the catalog and the
 * migration journal are read, so the cost does not grow with the data: this is what the
 * read-only check before an automatic upgrade can afford. `tableRows` does not hold counts
 * here: it is 1 for a table with at least one row and 0 for an empty one, asked with a
 * single-row probe. That is all identification needs — it only has to tell an unknown empty
 * table from an unknown table with data.
 *
 * The result has the shape of a fingerprint so that `identifySource` can read it, but its
 * digest is not the digest of the source: never persist it or compare it with the counted
 * fingerprint a freeze takes.
 */
export function collectSourceStructure(connection: Database): SourceFingerprint
export function collectSourceStructure(connection: HistoryConnection): Promise<SourceFingerprint>
export function collectSourceStructure(
  connection: Database | HistoryConnection,
): SourceFingerprint | Promise<SourceFingerprint> {
  return 'query' in connection
    ? collectFileStructure(connection)
    : collectDatabaseStructure(connection)
}

export function diffSourceCatalog(
  expected: HistoryCatalog,
  actual: HistoryCatalog,
): SourceDifference[] {
  const key = (row: HistoryCatalog[number]) => `${row.kind}:${row.relation}:${row.name}`
  const before = new Map(expected.map((row) => [key(row), row.definition]))
  const after = new Map(actual.map((row) => [key(row), row.definition]))
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((path) =>
      before.get(path) === after.get(path)
        ? []
        : [{ path, expected: before.get(path) ?? null, actual: after.get(path) ?? null }],
    )
}
export function sameSourceJournal(
  a: readonly SourceJournalEntry[],
  b: readonly SourceJournalEntry[],
): boolean {
  const ordered = (rows: readonly SourceJournalEntry[]) =>
    [...rows].sort((x, y) => x.identity.localeCompare(y.identity))
  return canonicalSchemaJson(ordered(a)) === canonicalSchemaJson(ordered(b))
}

/** Identity sequence ownership is part of an empty-table decision, never inferred by naming. */
export async function collectEpoch1PostgresqlCatalog(
  connection: HistoryConnection,
): Promise<HistoryCatalog> {
  const catalog = await collectPostgresqlHistoryCatalog(connection)
  const owners = await connection.execute(`SELECT ns.nspname || '.' || seq.relname AS sequence,
    nt.nspname || '.' || tab.relname || '.' || att.attname AS owner
    FROM pg_class seq JOIN pg_namespace ns ON ns.oid=seq.relnamespace
    JOIN pg_depend dep ON dep.objid=seq.oid AND dep.classid='pg_class'::regclass AND dep.refclassid='pg_class'::regclass AND dep.deptype IN ('a','i')
    JOIN pg_class tab ON tab.oid=dep.refobjid JOIN pg_namespace nt ON nt.oid=tab.relnamespace
    JOIN pg_attribute att ON att.attrelid=tab.oid AND att.attnum=dep.refobjsubid
    WHERE seq.relkind='S' AND ns.nspname IN ('agent_workflow','agent_workflow_meta')`)
  return sortHistoryCatalog([
    ...catalog,
    ...owners.map((row) => ({
      kind: 'sequence-owner',
      relation: String(row.sequence),
      name: String(row.sequence),
      definition: String(row.owner),
    })),
  ])
}
