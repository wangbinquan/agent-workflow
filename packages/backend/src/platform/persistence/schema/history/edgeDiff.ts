// RFC-395 II-b R2: a closed edge describes exactly one reviewed registry delta.
import { canonicalSchemaJson } from '../canonical'
import type { TableDefinition } from '../contribution'
import {
  SchemaHistoryError,
  type CompiledContract,
  type SchemaEdge,
  type SchemaEdgeKind,
  type HistoryVersion,
} from './types'

export const sameSchemaValue = (a: unknown, b: unknown): boolean =>
  canonicalSchemaJson(a) === canonicalSchemaJson(b)
/** The supplemental engine catalog does not change the contract/plan identity. */
export function sameHistoryVersion(a: HistoryVersion, b: HistoryVersion): boolean {
  return sameSchemaValue([a.contract, a.sqlite, a.postgresql], [b.contract, b.sqlite, b.postgresql])
}
function ambiguous(kind: string): never {
  throw new SchemaHistoryError('ambiguous-diff', `registry delta is not exactly one ${kind} edge`)
}
function content(table: TableDefinition) {
  const { version: _version, ...rest } = table
  return rest
}
function onlyField(
  before: TableDefinition,
  after: TableDefinition,
  field: keyof TableDefinition,
): boolean {
  return sameSchemaValue(
    { ...content(before), [field]: null, ...(field === 'columns' ? { columnOrder: null } : {}) },
    { ...content(after), [field]: null, ...(field === 'columns' ? { columnOrder: null } : {}) },
  )
}
function addition<T>(before: readonly T[], after: readonly T[]): T | null {
  const added = after.filter((item) => !before.some((old) => sameSchemaValue(old, item)))
  return added.length === 1 &&
    after.length === before.length + 1 &&
    before.every((old) => after.some((item) => sameSchemaValue(old, item)))
    ? added[0]!
    : null
}
function seedRows(contract: CompiledContract) {
  return contract.contributions
    .flatMap((entry) => entry.seeds ?? [])
    .sort((a, b) => a.table.localeCompare(b.table))
}
function deriveSeedDelta(
  before: CompiledContract,
  after: CompiledContract,
  explicit?: SchemaEdge,
): SchemaEdge {
  const old = seedRows(before)
  const next = seedRows(after)
  const names = [...new Set([...old, ...next].map((seed) => seed.table))]
  const changed = names.filter(
    (name) =>
      !sameSchemaValue(
        old.filter((s) => s.table === name),
        next.filter((s) => s.table === name),
      ),
  )
  if (changed.length !== 1) return ambiguous('seed-delta')
  const tableId = changed[0]!
  const table = after.tables.find((table) => table.id === tableId)
  if (!table) return ambiguous('seed-delta')
  const beforeRows = old.filter((seed) => seed.table === tableId).flatMap((seed) => seed.rows)
  const afterRows = next.filter((seed) => seed.table === tableId).flatMap((seed) => seed.rows)
  const key = (row: (typeof beforeRows)[number]) =>
    canonicalSchemaJson(table.primaryKey.map((name) => row[name]))
  const delta = {
    kind: 'seed-delta' as const,
    tableId,
    upsert: afterRows.filter(
      (row) => !beforeRows.some((previous) => sameSchemaValue(row, previous)),
    ),
    remove: beforeRows
      .filter((row) => !afterRows.some((next) => key(row) === key(next)))
      .map((row) => Object.fromEntries(table.primaryKey.map((name) => [name, row[name]!]))),
  }
  const resolve = (
    row: (typeof beforeRows)[number],
    actual?: Readonly<Record<string, string | number | boolean | null>>,
  ) =>
    Object.fromEntries(
      Object.entries(row).map(([name, value]) => {
        if (typeof value !== 'object' || value === null) return [name, value]
        if (value.kind !== 'install-time' || !Number.isSafeInteger(actual?.[name]))
          return ambiguous('seed-delta with install-time values; supply a reviewed --edge')
        return [name, actual![name]!]
      }),
    ) as Readonly<Record<string, string | number | boolean | null>>
  const result: SchemaEdge = {
    ...delta,
    upsert: delta.upsert.map((row) =>
      resolve(
        row,
        explicit?.kind === 'seed-delta'
          ? explicit.upsert.find((candidate) => key(candidate) === key(row))
          : undefined,
      ),
    ),
    remove: delta.remove.map((row) => resolve(row)),
  }
  if (explicit && !sameSchemaValue(explicit, result)) return ambiguous('seed-delta')
  return result
}
export function deriveSchemaEdge(
  kind: SchemaEdgeKind,
  before: CompiledContract,
  after: CompiledContract,
  explicit?: SchemaEdge,
): SchemaEdge {
  const old = new Map(before.tables.map((table) => [table.id, table]))
  const next = new Map(after.tables.map((table) => [table.id, table]))
  const added = after.tables.filter((table) => !old.has(table.id))
  const removed = before.tables.filter((table) => !next.has(table.id))
  const changed = after.tables.filter(
    (table) => old.has(table.id) && !sameSchemaValue(content(old.get(table.id)!), content(table)),
  )
  if (before.schemaEpoch !== after.schemaEpoch || before.contractVersion !== after.contractVersion)
    return ambiguous(kind)
  if (kind !== 'seed-delta' && !sameSchemaValue(seedRows(before), seedRows(after)))
    return ambiguous(kind)
  if (kind === 'data-transform') {
    if (
      before.digest !== after.digest ||
      explicit?.kind !== kind ||
      !explicit.idempotent ||
      !explicit.review.trim() ||
      !explicit.receiptId ||
      !explicit.sqlite.length ||
      !explicit.postgresql.length
    )
      return ambiguous(kind)
    return explicit
  }
  if (kind === 'seed-delta') {
    if (added.length || removed.length || changed.length) return ambiguous(kind)
    const edge = deriveSeedDelta(before, after, explicit)
    if (
      edge.kind !== kind ||
      !next.has(edge.tableId) ||
      (!edge.upsert.length && !edge.remove.length)
    )
      return ambiguous(kind)
    return edge
  }
  if (kind === 'add-table' && added.length === 1 && !removed.length && !changed.length)
    return { kind, tableId: added[0]!.id }
  if (kind === 'retire-table' && removed.length === 1 && !added.length && !changed.length)
    return { kind, tableId: removed[0]!.id }
  if (added.length || removed.length || changed.length !== 1) return ambiguous(kind)
  const table = changed[0]!
  const previous = old.get(table.id)!
  const tableId = table.id
  switch (kind) {
    case 'add-column': {
      if (!onlyField(previous, table, 'columns')) return ambiguous(kind)
      const c = addition(Object.values(previous.columns), Object.values(table.columns))
      if (
        !c ||
        c.primary ||
        c.unique ||
        (!c.nullable && c.default.kind !== 'literal' && c.default.kind !== 'expression') ||
        (!c.nullable && c.default.kind === 'literal' && c.default.value === null)
      )
        return ambiguous(kind)
      if (
        !sameSchemaValue(
          'columnOrder' in table
            ? table.columnOrder
            : Object.values(table.columns).map((column) => column.name),
          [
            ...('columnOrder' in previous
              ? (previous.columnOrder as readonly string[])
              : Object.values(previous.columns).map((column) => column.name)),
            c.name,
          ],
        )
      )
        return ambiguous(kind)
      return { kind, tableId, column: c.name }
    }
    case 'add-index': {
      const index =
        onlyField(previous, table, 'indexes') && addition(previous.indexes, table.indexes)
      return index ? { kind, tableId, name: index.name } : ambiguous(kind)
    }
    case 'add-fk': {
      const fk =
        onlyField(previous, table, 'foreignKeys') &&
        addition(previous.foreignKeys, table.foreignKeys)
      return fk ? { kind, tableId, name: fk.name } : ambiguous(kind)
    }
    case 'replace-check': {
      if (!onlyField(previous, table, 'checks') || previous.checks.length !== table.checks.length)
        return ambiguous(kind)
      const different = table.checks.filter(
        (check) => !previous.checks.some((oldCheck) => sameSchemaValue(check, oldCheck)),
      )
      if (
        different.length !== 1 ||
        !previous.checks.some((check) => check.name === different[0]!.name)
      )
        return ambiguous(kind)
      return { kind, tableId, name: different[0]!.name }
    }
    case 'rebuild-table':
      return explicit?.kind === kind && explicit.tableId === tableId ? explicit : { kind, tableId }
    case 'owner-metadata': {
      const physical = (value: TableDefinition) => ({
        ...content(value),
        owner: null,
        retention: null,
        migrationPolicy: null,
        foreignKeys: value.foreignKeys.map(({ lifecycle: _lifecycle, ...fk }) => fk),
      })
      return sameSchemaValue(physical(previous), physical(table))
        ? { kind, tableId }
        : ambiguous(kind)
    }
    default:
      return ambiguous(kind)
  }
}

/** Old writes remain legal: new constraints/unique indexes are not expand-only. */
export function isExpandOnlyEdge(edge: SchemaEdge, contract: CompiledContract): boolean {
  if (edge.kind === 'add-table' || edge.kind === 'add-column' || edge.kind === 'owner-metadata')
    return true
  if (edge.kind === 'add-index')
    return (
      contract.tables.find((t) => t.id === edge.tableId)?.indexes.find((i) => i.name === edge.name)
        ?.unique === false
    )
  return false
}
