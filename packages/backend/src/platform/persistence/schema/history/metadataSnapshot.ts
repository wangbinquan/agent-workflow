import { persistenceDialect } from '../../nativeDialect'
import { z } from 'zod'
import { digestSchemaContract, canonicalSchemaJson } from '../canonical'
import { schemaHistoryRuntime } from './runtime'
import { metaTableName } from './meta'
import { parameters, type HistoryConnection } from './connection'
import type { ColumnDefinition } from '../contribution'
import type { MetaTableDeclaration } from './meta'

const bytes = z.strictObject({ type: z.literal('bytes'), base64: z.string() })
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), bytes, z.null()])
type Cell = z.infer<typeof scalar>
const integerCodecs = new Set(['int', 'bigint', 'epochMs', 'durationMs', 'seq', 'identity'])
function encodeCell(column: ColumnDefinition, value: unknown): Cell {
  if (value === null) return null
  if (column.codec === 'bytes') {
    if (!(value instanceof Uint8Array)) throw new Error(`epoch2-metadata-bytes:${column.name}`)
    return { type: 'bytes', base64: Buffer.from(value).toString('base64') }
  }
  if (column.codec === 'bool') {
    if (![true, false, 0, 1, 0n, 1n].includes(value as boolean | number | bigint))
      throw new Error(`epoch2-metadata-bool:${column.name}`)
    return value === true || value === 1 || value === 1n
  }
  if (integerCodecs.has(column.codec)) {
    if (
      !['string', 'number', 'bigint'].includes(typeof value) ||
      !/^-?\d+$/.test(String(value)) ||
      (typeof value === 'number' && !Number.isSafeInteger(value))
    )
      throw new Error(`epoch2-metadata-integer:${column.name}`)
    const integer = BigInt(String(value))
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(integer)
      : integer.toString()
  }
  if (column.codec === 'real') return z.number().finite().parse(Number(value))
  return scalar.parse(value)
}
function decodeCell(
  connection: HistoryConnection,
  column: ColumnDefinition,
  value: Cell | undefined,
): unknown {
  if (value === null) return null
  if (column.codec === 'bytes') {
    const cell = bytes.parse(value)
    const decoded = Buffer.from(cell.base64, 'base64')
    if (decoded.toString('base64') !== cell.base64)
      throw new Error(`epoch2-metadata-bytes:${column.name}`)
    return decoded
  }
  if (column.codec === 'bool')
    return persistenceDialect(connection.provider).boolean(z.boolean().parse(value))
  return value
}
function encodeRow(
  table: MetaTableDeclaration,
  row: Record<string, unknown>,
): Record<string, Cell> {
  return Object.fromEntries(
    Object.values(table.columns).map((column) => [
      column.name,
      encodeCell(column, row[column.name]),
    ]),
  )
}
export const EpochMetadataSnapshotSchema = z.strictObject({
  payload: z.strictObject({
    version: z.literal(1),
    tables: z.array(
      z.strictObject({
        name: z.string(),
        rows: z.array(z.record(z.string(), scalar)),
      }),
    ),
  }),
  digest: z.string(),
})
export type EpochMetadataSnapshot = z.infer<typeof EpochMetadataSnapshotSchema>
// Native schema history is installed from this binary. Business lineage, archived
// rows and restrictions retain their exact original run bindings across a copy.
const omitted = new Set(['schema_history', 'first_write', 'schema_transform_receipts'])
const declarations = () =>
  schemaHistoryRuntime().metaTables.filter((table) => !omitted.has(table.name))
export function verifyEpochMetadataSnapshot(value: unknown): EpochMetadataSnapshot {
  const snapshot = EpochMetadataSnapshotSchema.parse(value)
  if (snapshot.digest !== digestSchemaContract(snapshot.payload))
    throw new Error('epoch2-metadata-digest-mismatch')
  const expected = declarations()
    .map((table) => table.name)
    .sort()
  if (
    canonicalSchemaJson(snapshot.payload.tables.map((table) => table.name).sort()) !==
    canonicalSchemaJson(expected)
  )
    throw new Error('epoch2-metadata-table-roster-mismatch')
  for (const table of declarations()) {
    const columns = Object.values(table.columns)
      .map((column) => column.name)
      .sort()
    for (const row of snapshot.payload.tables.find((item) => item.name === table.name)!.rows)
      if (canonicalSchemaJson(Object.keys(row).sort()) !== canonicalSchemaJson(columns))
        throw new Error('epoch2-metadata-column-roster-mismatch')
  }
  return snapshot
}
export async function captureEpochMetadata(
  connection: HistoryConnection,
): Promise<EpochMetadataSnapshot> {
  const tables = []
  for (const table of declarations()) {
    const columns = Object.values(table.columns).map((column) => column.name)
    const rows = await connection.execute(
      `SELECT ${columns.map(quote).join(',')} FROM ${metaTableName(connection.provider, table.name)} ORDER BY ${table.primaryKey.map(quote).join(',')}`,
    )
    tables.push({
      name: table.name,
      rows: rows.map((row) => encodeRow(table, row)),
    })
  }
  const payload = { version: 1 as const, tables }
  return verifyEpochMetadataSnapshot({ payload, digest: digestSchemaContract(payload) })
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
export async function restoreEpochMetadata(
  connection: HistoryConnection,
  value: EpochMetadataSnapshot,
): Promise<void> {
  const snapshot = verifyEpochMetadataSnapshot(value)
  for (const table of declarations()) {
    const columns = Object.values(table.columns).map((column) => column.name)
    for (const source of snapshot.payload.tables.find((item) => item.name === table.name)!.rows) {
      // Preserve prior generation facts as lineage; only the new copy is active.
      const normalizedSource = Object.fromEntries(
        Object.values(table.columns).map((column) => [
          column.name,
          integerCodecs.has(column.codec) || column.codec === 'real'
            ? encodeCell(column, source[column.name])
            : source[column.name],
        ]),
      )
      const row =
        table.name === 'generations' && source.state === 'active'
          ? { ...normalizedSource, state: 'retired' }
          : normalizedSource
      const name = metaTableName(connection.provider, table.name)
      await connection.execute(
        `INSERT INTO ${name} (${columns.map(quote).join(',')}) VALUES (${parameters(connection, columns.length)}) ON CONFLICT (${table.primaryKey.map(quote).join(',')}) DO NOTHING`,
        Object.values(table.columns).map((column) =>
          decodeCell(connection, column, row[column.name]),
        ),
      )
      const marks = parameters(connection, table.primaryKey.length).split(', ')
      const existing = await connection.execute(
        `SELECT ${columns.map(quote).join(',')} FROM ${name} WHERE ${table.primaryKey.map((column, i) => `${quote(column)} = ${marks[i]}`).join(' AND ')}`,
        table.primaryKey.map((column) => row[column]),
      )
      const normalized = existing.map((item) => encodeRow(table, item))
      if (
        normalized.length !== 1 ||
        canonicalSchemaJson(normalized[0]) !== canonicalSchemaJson(row)
      )
        throw new Error(`epoch2-metadata-copy-conflict:${table.name}`)
    }
  }
}
