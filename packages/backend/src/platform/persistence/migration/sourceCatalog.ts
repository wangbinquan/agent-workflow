// RFC-395 II-b V1: inspect actual engines, including constraints, indexes and triggers.
import type { Database } from 'bun:sqlite'
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

function collectFileFingerprint(db: Database): SourceFingerprint {
  const catalog = collectSqliteHistoryCatalog(db)
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
  const tableRows: Record<string, number> = {}
  for (const { name } of tables) {
    const count = db.query(`SELECT count(*) AS n FROM ${quoteSourceIdentifier(name)}`).get() as {
      n: number
    }
    tableRows[name] = count.n
  }
  const journal = tables.some((table) => table.name === '__drizzle_migrations')
    ? (
        db
          .query('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, hash')
          .all() as {
          hash: string
          created_at: number
        }[]
      ).map((row) => ({ identity: String(row.created_at), digest: row.hash }))
    : []
  return makeSourceFingerprint('sqlite', catalog, journal, tableRows)
}

async function collectDatabaseFingerprint(
  connection: HistoryConnection,
): Promise<SourceFingerprint> {
  const catalog = await collectEpoch1PostgresqlCatalog(connection)
  const tableRows: Record<string, number> = {}
  for (const table of catalog.filter(
    (row) => row.kind === 'relation' && ['r', 'p'].includes(row.definition),
  )) {
    const name = table.relation.split('.').map(quoteSourceIdentifier).join('.')
    const rows = await connection.execute(`SELECT count(*) AS n FROM ${name}`)
    const count = Number(rows[0]?.n)
    if (!Number.isSafeInteger(count))
      throw new Error(`source row count exceeds safe integer: ${name}`)
    tableRows[table.relation] = count
  }
  const journal = Object.hasOwn(tableRows, 'agent_workflow_meta.schema_migrations')
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
  return {
    ...makeSourceFingerprint('postgresql', catalog, journal, tableRows),
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
  return [
    ...catalog,
    ...owners.map((row) => ({
      kind: 'sequence-owner',
      relation: String(row.sequence),
      name: String(row.sequence),
      definition: String(row.owner),
    })),
  ].sort((a, b) => canonicalSchemaJson(a).localeCompare(canonicalSchemaJson(b)))
}
