import type { Database } from 'bun:sqlite'
import { canonicalSchemaJson } from '../schema/canonical'
import { quoteSchemaIdentifier as quote } from '../schema/expressions'
import {
  sortHistoryCatalog as sorted,
  type CatalogEntry,
  type HistoryCatalog,
} from '../schema/history/catalogModel'
/** Normalize only SQL spelling outside quoted values; never fold literal/identifier bytes. */
function sqlText(value: string): string {
  return (value.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+|[^\s'"]+/g) ?? [])
    .map((part) =>
      /^\s+$/.test(part)
        ? ''
        : part.startsWith("'") || part.startsWith('"')
          ? part
          : part.toLowerCase(),
    )
    .join('')
    .replace(/;$/, '')
}
/** A row of `sqlite_schema` the history catalog lists. */
export interface SqliteSchemaObject {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string | null
}
/**
 * The catalog entries of the given schema rows and, for every table among them, of its columns,
 * foreign keys and indexes as SQLite reports them. Unsorted. `read` runs one statement: the
 * whole-database collector goes through the connection's statement cache, a caller that
 * applies DDL between reads does not (RFC-626, `migration/supportedSources.ts`).
 */
export function sqliteCatalogEntries(
  objects: readonly SqliteSchemaObject[],
  read: (sql: string) => Record<string, unknown>[],
): CatalogEntry[] {
  const entries: CatalogEntry[] = objects.map((row) => ({
    kind: row.type,
    relation: row.tbl_name,
    name: row.name,
    definition: sqlText(row.sql ?? ''),
  }))
  for (const table of objects.filter((row) => row.type === 'table')) {
    for (const row of read(`PRAGMA table_xinfo(${quote(table.name)})`))
      entries.push({
        kind: 'column',
        relation: table.name,
        name: String(row.name),
        definition: canonicalSchemaJson(row),
      })
    for (const row of read(`PRAGMA foreign_key_list(${quote(table.name)})`))
      entries.push({
        kind: 'fk',
        relation: table.name,
        name: `${String(row.id)}:${String(row.seq)}`,
        definition: canonicalSchemaJson(row),
      })
    for (const row of read(`PRAGMA index_list(${quote(table.name)})`)) {
      const { seq: _seq, ...shape } = row
      entries.push({
        kind: 'index-shape',
        relation: table.name,
        name: String(row.name),
        definition: canonicalSchemaJson({
          ...shape,
          columns: read(`PRAGMA index_xinfo(${quote(String(row.name))})`),
        }),
      })
    }
  }
  return entries
}
export function collectSqliteHistoryCatalog(database: Database): HistoryCatalog {
  const objects = database
    .query<
      SqliteSchemaObject,
      []
    >("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
  return sorted(
    sqliteCatalogEntries(objects, (sql) => database.query(sql).all() as Record<string, unknown>[]),
  )
}
