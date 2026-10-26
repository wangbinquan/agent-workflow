import type { SchemaRegistry } from '../../schema/registry'
import type { TableDefinition } from '../../schema/contribution'
import { resolveColumnUniqueNulls } from '../../schema/targetDefinition'
import { decodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { canonicalSchemaJson } from '../../schema/canonical'
import { evaluateExpression, isTypedExpression, sqlTruth } from './expressionEvaluator'
import { BLOCK_CODES, ConversionContractError } from './blockCodes'
import { canonicalValue, encodeMigrationKey } from './migrationKey'
import type { EncodedKey, TargetRow, TargetValue } from './types'

export interface TargetRegistryView {
  readonly tables: readonly TableDefinition[]
  table(name: string): TableDefinition
  key(table: string, row: TargetRow): EncodedKey
}
export function targetRegistryView(registry: SchemaRegistry): TargetRegistryView {
  const tables = registry.tables.map((table) => resolveColumnUniqueNulls(registry, table))
  const byId = new Map(tables.map((table) => [table.id, table]))
  const table = (name: string): TableDefinition => {
    const definition = byId.get(name)
    if (!definition) throw new ConversionContractError('v2-unknown-target', name)
    return definition
  }
  return {
    tables,
    table,
    key: (name, row) =>
      encodeMigrationKey(
        name,
        table(name).primaryKey.map((column) => canonicalValue(row[column]!)),
      ),
  }
}
export class TargetRowError extends ConversionContractError {
  constructor(
    code: string,
    readonly table: string,
    readonly column: string | null,
    readonly value: TargetValue | undefined,
    message: string,
  ) {
    super(code, `${table}${column ? `.${column}` : ''}: ${message}`)
  }
}
export function validateTargetRow(target: TargetRegistryView, name: string, row: TargetRow): void {
  const table = target.table(name)
  const columns = Object.values(table.columns)
  const fail = (code: string, column: string | null, message: string): never => {
    throw new TargetRowError(code, name, column, column ? row[column] : undefined, message)
  }
  for (const key of Object.keys(row))
    if (!columns.some((column) => column.name === key))
      fail(BLOCK_CODES.targetColumn, key, 'unknown column')
  for (const column of columns) {
    const value = row[column.name]
    if (!Object.hasOwn(row, column.name) || value === undefined)
      fail(BLOCK_CODES.targetColumn, column.name, 'every column must be explicit')
    if (value === null) {
      if (!column.nullable || table.primaryKey.includes(column.name))
        fail(BLOCK_CODES.targetNull, column.name, 'NULL is not allowed')
    } else {
      let valid: boolean
      switch (column.codec) {
        case 'bool':
          valid = typeof value === 'boolean'
          break
        case 'bigint':
          valid = typeof value === 'bigint' && value >= -(2n ** 63n) && value < 2n ** 63n
          break
        case 'int':
        case 'epochMs':
        case 'durationMs':
        case 'seq':
        case 'identity':
          valid = typeof value === 'number' && Number.isSafeInteger(value)
          break
        case 'real':
          valid = typeof value === 'number' && Number.isFinite(value)
          break
        case 'bytes':
          valid = value instanceof Uint8Array
          break
        case 'enum':
          valid = typeof value === 'string' && !!column.enumValues?.includes(value)
          break
        case 'jsonText':
        case 'jsonDoc':
        case 'rawJson':
          valid = typeof value === 'string'
          if (valid) {
            try {
              JSON.parse(value as string)
            } catch {
              valid = false
            }
          }
          break
        default:
          valid = typeof value === 'string'
      }
      if (!valid) fail(BLOCK_CODES.targetCodec, column.name, `invalid ${column.codec}`)
    }
    if (column.document?.kind === 'content-ref') {
      try {
        decodeContentRefColumns(
          value as string | null,
          row[column.document.inlineBytesColumn] as Uint8Array | null,
        )
      } catch (error) {
        fail(BLOCK_CODES.targetDocument, column.name, String(error))
      }
    }
    if (column.document?.kind === 'requested-source' && value !== null) {
      try {
        JSON.parse(value as string)
      } catch {
        fail(BLOCK_CODES.targetDocument, column.name, 'invalid requested-source JSON')
      }
    }
  }
  for (const check of table.checks)
    if (
      isTypedExpression(check.expression) &&
      sqlTruth(evaluateExpression(check.expression, row)) === false
    )
      fail(BLOCK_CODES.targetCheck, null, check.name)
}
export function createTargetRow(
  target: TargetRegistryView,
  table: string,
  values: TargetRow,
): TargetRow {
  validateTargetRow(target, table, values)
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value instanceof Uint8Array ? Uint8Array.from(value) : value,
      ]),
    ),
  )
}
export function createUnitUniqueChecker(
  target: TargetRegistryView,
): (table: string, row: TargetRow) => void {
  const seen = new Set<string>()
  return (name, row) => {
    const table = target.table(name)
    const keys: { name: string; nulls: 'distinct' | 'not-distinct'; values: TargetValue[] }[] = [
      { name: 'PRIMARY', columns: table.primaryKey, nulls: 'not-distinct' as const },
      ...table.unique,
      ...Object.values(table.columns)
        .filter((column) => column.unique)
        .map((column) => ({
          name: column.unique!,
          columns: [column.name],
          nulls: column.uniqueNulls ?? ('distinct' as const),
        })),
    ].map((key) => ({
      name: key.name,
      nulls: key.nulls,
      values: key.columns.map((column) => row[column]!),
    }))
    for (const index of table.indexes) {
      if (
        !index.unique ||
        !index.columns.every(isTypedExpression) ||
        (index.where && !isTypedExpression(index.where))
      )
        continue
      if (index.where && sqlTruth(evaluateExpression(index.where, row)) !== true) continue
      keys.push({
        name: index.name,
        nulls: index.nulls,
        values: index.columns.map((expression) => evaluateExpression(expression, row)),
      })
    }
    const additions: string[] = []
    for (const key of keys) {
      if (key.nulls === 'distinct' && key.values.includes(null)) continue
      const value = canonicalSchemaJson([
        name,
        key.name,
        key.values.map((value) => canonicalValue(Object.is(value, -0) ? 0 : value)),
      ])
      if (seen.has(value))
        throw new TargetRowError(BLOCK_CODES.targetUnique, name, null, undefined, key.name)
      additions.push(value)
    }
    for (const key of additions) seen.add(key)
  }
}
