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
export function collectSqliteHistoryCatalog(database: Database): HistoryCatalog {
  const objects = database
    .query<
      { type: string; name: string; tbl_name: string; sql: string | null },
      []
    >("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
  const entries: CatalogEntry[] = objects.map((row) => ({
    kind: row.type,
    relation: row.tbl_name,
    name: row.name,
    definition: sqlText(row.sql ?? ''),
  }))
  for (const table of objects.filter((row) => row.type === 'table')) {
    for (const row of database.query(`PRAGMA table_xinfo(${quote(table.name)})`).all() as Record<
      string,
      unknown
    >[])
      entries.push({
        kind: 'column',
        relation: table.name,
        name: String(row.name),
        definition: canonicalSchemaJson(row),
      })
    const fks = database.query(`PRAGMA foreign_key_list(${quote(table.name)})`).all() as Record<
      string,
      unknown
    >[]
    for (const row of fks)
      entries.push({
        kind: 'fk',
        relation: table.name,
        name: `${String(row.id)}:${String(row.seq)}`,
        definition: canonicalSchemaJson(row),
      })
    for (const row of database.query(`PRAGMA index_list(${quote(table.name)})`).all() as Record<
      string,
      unknown
    >[]) {
      const { seq: _seq, ...shape } = row
      entries.push({
        kind: 'index-shape',
        relation: table.name,
        name: String(row.name),
        definition: canonicalSchemaJson({
          ...shape,
          columns: database.query(`PRAGMA index_xinfo(${quote(String(row.name))})`).all(),
        }),
      })
    }
  }
  return sorted(entries)
}
