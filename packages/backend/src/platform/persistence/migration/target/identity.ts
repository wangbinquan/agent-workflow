import { persistenceDialect } from '../../nativeDialect'
import type { SchemaRegistry } from '../../schema/registry'
import { quoteSchemaIdentifier as quote } from '../../schema/expressions'
import { parameters, type HistoryConnection } from '../../schema/history/connection'
import type { MigrationRecord } from '../conversion/types'
import type { FoldedIdentityHighWater } from '../run/types'
import { targetTableName } from './loader'

export function foldIdentityHighWater(
  records: Iterable<MigrationRecord>,
): readonly FoldedIdentityHighWater[] {
  const folded = new Map<string, FoldedIdentityHighWater>()
  for (const record of records) {
    if (record.kind !== 'identity-high-water') continue
    if (!/^\d+$/.test(record.value)) throw new Error('v3-identity-invalid-high-water')
    const key = JSON.stringify([record.table, record.column])
    const previous = folded.get(key)
    folded.set(key, {
      table: record.table,
      column: record.column,
      value: String(
        previous && BigInt(previous.value) > BigInt(record.value)
          ? BigInt(previous.value)
          : BigInt(record.value),
      ),
      basis: previous && previous.basis !== record.basis ? 'both' : record.basis,
      warnings: [
        ...new Set([...(previous?.warnings ?? []), ...(record.warning ? [record.warning] : [])]),
      ].sort(),
    })
  }
  return [...folded.values()].sort((a, b) =>
    JSON.stringify([a.table, a.column]).localeCompare(JSON.stringify([b.table, b.column])),
  )
}
export async function targetIdentityHighWater(
  tx: HistoryConnection,
  input: { registry: SchemaRegistry; values: readonly FoldedIdentityHighWater[] },
): Promise<readonly FoldedIdentityHighWater[]> {
  const records: MigrationRecord[] = input.values.flatMap((entry) => [
    { kind: 'identity-high-water' as const, ...entry },
    ...entry.warnings.map((warning) => ({
      kind: 'identity-high-water' as const,
      ...entry,
      warning,
    })),
  ])
  for (const table of input.registry.tables)
    for (const column of Object.values(table.columns)) {
      if (column.codec !== 'identity') continue
      const rows = await tx.execute(
        `SELECT CAST(COALESCE(MAX(${quote(column.name)}), 0) AS TEXT) AS maximum FROM ${targetTableName(tx.provider, table.id)}`,
      )
      records.push({
        kind: 'identity-high-water',
        table: table.id,
        column: column.name,
        value: String(rows[0]!.maximum),
        basis: 'max-row',
      })
    }
  return foldIdentityHighWater(records)
}
async function identitySequence(
  tx: HistoryConnection,
  table: string,
  column: string,
): Promise<string> {
  const slots = parameters(tx, 2)
  const rows = await tx.execute(`SELECT pg_get_serial_sequence(${slots}) AS name`, [
    `agent_workflow.${quote(table)}`,
    column,
  ])
  if (!rows[0]?.name) throw new Error(`v3-identity-sequence-missing: ${table}.${column}`)
  return String(rows[0].name)
}
export async function applyIdentityHighWater(
  tx: HistoryConnection,
  input: { registry: SchemaRegistry; values: readonly FoldedIdentityHighWater[] },
): Promise<void> {
  for (const entry of input.values) {
    const column = Object.values(
      input.registry.tables.find((table) => table.id === entry.table)?.columns ?? {},
    ).find((column) => column.name === entry.column)
    if (column?.codec !== 'identity')
      throw new Error(`v3-identity-column: ${entry.table}.${entry.column}`)
    const value = BigInt(entry.value)
    if (persistenceDialect(tx.provider).identityStorage === 'sequence-table') {
      await tx.execute('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [value, entry.table])
      await tx.execute(
        'INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)',
        [entry.table, value, entry.table],
      )
    } else {
      const sequence = await identitySequence(tx, entry.table, entry.column)
      await tx.execute('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [
        sequence,
        String(value === 0n ? 1n : value),
        value !== 0n,
      ])
    }
  }
}
export async function verifyIdentityHighWater(
  tx: HistoryConnection,
  values: readonly FoldedIdentityHighWater[],
): Promise<boolean> {
  for (const entry of values) {
    if (persistenceDialect(tx.provider).identityStorage === 'sequence-table') {
      const rows = await tx.execute(
        'SELECT CAST(seq AS TEXT) AS value FROM sqlite_sequence WHERE name = ?',
        [entry.table],
      )
      if (!rows.length || BigInt(String(rows[0]!.value)) !== BigInt(entry.value)) return false
    } else {
      const sequence = await identitySequence(tx, entry.table, entry.column)
      const rows = await tx.execute(`SELECT last_value::text AS value, is_called FROM ${sequence}`)
      const zero = BigInt(entry.value) === 0n
      if (
        BigInt(String(rows[0]?.value)) !== (zero ? 1n : BigInt(entry.value)) ||
        Boolean(rows[0]?.is_called) === zero
      )
        return false
    }
  }
  return true
}
