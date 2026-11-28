import type { SchemaRegistry } from '../../schema/registry'
import { canonicalValue, encodeMigrationKey } from './migrationKey'
import type { EncodedKey, SourceRow } from './types'

/**
 * RFC-626: the rows every release depends on — the seeds the target schema declares, which is
 * the list target validation checks. Such a row is never set aside, neither while converting
 * nor while the target is finalized: a new database without it cannot work, so the upgrade
 * ends with an error naming the row. Returns the encoded target keys.
 */
export function requiredSeedKeysByTable(
  target: SchemaRegistry,
): ReadonlyMap<string, readonly EncodedKey[]> {
  const keys = new Map<string, EncodedKey[]>()
  for (const contribution of target.contributions)
    for (const seed of contribution.seeds ?? []) {
      const table = target.tables.find((entry) => entry.id === seed.table)
      if (!table) continue
      for (const row of seed.rows) {
        const key = table.primaryKey.map((name) => {
          const column = Object.values(table.columns).find((entry) => entry.name === name)
          const value = Object.hasOwn(row, name)
            ? row[name]
            : column?.default.kind === 'literal'
              ? column.default.value
              : undefined
          return value === undefined || (typeof value === 'object' && value !== null)
            ? undefined
            : value
        })
        // A seed without a literal key cannot be recognised by key; validation reports it.
        if (key.some((value) => value === undefined)) continue
        const encoded = encodeMigrationKey(
          seed.table,
          key.map((value) => canonicalValue(value as string | number | boolean | null)),
        )
        const known = keys.get(seed.table)
        if (!known) keys.set(seed.table, [encoded])
        else if (!known.includes(encoded)) known.push(encoded)
      }
    }
  return keys
}
export function requiredSeedKeys(target: SchemaRegistry): ReadonlySet<string> {
  return new Set([...requiredSeedKeysByTable(target).values()].flat())
}
/** A source row keeps its table name and key when it becomes the seed row of the target. */
export function requiredSeedRows(target: SchemaRegistry): (row: SourceRow) => boolean {
  const keys = requiredSeedKeys(target)
  return (row) => keys.has(row.encodedKey)
}
