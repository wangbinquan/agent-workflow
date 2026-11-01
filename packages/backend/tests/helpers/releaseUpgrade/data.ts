// RFC-398 §7.2/§7.4: independent fixture values and key digests, never conversion output.
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { SQL } from 'bun'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { encodeLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type { LogicalTableContract } from '@/platform/persistence/schema/contractTypes'
import {
  quoteIdentifier,
  columns,
  tableNames,
} from '../../../../../scripts/release-upgrade/lib/seed-ledger'

export type Row = Record<string, unknown>
export type Snapshot = Map<string, Row[]>
export const UPGRADE_TIME = 1778459600000
export const q = quoteIdentifier
export function invariant(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`RFC-398 matrix: ${detail}`)
}
export function normalized(value: unknown): unknown {
  if (typeof value === 'bigint') return { integer: String(value) }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return { integer: String(value) }
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalized(v)]))
  return value
}
export function equal(actual: unknown, expected: unknown, label: string): void {
  const a = canonicalSchemaJson(normalized(actual)),
    b = canonicalSchemaJson(normalized(expected))
  invariant(a === b, `${label}\nexpected ${b.slice(0, 8000)}\nactual ${a.slice(0, 8000)}`)
}
export function sortedRows(rows: readonly Row[]): unknown[] {
  return rows
    .map(normalized)
    .sort((a, b) => canonicalSchemaJson(a).localeCompare(canonicalSchemaJson(b)))
}
export function sqliteSnapshot(db: Database): Snapshot {
  return new Map(
    tableNames(db).map((table) => [table, db.query<Row, []>(`SELECT * FROM ${q(table)}`).all()]),
  )
}
/** `sqlitePhysical` returns a target in SQLite's physical form (BIGINT → integer number,
 * BOOLEAN → 0/1), chosen by catalog type only, so one provider-neutral oracle checks both
 * targets. Source snapshots stay raw: their checks compare PostgreSQL text renderings. */
export async function pgSnapshot(
  sql: SQL,
  options: { sqlitePhysical?: boolean } = {},
): Promise<Snapshot> {
  const tables = await sql.unsafe<{ table_schema: string; table_name: string }[]>(
    "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN ('agent_workflow','agent_workflow_meta') AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
  )
  const types = new Map(
    (options.sqlitePhysical
      ? await sql.unsafe<
          { table_schema: string; table_name: string; column_name: string; data_type: string }[]
        >(
          "SELECT table_schema,table_name,column_name,data_type FROM information_schema.columns WHERE table_schema IN ('agent_workflow','agent_workflow_meta')",
        )
      : []
    ).map((c) => [`${c.table_schema}.${c.table_name}.${c.column_name}`, c.data_type]),
  )
  const physical = (table: string, column: string, value: unknown): unknown => {
    const type = types.get(`${table}.${column}`)
    if (value === null || type === undefined) return value
    if (type === 'boolean') return value ? 1 : 0
    if (type !== 'bigint' && type !== 'integer' && type !== 'smallint') return value
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : BigInt(String(value))
  }
  const result: Snapshot = new Map()
  for (const table of tables) {
    const rows = await sql.unsafe<Row[]>(
      `SELECT * FROM ${q(table.table_schema)}.${q(table.table_name)} t ORDER BY to_jsonb(t)::text COLLATE "C", ctid`,
    )
    const name = `${table.table_schema}.${table.table_name}`
    result.set(
      table.table_schema === 'agent_workflow_meta'
        ? `aw_meta_${table.table_name}`
        : table.table_name,
      options.sqlitePhysical
        ? rows.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([column, value]) => [column, physical(name, column, value)]),
            ),
          )
        : rows,
    )
  }
  return result
}
/** Independent implementation of mk1 and length-framed, sorted key hashing. */
export function keyCell(value: unknown): unknown {
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'text', value }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)))
    return { type: 'integer', value: String(value) }
  if (typeof value === 'number' && Number.isFinite(value))
    return { type: 'real', value: String(value) }
  if (value instanceof Uint8Array)
    return { type: 'bytes', value: Buffer.from(value).toString('base64') }
  throw new Error(`Cannot encode source key: ${String(value)}`)
}
export function encodedKey(table: string, cells: readonly unknown[]): string {
  return `mk1:${canonicalSchemaJson([table, cells])}`
}
export function keyDigest(keys: readonly string[]): string {
  const hash = createHash('sha256')
  for (const key of [...keys].sort()) hash.update(`${Buffer.byteLength(key)}:`).update(key)
  return `sha256:${hash.digest('hex')}`
}
export function logicalKeys(table: LogicalTableContract, rows: readonly Row[]): string[] {
  return rows.map((row) =>
    encodedKey(
      table.id,
      table.migrationKey.map((name) => {
        const column = table.columns.find((c) => c.name === name)
        invariant(column, `${table.id}: missing key column ${name}`)
        return encodeLogicalValue(table.id, column, row[name])
      }),
    ),
  )
}
export function logicalValues(table: LogicalTableContract, row: Row) {
  return table.columns.map((column) => encodeLogicalValue(table.id, column, row[column.name]))
}
/** Raw units use the immutable copy's physical rowid, not nullable SERIAL ids. */
export function rawSqliteKeys(db: Database, table: string): string[] {
  const info = columns(db, table)
  const without = db
    .query<{ wr: number }, [string]>('SELECT wr FROM pragma_table_list WHERE name=?')
    .get(table)?.wr
  const names = info.map((c) => c.name)
  const key = without
    ? info
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name)
    : [['_rowid_', 'rowid', 'oid'].find((n) => !names.includes(n))!]
  invariant(key.length && key.every(Boolean), `${table}: no raw key`)
  return db
    .query<Row, []>(
      `SELECT ${key.map((name, i) => `${q(name)} AS k${i}`).join(',')} FROM ${q(table)} ORDER BY ${key.map(q).join(',')}`,
    )
    .all()
    .map((row) =>
      encodedKey(
        table,
        key.map((_, i) => keyCell(row[`k${i}`])),
      ),
    )
}
